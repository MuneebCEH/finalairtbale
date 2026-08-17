<?php

namespace App\Http\Controllers;

use App\Exceptions\ApiException;
use App\Models\Field;
use App\Models\Record;
use App\Models\Table;
use App\Support\FieldTypes;
use App\Support\Permissions;
use App\Support\RecordLinks;
use App\Support\RecordQueryEngine;
use App\Support\TenantContext;
use Illuminate\Http\Request;
use Illuminate\Support\Carbon;
use Illuminate\Support\Facades\DB;

/**
 * Records — the hybrid-storage rows. Values are held in the `data` JSON keyed by field id. The
 * filter/sort/group query engine (POST .../records/query) and slot promotion are the remaining
 * Phase 4 work; this covers list + full CRUD with optimistic concurrency.
 */
class RecordController extends Controller
{
    public function list(Request $request, string $tableId)
    {
        $this->tenant($request, 'record:read');

        $limit = min(max((int) $request->query('limit', 50), 1), 100);
        $cursor = $request->query('cursor');

        $query = Record::where('table_id', $tableId)->whereNull('deleted_at')
            ->orderBy('created_at')->orderBy('id');
        if (is_string($cursor) && $cursor !== '') {
            $query->where('id', '>', $cursor);
        }

        $rows = $query->limit($limit + 1)->get();
        $hasMore = $rows->count() > $limit;
        $rows = $rows->take($limit);

        $lf = RecordLinks::linkFields($tableId);
        $labels = RecordLinks::labelMap($lf, $rows);

        return response()->json([
            'data' => $rows->map(fn (Record $r) => $this->dto($r, null, $lf, $labels))->values()->all(),
            'meta' => [
                'hasMore' => $hasMore,
                'nextCursor' => $hasMore ? $rows->last()->id : null,
            ],
        ]);
    }

    public function show(Request $request, string $tableId, string $recordId)
    {
        $this->tenant($request, 'record:read');
        $record = $this->find($tableId, $recordId);

        return response()->json(['data' => $this->single($record, $tableId)]);
    }

    /**
     * GET /v1/tables/{tableId}/record-links — options for a linked-record picker: each record of
     * the target table as {id, label}, where the label is its primary-field value. `search`
     * filters by that title.
     */
    public function linkOptions(Request $request, string $tableId)
    {
        $this->tenant($request, 'record:read');
        $table = \App\Models\Table::whereKey($tableId)->whereNull('deleted_at')->first()
            ?? throw ApiException::notFound('Table not found.');
        $pf = $table->primary_field_id;

        $search = trim((string) $request->query('search', ''));
        $limit = min(max((int) $request->query('limit', 25), 1), 50);

        $q = Record::where('table_id', $tableId)->whereNull('deleted_at');
        if ($pf && $search !== '') {
            $q->whereRaw("LOWER(JSON_UNQUOTE(JSON_EXTRACT(data, '\$.\"{$pf}\"'))) LIKE ?", ['%'.mb_strtolower($search).'%']);
        }

        $data = $q->orderBy('created_at')->limit($limit)->get(['id', 'data'])
            ->map(function (Record $r) use ($pf) {
                $title = $pf ? ((array) $r->data)[$pf] ?? null : null;

                return ['id' => $r->id, 'label' => is_string($title) && $title !== '' ? $title : 'Untitled'];
            })->all();

        return response()->json(['data' => $data]);
    }

    /** POST /v1/tables/{tableId}/records/query — filter / sort / group / search over the data JSON. */
    public function query(Request $request, string $tableId)
    {
        $this->tenant($request, 'record:read');
        $this->strict($request, ['filter', 'sort', 'group', 'fieldIds', 'search', 'limit', 'cursor']);
        $input = $request->validate([
            'filter' => ['sometimes', 'array'],
            'sort' => ['sometimes', 'array', 'max:5'],
            'group' => ['sometimes', 'array', 'max:3'],
            'fieldIds' => ['sometimes', 'array', 'max:500'],
            'search' => ['sometimes', 'string', 'max:500'],
            'limit' => ['sometimes', 'integer', 'min:1', 'max:1000'],
            'cursor' => ['sometimes', 'string', 'max:2048'],
        ]);

        $limit = (int) ($input['limit'] ?? 100);
        $offset = $this->decodeCursor($input['cursor'] ?? null);
        $fieldTypes = $this->allFields($tableId);

        $query = Record::where('table_id', $tableId)->whereNull('deleted_at');
        (new RecordQueryEngine($fieldTypes))->apply($query, $input);

        $rows = $query->offset($offset)->limit($limit + 1)->get();
        $hasMore = $rows->count() > $limit;
        $rows = $rows->take($limit);

        $project = ! empty($input['fieldIds']) ? array_flip($input['fieldIds']) : null;
        $lf = RecordLinks::linkFields($tableId);
        $labels = RecordLinks::labelMap($lf, $rows);

        return response()->json([
            'data' => $rows->map(fn (Record $r) => $this->dto($r, $project, $lf, $labels))->values()->all(),
            'meta' => [
                'hasMore' => $hasMore,
                'nextCursor' => $hasMore ? $this->encodeCursor($offset + $limit) : null,
            ],
        ]);
    }

    /**
     * Accepts both creation shapes the app has ever used: the batch `{records: [{fields}, …]}`
     * the web grid sends (the NestJS contract), and the single `{fields}` shape. An empty
     * `fields` object is a valid blank row — that is exactly what the grid's "Add record" sends.
     */
    public function create(Request $request, string $tableId)
    {
        $tenant = $this->tenant($request, 'record:create');
        $this->strict($request, ['fields', 'records']);
        $request->validate([
            'records' => ['sometimes', 'array', 'min:1', 'max:100'],
            'records.*.fields' => ['sometimes', 'array'],
            'fields' => ['sometimes', 'array'],
        ]);

        /** @var Table $table */
        $table = $request->attributes->get('resolved_table');
        $writable = $this->writableFields($tableId);

        $isBatch = $request->has('records');
        $batch = $isBatch
            ? array_map(fn ($row) => (array) ($row['fields'] ?? []), (array) $request->input('records'))
            : [(array) $request->input('fields', [])];

        $created = DB::transaction(function () use ($table, $tenant, $batch, $writable) {
            $locked = Table::whereKey($table->id)->lockForUpdate()->first();
            $seq = (int) $locked->auto_number_seq;
            $now = Carbon::now();

            $out = [];
            foreach ($batch as $fields) {
                $out[] = Record::create([
                    'organization_id' => $tenant->organizationId,
                    'table_id' => $table->id,
                    'data' => $this->sanitize($fields, $writable),
                    'version' => 1,
                    'auto_number' => ++$seq,
                    'created_by' => $tenant->userId(),
                    'updated_by' => $tenant->userId(),
                    'created_at' => $now,
                    'updated_at' => $now,
                ]);
            }

            $locked->forceFill([
                'auto_number_seq' => $seq,
                'record_count' => ((int) $locked->record_count) + count($out),
            ])->save();

            return $out;
        });

        // Automations fire after the write is committed; a failing automation never fails the
        // user's write. Capped at a few records so a bulk import cannot fan out a storm.
        // The history gets a 'created' entry under the same cap — bulk imports state their own
        // origin and need no per-row timeline.
        if (count($created) <= 5) {
            $now = Carbon::now();
            foreach ($created as $r) {
                \App\Models\RecordRevision::create([
                    'organization_id' => $tenant->organizationId,
                    'table_id' => $r->table_id,
                    'record_id' => $r->id,
                    'user_id' => $tenant->userId(),
                    'kind' => 'created',
                    'changes' => null,
                    'created_at' => $now,
                ]);
                \App\Support\AutomationRunner::fire('created', $r);
            }
        }

        if ($isBatch) {
            return response()->json(['data' => [
                'records' => array_map(fn (Record $r) => $this->single($r, $tableId), $created),
            ]], 201);
        }

        return response()->json(['data' => $this->single($created[0], $tableId)], 201);
    }

    public function update(Request $request, string $tableId, string $recordId)
    {
        $tenant = $this->tenant($request, 'record:update');
        $this->strict($request, ['fields', 'version']);
        $request->validate([
            'fields' => ['required', 'array'],
            'version' => ['sometimes', 'integer', 'min:1'],
        ]);

        $record = $this->find($tableId, $recordId);

        // Optimistic concurrency: only enforced when the client sends a version.
        if ($request->filled('version') && (int) $request->input('version') !== (int) $record->version) {
            throw new ApiException('RECORD_VERSION_CONFLICT', 'This record was changed by someone else.', [
                'currentVersion' => (int) $record->version,
            ]);
        }

        $fields = $this->writableFields($tableId);
        $incoming = $this->sanitize($request->input('fields', []), $fields);

        // History first, while the old values are still in hand: only the fields whose value
        // actually changed make it into the diff, so the timeline never logs a non-edit.
        $before = (array) $record->data;
        $diff = [];
        foreach ($incoming as $fieldId => $value) {
            if (($before[$fieldId] ?? null) !== $value) {
                $diff[$fieldId] = ['from' => $before[$fieldId] ?? null, 'to' => $value];
            }
        }

        // Merge: the update only touches the keys actually sent (per-field last-write-wins).
        $record->forceFill([
            'data' => array_merge((array) $record->data, $incoming),
            'version' => (int) $record->version + 1,
            'updated_by' => $tenant->userId(),
            'updated_at' => Carbon::now(),
        ])->save();

        if ($diff !== []) {
            \App\Models\RecordRevision::create([
                'organization_id' => $tenant->organizationId,
                'table_id' => $record->table_id,
                'record_id' => $record->id,
                'user_id' => $tenant->userId(),
                'kind' => 'updated',
                'changes' => $diff,
                'created_at' => Carbon::now(),
            ]);
        }

        \App\Support\AutomationRunner::fire('updated', $record);

        return response()->json(['data' => $this->single($record, $tableId)]);
    }

    public function bulkDelete(Request $request, string $tableId)
    {
        $this->tenant($request, 'record:delete');
        $this->strict($request, ['recordIds']);
        $request->validate([
            'recordIds' => ['required', 'array', 'min:1', 'max:100'],
            'recordIds.*' => ['string'],
        ]);

        $ids = $request->input('recordIds');
        $deleted = Record::where('table_id', $tableId)->whereIn('id', $ids)->whereNull('deleted_at')
            ->update(['deleted_at' => Carbon::now()]);

        if ($deleted > 0) {
            Table::whereKey($tableId)->update(['record_count' => DB::raw("GREATEST(record_count - {$deleted}, 0)")]);
        }

        return response()->json(['data' => ['deleted' => $deleted]]);
    }

    // ── Helpers ──────────────────────────────────────────────────────────────

    private function tenant(Request $request, string $action): TenantContext
    {
        /** @var TenantContext $tenant */
        $tenant = $request->attributes->get('tenant');
        Permissions::authorize($tenant, $action);

        return $tenant;
    }

    /** dto for a single record with its linked fields expanded to {id,label}. */
    private function single(Record $r, string $tableId): array
    {
        $lf = RecordLinks::linkFields($tableId);
        $labels = RecordLinks::labelMap($lf, [$r]);

        return $this->dto($r, null, $lf, $labels);
    }

    private function find(string $tableId, string $recordId): Record
    {
        return Record::where('table_id', $tableId)->whereKey($recordId)->whereNull('deleted_at')->first()
            ?? throw ApiException::notFound('Record not found.');
    }

    /** id => type, for non-computed fields only (writable through the records API). */
    private function writableFields(string $tableId): array
    {
        return Field::where('table_id', $tableId)->whereNull('deleted_at')
            ->whereNotIn('type', FieldTypes::COMPUTED)
            ->pluck('type', 'id')->all();
    }

    /** id => type, for every field (any field is a valid filter/sort target). */
    private function allFields(string $tableId): array
    {
        return Field::where('table_id', $tableId)->whereNull('deleted_at')->pluck('type', 'id')->all();
    }

    private function decodeCursor(?string $cursor): int
    {
        if (! is_string($cursor) || $cursor === '') {
            return 0;
        }
        $decoded = base64_decode($cursor, true);

        return $decoded !== false && ctype_digit($decoded) ? (int) $decoded : 0;
    }

    private function encodeCursor(int $offset): string
    {
        return base64_encode((string) $offset);
    }

    /** Rejects unknown or computed field ids; values themselves are stored as given. */
    private function sanitize(array $fields, array $writable): array
    {
        $issues = [];
        foreach (array_keys($fields) as $fieldId) {
            if (! array_key_exists($fieldId, $writable)) {
                $issues[] = ['path' => "fields.{$fieldId}", 'code' => 'unknown_field', 'message' => 'unknown or non-writable field'];
            }
        }
        if (! empty($issues)) {
            throw ApiException::validation($issues);
        }

        // Linked-record cells are stored as bare id arrays, whatever shape the client sent.
        foreach ($fields as $fieldId => $value) {
            if (in_array($writable[$fieldId] ?? '', ['linkedRecord', 'parentRecord'], true)) {
                $fields[$fieldId] = RecordLinks::normalize($value);
            }
        }

        return $fields;
    }

    private function dto(Record $r, ?array $project = null, array $linkFields = [], array $labels = []): array
    {
        $fields = (array) ($r->data ?? []);
        if (! empty($linkFields)) {
            $fields = RecordLinks::expand($fields, $linkFields, $labels);
        }
        if ($project !== null) {
            $fields = array_intersect_key($fields, $project);
        }

        return [
            'id' => $r->id,
            'version' => (int) $r->version,
            'autoNumber' => (int) $r->auto_number,
            'createdAt' => $r->created_at?->copy()->utc()->format('Y-m-d\TH:i:s.v\Z'),
            'updatedAt' => $r->updated_at?->copy()->utc()->format('Y-m-d\TH:i:s.v\Z'),
            'createdBy' => $r->created_by,
            'updatedBy' => $r->updated_by,
            'fields' => empty($fields) ? (object) [] : $fields,
        ];
    }

    private function strict(Request $request, array $allowed): void
    {
        $unknown = array_diff(array_keys($request->all()), $allowed);
        if (! empty($unknown)) {
            throw ApiException::validation(array_map(
                fn ($key) => ['path' => $key, 'code' => 'unrecognized_keys', 'message' => 'unexpected property'],
                array_values($unknown),
            ));
        }
    }
}

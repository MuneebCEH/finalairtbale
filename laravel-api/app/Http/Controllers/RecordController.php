<?php

namespace App\Http\Controllers;

use App\Exceptions\ApiException;
use App\Models\Field;
use App\Models\Record;
use App\Models\Table;
use App\Support\FieldTypes;
use App\Support\Permissions;
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

        return response()->json([
            'data' => $rows->map(fn (Record $r) => $this->dto($r))->values()->all(),
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

        return response()->json(['data' => $this->dto($record)]);
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

        return response()->json([
            'data' => $rows->map(fn (Record $r) => $this->dto($r, $project))->values()->all(),
            'meta' => [
                'hasMore' => $hasMore,
                'nextCursor' => $hasMore ? $this->encodeCursor($offset + $limit) : null,
            ],
        ]);
    }

    public function create(Request $request, string $tableId)
    {
        $tenant = $this->tenant($request, 'record:create');
        $this->strict($request, ['fields']);
        $request->validate(['fields' => ['required', 'array']]);

        /** @var Table $table */
        $table = $request->attributes->get('resolved_table');
        $fields = $this->writableFields($tableId);
        $data = $this->sanitize($request->input('fields', []), $fields);

        $record = DB::transaction(function () use ($table, $tenant, $data) {
            $locked = Table::whereKey($table->id)->lockForUpdate()->first();
            $seq = ((int) $locked->auto_number_seq) + 1;
            $locked->forceFill([
                'auto_number_seq' => $seq,
                'record_count' => ((int) $locked->record_count) + 1,
            ])->save();

            $now = Carbon::now();

            return Record::create([
                'organization_id' => $tenant->organizationId,
                'table_id' => $table->id,
                'data' => $data,
                'version' => 1,
                'auto_number' => $seq,
                'created_by' => $tenant->userId(),
                'updated_by' => $tenant->userId(),
                'created_at' => $now,
                'updated_at' => $now,
            ]);
        });

        return response()->json(['data' => $this->dto($record)], 201);
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

        // Merge: the update only touches the keys actually sent (per-field last-write-wins).
        $record->forceFill([
            'data' => array_merge((array) $record->data, $incoming),
            'version' => (int) $record->version + 1,
            'updated_by' => $tenant->userId(),
            'updated_at' => Carbon::now(),
        ])->save();

        return response()->json(['data' => $this->dto($record)]);
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

        return $fields;
    }

    private function dto(Record $r, ?array $project = null): array
    {
        $fields = (array) ($r->data ?? []);
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

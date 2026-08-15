<?php

namespace App\Http\Controllers;

use App\Exceptions\ApiException;
use App\Models\Base;
use App\Models\Field;
use App\Models\Record;
use App\Models\Table;
use App\Support\Permissions;
use App\Support\TenantContext;
use Illuminate\Http\Request;

/**
 * Bases and tables. Tenant resolution (and isolation) is handled by the `tenant` middleware from
 * the workspace/base/table id in the path.
 */
class BaseController extends Controller
{
    // ── Bases ────────────────────────────────────────────────────────────────

    public function listBases(Request $request, string $workspaceId)
    {
        $tenant = $this->tenant($request, 'base:read');

        $bases = Base::where('workspace_id', $workspaceId)->whereNull('deleted_at')
            ->orderBy('position')->orderBy('created_at')->get()
            ->map(fn (Base $b) => $this->baseDto($b))->all();

        return response()->json(['data' => $bases]);
    }

    public function createBase(Request $request, string $workspaceId)
    {
        $tenant = $this->tenant($request, 'base:create');
        $this->strict($request, ['name', 'description', 'icon', 'color', 'templateId']);
        $data = $request->validate([
            'name' => ['required', 'string', 'min:1', 'max:120'],
            'description' => ['sometimes', 'nullable', 'string', 'max:2000'],
            'icon' => ['sometimes', 'nullable', 'string', 'max:64'],
            'color' => ['sometimes', 'nullable', 'string', 'regex:/^#[0-9A-Fa-f]{6}$/'],
        ]);

        $base = Base::create([
            'organization_id' => $tenant->organizationId,
            'workspace_id' => $workspaceId,
            'name' => $data['name'],
            'description' => $data['description'] ?? null,
            'icon' => $data['icon'] ?? null,
            'color' => $data['color'] ?? null,
            'created_by_id' => $tenant->userId(),
        ]);

        return response()->json(['data' => $this->baseDto($base)], 201);
    }

    public function showBase(Request $request, string $baseId)
    {
        $this->tenant($request, 'base:read');

        return response()->json(['data' => $this->baseDto($this->base($request))]);
    }

    public function updateBase(Request $request, string $baseId)
    {
        $this->tenant($request, 'base:update');
        $this->strict($request, ['name', 'description', 'icon', 'color', 'position']);
        $data = $request->validate([
            'name' => ['sometimes', 'string', 'min:1', 'max:120'],
            'description' => ['sometimes', 'nullable', 'string', 'max:2000'],
            'icon' => ['sometimes', 'nullable', 'string', 'max:64'],
            'color' => ['sometimes', 'nullable', 'string', 'regex:/^#[0-9A-Fa-f]{6}$/'],
            'position' => ['sometimes', 'integer', 'min:0'],
        ]);

        $base = $this->base($request);
        $base->fill($data)->save();

        return response()->json(['data' => $this->baseDto($base)]);
    }

    public function deleteBase(Request $request, string $baseId)
    {
        $this->tenant($request, 'base:delete');
        $this->base($request)->delete();

        return response()->noContent();
    }

    // ── Tables ───────────────────────────────────────────────────────────────

    public function listTables(Request $request, string $baseId)
    {
        $this->tenant($request, 'table:read');

        $tables = Table::where('base_id', $baseId)->whereNull('deleted_at')
            ->orderBy('position')->orderBy('created_at')->get()
            ->map(fn (Table $t) => $this->tableDto($t))->all();

        return response()->json(['data' => $tables]);
    }

    public function createTable(Request $request, string $baseId)
    {
        $tenant = $this->tenant($request, 'table:create');
        $this->strict($request, ['name', 'description', 'icon', 'color', 'fields']);
        $data = $request->validate([
            'name' => ['required', 'string', 'min:1', 'max:120'],
            'description' => ['sometimes', 'nullable', 'string', 'max:2000'],
            'icon' => ['sometimes', 'nullable', 'string', 'max:64'],
            'color' => ['sometimes', 'nullable', 'string', 'regex:/^#[0-9A-Fa-f]{6}$/'],
        ]);

        if (Table::where('base_id', $baseId)->where('name', $data['name'])->exists()) {
            throw new ApiException('DUPLICATE_RESOURCE', 'A table with that name already exists in this base.');
        }

        $table = Table::create([
            'organization_id' => $tenant->organizationId,
            'base_id' => $baseId,
            'name' => $data['name'],
            'description' => $data['description'] ?? null,
            'icon' => $data['icon'] ?? null,
            'color' => $data['color'] ?? null,
            'created_by_id' => $tenant->userId(),
        ]);

        // A table with no fields is useless: seed a primary single-line text field.
        $primary = Field::create([
            'organization_id' => $tenant->organizationId,
            'table_id' => $table->id,
            'name' => 'Name',
            'type' => 'singleLineText',
            'position' => 0,
            'is_primary' => true,
            'created_by_id' => $tenant->userId(),
        ]);
        $table->forceFill(['primary_field_id' => $primary->id])->save();

        return response()->json(['data' => $this->tableDto($table->fresh())], 201);
    }

    public function showTable(Request $request, string $tableId)
    {
        $this->tenant($request, 'table:read');

        return response()->json(['data' => $this->tableDto($this->table($request))]);
    }

    public function updateTable(Request $request, string $tableId)
    {
        $this->tenant($request, 'table:update');
        $this->strict($request, ['name', 'description', 'icon', 'color', 'position']);
        $data = $request->validate([
            'name' => ['sometimes', 'string', 'min:1', 'max:120'],
            'description' => ['sometimes', 'nullable', 'string', 'max:2000'],
            'icon' => ['sometimes', 'nullable', 'string', 'max:64'],
            'color' => ['sometimes', 'nullable', 'string', 'regex:/^#[0-9A-Fa-f]{6}$/'],
            'position' => ['sometimes', 'integer', 'min:0'],
        ]);

        $table = $this->table($request);
        $table->fill($data)->save();

        return response()->json(['data' => $this->tableDto($table)]);
    }

    public function deleteTable(Request $request, string $tableId)
    {
        $this->tenant($request, 'table:delete');
        $this->table($request)->delete();

        return response()->noContent();
    }

    /**
     * POST /v1/tables/{tableId}/duplicate — copy a table: fields, saved views, and (optionally)
     * records. Record data is keyed by field id, so every copied record's keys are remapped from
     * the old field ids to the new — copying the JSON as-is would orphan every cell.
     */
    public function duplicateTable(Request $request, string $tableId)
    {
        $tenant = $this->tenant($request, 'table:create');
        $this->strict($request, ['withRecords']);
        $request->validate(['withRecords' => ['sometimes', 'boolean']]);
        $withRecords = $request->boolean('withRecords', true);

        $source = $this->table($request);

        // "Patients copy", "Patients copy 2", … — first name that is free.
        $name = "{$source->name} copy";
        for ($n = 2; Table::where('base_id', $source->base_id)->where('name', $name)->whereNull('deleted_at')->exists(); $n++) {
            $name = "{$source->name} copy {$n}";
        }

        $copy = Table::create([
            'organization_id' => $tenant->organizationId,
            'base_id' => $source->base_id,
            'name' => $name,
            'description' => $source->description,
            'icon' => $source->icon,
            'color' => $source->color,
            'position' => (int) Table::where('base_id', $source->base_id)->max('position') + 1,
            'created_by_id' => $tenant->userId(),
        ]);

        $fieldMap = []; // old field id => new field id
        foreach (Field::where('table_id', $source->id)->whereNull('deleted_at')->orderBy('position')->get() as $field) {
            $new = $field->replicate(['id']);
            $new->id = Field::newPrefixedId();
            $new->table_id = $copy->id;
            $new->save();
            $fieldMap[$field->id] = $new->id;
            if ($field->id === $source->primary_field_id) {
                $copy->forceFill(['primary_field_id' => $new->id])->save();
            }
        }

        $count = 0;
        if ($withRecords) {
            Record::where('table_id', $source->id)->whereNull('deleted_at')
                ->orderBy('auto_number')->chunk(500, function ($records) use ($copy, $fieldMap, &$count) {
                    foreach ($records as $record) {
                        $data = [];
                        foreach ((array) $record->data as $fieldId => $value) {
                            if (isset($fieldMap[$fieldId])) {
                                $data[$fieldMap[$fieldId]] = $value;
                            }
                        }
                        $new = $record->replicate(['id']);
                        $new->id = Record::newPrefixedId();
                        $new->table_id = $copy->id;
                        $new->data = $data;
                        $new->auto_number = ++$count;
                        $new->save();
                    }
                });
        }
        $copy->forceFill(['record_count' => $count, 'auto_number_seq' => $count])->save();

        foreach (\App\Models\View::where('table_id', $source->id)->whereNull('deleted_at')->orderBy('position')->get() as $view) {
            $newView = $view->replicate(['id']);
            $newView->id = \App\Models\View::newPrefixedId();
            $newView->table_id = $copy->id;
            $newView->save();
        }

        return response()->json(['data' => $this->tableDto($copy->fresh())], 201);
    }

    /**
     * POST /v1/tables/{tableId}/clear — Airtable's "Clear data": every record goes, the structure
     * (fields, views) stays. Soft-deletes so it matches single-record deletion semantics.
     */
    public function clearTable(Request $request, string $tableId)
    {
        $this->tenant($request, 'record:delete');
        $table = $this->table($request);

        $deleted = Record::where('table_id', $table->id)->whereNull('deleted_at')
            ->update(['deleted_at' => \Illuminate\Support\Carbon::now()]);
        $table->forceFill(['record_count' => 0])->save();

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

    private function base(Request $request): Base
    {
        return $request->attributes->get('resolved_base') ?? abort(404);
    }

    private function table(Request $request): Table
    {
        return $request->attributes->get('resolved_table') ?? abort(404);
    }

    private function baseDto(Base $b): array
    {
        return [
            'id' => $b->id,
            'workspaceId' => $b->workspace_id,
            'name' => $b->name,
            'description' => $b->description,
            'icon' => $b->icon,
            'color' => $b->color,
            'position' => (int) $b->position,
            'createdAt' => $b->created_at?->copy()->utc()->format('Y-m-d\TH:i:s.v\Z'),
        ];
    }

    private function tableDto(Table $t): array
    {
        return [
            'id' => $t->id,
            'baseId' => $t->base_id,
            'name' => $t->name,
            'description' => $t->description,
            'icon' => $t->icon,
            'color' => $t->color,
            'position' => (int) $t->position,
            'primaryFieldId' => $t->primary_field_id,
            'recordCount' => (int) $t->record_count,
            'createdAt' => $t->created_at?->copy()->utc()->format('Y-m-d\TH:i:s.v\Z'),
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

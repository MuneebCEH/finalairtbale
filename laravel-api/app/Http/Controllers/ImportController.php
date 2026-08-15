<?php

namespace App\Http\Controllers;

use App\Models\Base;
use App\Models\Field;
use App\Models\Record;
use App\Models\Table;
use App\Support\Permissions;
use App\Support\TenantContext;
use Illuminate\Http\Request;
use Illuminate\Support\Carbon;

/**
 * Creates a base from an uploaded spreadsheet. The browser parses the .xlsx/.csv (SheetJS) and posts
 * the already-extracted columns + rows as JSON, so this endpoint needs no spreadsheet library and no
 * PHP extensions beyond the defaults — which matters on the shared host. Mirrors TemplateController.
 */
class ImportController extends Controller
{
    /** Field types the grid can render; anything else is coerced to plain text. */
    private const ALLOWED_TYPES = [
        'singleLineText', 'longText', 'email', 'url', 'phone',
        'number', 'currency', 'percent', 'checkbox', 'date', 'dateTime',
    ];

    /** POST /v1/workspaces/{workspaceId}/import-spreadsheet */
    public function spreadsheet(Request $request, string $workspaceId)
    {
        /** @var TenantContext $tenant */
        $tenant = $request->attributes->get('tenant');
        Permissions::authorize($tenant, 'base:create');

        $validated = $request->validate([
            'baseName' => ['required', 'string', 'max:120'],
            'tableName' => ['required', 'string', 'max:120'],
            'fields' => ['required', 'array', 'min:1', 'max:200'],
            'fields.*.name' => ['required', 'string', 'max:120'],
            'fields.*.type' => ['nullable', 'string'],
            'rows' => ['present', 'array', 'max:20000'],
            'rows.*' => ['array'],
        ]);

        $now = Carbon::now();
        $base = Base::create([
            'organization_id' => $tenant->organizationId,
            'workspace_id' => $workspaceId,
            'name' => trim($validated['baseName']),
            'icon' => '📄',
            'created_by_id' => $tenant->userId(),
        ]);

        $table = Table::create([
            'organization_id' => $tenant->organizationId,
            'base_id' => $base->id,
            'name' => trim($validated['tableName']) ?: 'Imported',
            'position' => 0,
            'created_by_id' => $tenant->userId(),
        ]);

        // Create one field per column. The first column is the primary field. Duplicate/blank
        // names are made safe so the grid always has something to show.
        $fieldIds = [];
        $seenNames = [];
        foreach ($validated['fields'] as $i => $def) {
            $type = in_array($def['type'] ?? null, self::ALLOWED_TYPES, true) ? $def['type'] : 'singleLineText';
            $name = trim($def['name']) !== '' ? trim($def['name']) : 'Field '.($i + 1);
            $key = mb_strtolower($name);
            if (isset($seenNames[$key])) {
                $name .= ' ('.(++$seenNames[$key]).')';
            } else {
                $seenNames[$key] = 1;
            }

            $field = Field::create([
                'organization_id' => $tenant->organizationId,
                'table_id' => $table->id,
                'name' => $name,
                'type' => $type,
                'position' => $i,
                'is_primary' => $i === 0,
                'options' => [],
                'created_by_id' => $tenant->userId(),
            ]);
            if ($i === 0) {
                $table->forceFill(['primary_field_id' => $field->id])->save();
            }
            $fieldIds[] = ['id' => $field->id, 'type' => $type];
        }

        // Insert rows, coercing each cell to match its column type.
        $seq = 0;
        foreach ($validated['rows'] as $row) {
            $seq++;
            $data = [];
            foreach (array_values((array) $row) as $i => $value) {
                if (! isset($fieldIds[$i])) {
                    continue;
                }
                $coerced = $this->coerce($fieldIds[$i]['type'], $value);
                if ($coerced !== null && $coerced !== '') {
                    $data[$fieldIds[$i]['id']] = $coerced;
                }
            }
            Record::create([
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
        }
        $table->forceFill(['record_count' => $seq, 'auto_number_seq' => $seq])->save();

        return response()->json(['data' => [
            'id' => $base->id,
            'workspaceId' => $base->workspace_id,
            'name' => $base->name,
            'icon' => $base->icon,
            'tableId' => $table->id,
            'importedRows' => $seq,
        ]], 201);
    }

    /**
     * POST /v1/tables/{tableId}/import-rows — append spreadsheet rows to an EXISTING table
     * (Airtable's "Import data" on a table). Columns are matched to fields by name
     * (case-insensitive); unmatched columns become new fields at the end.
     */
    public function rows(Request $request, string $tableId)
    {
        /** @var TenantContext $tenant */
        $tenant = $request->attributes->get('tenant');
        Permissions::authorize($tenant, 'record:create');

        /** @var \App\Models\Table $table */
        $table = $request->attributes->get('resolved_table') ?? abort(404);

        $validated = $request->validate([
            'fields' => ['required', 'array', 'min:1', 'max:200'],
            'fields.*.name' => ['required', 'string', 'max:120'],
            'fields.*.type' => ['nullable', 'string'],
            'rows' => ['required', 'array', 'min:1', 'max:20000'],
            'rows.*' => ['array'],
        ]);

        $existing = Field::where('table_id', $table->id)->whereNull('deleted_at')->get();
        $byName = [];
        foreach ($existing as $field) {
            $byName[mb_strtolower(trim($field->name))] = $field;
        }
        $maxPos = (int) $existing->max('position');

        // Column i => the field (existing by name, or newly created) plus the type used to coerce.
        $columns = [];
        foreach ($validated['fields'] as $i => $def) {
            $name = trim($def['name']) !== '' ? trim($def['name']) : 'Field '.($i + 1);
            $found = $byName[mb_strtolower($name)] ?? null;
            if (! $found) {
                $type = in_array($def['type'] ?? null, self::ALLOWED_TYPES, true) ? $def['type'] : 'singleLineText';
                $found = Field::create([
                    'organization_id' => $tenant->organizationId,
                    'table_id' => $table->id,
                    'name' => $name,
                    'type' => $type,
                    'position' => ++$maxPos,
                    'is_primary' => false,
                    'options' => [],
                    'created_by_id' => $tenant->userId(),
                ]);
                $byName[mb_strtolower($name)] = $found;
            }
            $columns[$i] = $found;
        }

        $now = Carbon::now();
        $seq = (int) $table->auto_number_seq;
        $inserted = 0;
        foreach ($validated['rows'] as $row) {
            $data = [];
            foreach (array_values((array) $row) as $i => $value) {
                if (! isset($columns[$i])) {
                    continue;
                }
                $coerced = $this->coerce($columns[$i]->type, $value);
                if ($coerced !== null && $coerced !== '') {
                    $data[$columns[$i]->id] = $coerced;
                }
            }
            Record::create([
                'organization_id' => $tenant->organizationId,
                'table_id' => $table->id,
                'data' => $data,
                'version' => 1,
                'auto_number' => ++$seq,
                'created_by' => $tenant->userId(),
                'updated_by' => $tenant->userId(),
                'created_at' => $now,
                'updated_at' => $now,
            ]);
            $inserted++;
        }
        $table->forceFill([
            'record_count' => (int) $table->record_count + $inserted,
            'auto_number_seq' => $seq,
        ])->save();

        return response()->json(['data' => ['importedRows' => $inserted, 'tableId' => $table->id]], 201);
    }

    /** Best-effort conversion of a spreadsheet cell to the stored value for its field type. */
    private function coerce(string $type, mixed $value): mixed
    {
        if (is_array($value)) {
            $value = implode(', ', $value);
        }
        $str = is_string($value) ? trim($value) : $value;

        return match ($type) {
            'number', 'currency', 'percent' => is_numeric($str) ? 0 + $str : null,
            'checkbox' => $this->toBool($str),
            default => $str === null ? null : (string) $str,
        };
    }

    private function toBool(mixed $v): bool
    {
        if (is_bool($v)) {
            return $v;
        }
        $s = mb_strtolower(trim((string) $v));

        return in_array($s, ['1', 'true', 'yes', 'y', 'checked', 'x', '✓'], true);
    }
}

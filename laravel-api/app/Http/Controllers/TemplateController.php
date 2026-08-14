<?php

namespace App\Http\Controllers;

use App\Models\Base;
use App\Models\Field;
use App\Models\Record;
use App\Models\Table;
use App\Support\Permissions;
use App\Support\Templates;
use App\Support\TenantContext;
use Illuminate\Http\Request;
use Illuminate\Support\Carbon;

class TemplateController extends Controller
{
    /** GET /v1/templates — the gallery. Public-ish but still behind session. */
    public function index()
    {
        $data = array_map(fn ($t) => [
            'id' => $t['id'],
            'name' => $t['name'],
            'category' => $t['category'],
            'icon' => $t['icon'],
            'description' => $t['description'],
            'tables' => array_map(fn ($tbl) => $tbl['name'], $t['tables']),
        ], Templates::all());

        return response()->json(['data' => $data]);
    }

    /** POST /v1/workspaces/{workspaceId}/bases/from-template — build a base from a template. */
    public function create(Request $request, string $workspaceId)
    {
        /** @var TenantContext $tenant */
        $tenant = $request->attributes->get('tenant');
        Permissions::authorize($tenant, 'base:create');

        $request->validate(['templateId' => ['required', 'string']]);
        $template = Templates::find($request->string('templateId'));
        if (! $template) {
            throw \App\Exceptions\ApiException::notFound('Template not found.');
        }

        $now = Carbon::now();
        $base = Base::create([
            'organization_id' => $tenant->organizationId,
            'workspace_id' => $workspaceId,
            'name' => $template['name'],
            'icon' => $template['icon'],
            'created_by_id' => $tenant->userId(),
        ]);

        foreach ($template['tables'] as $pos => $tableDef) {
            $table = Table::create([
                'organization_id' => $tenant->organizationId,
                'base_id' => $base->id,
                'name' => $tableDef['name'],
                'position' => $pos,
                'created_by_id' => $tenant->userId(),
            ]);

            $fieldIds = [];
            foreach ($tableDef['fields'] as $fpos => $fieldDef) {
                $field = Field::create([
                    'organization_id' => $tenant->organizationId,
                    'table_id' => $table->id,
                    'name' => $fieldDef['name'],
                    'type' => $fieldDef['type'],
                    'position' => $fpos,
                    'is_primary' => $fieldDef['primary'] ?? false,
                    'options' => $fieldDef['options'] ?? [],
                    'created_by_id' => $tenant->userId(),
                ]);
                if ($field->is_primary) {
                    $table->forceFill(['primary_field_id' => $field->id])->save();
                }
                $fieldIds[] = $field->id;
            }

            $seq = 0;
            foreach (($tableDef['rows'] ?? []) as $row) {
                $seq++;
                $data = [];
                foreach ($row as $i => $value) {
                    if (isset($fieldIds[$i])) {
                        $data[$fieldIds[$i]] = $value;
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
        }

        return response()->json(['data' => [
            'id' => $base->id,
            'workspaceId' => $base->workspace_id,
            'name' => $base->name,
            'icon' => $base->icon,
        ]], 201);
    }
}

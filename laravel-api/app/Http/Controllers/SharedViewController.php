<?php

namespace App\Http\Controllers;

use App\Models\Field;
use App\Models\Record;
use App\Models\Table;
use App\Models\View;
use App\Support\FormulaEngine;
use App\Support\RecordLinks;
use App\Support\RecordQueryEngine;

/**
 * The public face of a shared view: no session, no tenant — the unguessable slug IS the
 * authorization, exactly like Airtable's share links. Strictly read-only, and shaped for the
 * static /share page: view + fields (hidden ones already removed) + records with the view's own
 * filter/sort applied, capped so a share link can never become a bulk-export API.
 */
class SharedViewController extends Controller
{
    private const MAX_RECORDS = 1000;

    /** GET /v1/shared/{slug} */
    public function show(string $slug)
    {
        $view = View::where('share_slug', $slug)->whereNull('deleted_at')->first();
        if (! $view) {
            return response()->json(['error' => [
                'code' => 'NOT_FOUND', 'message' => 'This share link is invalid or has been revoked.',
            ]], 404);
        }

        $table = Table::whereKey($view->table_id)->whereNull('deleted_at')->first();
        if (! $table) {
            return response()->json(['error' => [
                'code' => 'NOT_FOUND', 'message' => 'This share link is invalid or has been revoked.',
            ]], 404);
        }

        $config = (array) ($view->config ?? []);
        $hidden = array_flip((array) ($config['hiddenFieldIds'] ?? []));

        $fields = Field::where('table_id', $table->id)->whereNull('deleted_at')
            ->orderBy('position')->orderBy('created_at')->get()
            ->filter(fn (Field $f) => ! isset($hidden[$f->id]))
            ->map(fn (Field $f) => [
                'id' => $f->id,
                'name' => $f->name,
                'type' => $f->type,
                'isPrimary' => (bool) $f->is_primary,
                'options' => $f->options ?? (object) [],
            ])->values()->all();

        // The view's saved filter and sort apply — the visitor sees what the sharer sees.
        $fieldTypes = Field::where('table_id', $table->id)->whereNull('deleted_at')->pluck('type', 'id')->all();
        $query = Record::where('table_id', $table->id)->whereNull('deleted_at');
        (new RecordQueryEngine($fieldTypes))->apply($query, [
            'filter' => (array) ($config['filter'] ?? []),
            'sort' => (array) ($config['sorts'] ?? []),
        ]);

        $rows = $query->limit(self::MAX_RECORDS)->get();
        $lf = RecordLinks::linkFields($table->id);
        $labels = RecordLinks::labelMap($lf, $rows);

        $records = FormulaEngine::inject($table->id, $rows->map(function (Record $r) use ($lf, $labels) {
            $data = (array) ($r->data ?? []);
            if (! empty($lf)) {
                $data = RecordLinks::expand($data, $lf, $labels);
            }

            return ['id' => $r->id, 'fields' => $data === [] ? (object) [] : $data];
        })->values()->all());

        return response()->json(['data' => [
            'view' => ['name' => $view->name, 'type' => $view->type],
            'table' => ['name' => $table->name],
            'fields' => $fields,
            'records' => $records,
            'truncated' => $rows->count() === self::MAX_RECORDS,
        ]]);
    }
}

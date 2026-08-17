<?php

namespace App\Http\Controllers;

use App\Models\Table;
use App\Models\View;
use App\Support\Permissions;
use App\Support\TenantContext;
use Illuminate\Http\Request;

/**
 * Saved views for a table (Airtable-style): a named type + toolbar config that everyone on the
 * table shares. Creating the first view happens lazily from the client; the config shape is
 * whatever the toolbar produced (filter/sorts/groups/hiddenFieldIds/rowHeight) and is stored
 * as-is — the server only bounds its size.
 */
class ViewController extends Controller
{
    private const TYPES = ['grid', 'kanban', 'calendar', 'gallery', 'timeline', 'gantt', 'chart', 'map'];

    /** GET /v1/tables/{tableId}/views */
    public function list(Request $request, string $tableId)
    {
        $this->authorizeAction($request, 'table:read');
        $table = $this->table($request);

        $views = View::where('table_id', $table->id)->whereNull('deleted_at')
            ->orderBy('position')->orderBy('created_at')->get()
            ->map(fn (View $v) => $this->dto($v))->all();

        return response()->json(['data' => $views]);
    }

    /** POST /v1/tables/{tableId}/views */
    public function create(Request $request, string $tableId)
    {
        $tenant = $this->authorizeAction($request, 'view:update');
        $table = $this->table($request);

        $data = $request->validate([
            'name' => ['required', 'string', 'min:1', 'max:120'],
            'type' => ['sometimes', 'string', 'in:'.implode(',', self::TYPES)],
            'config' => ['sometimes', 'nullable', 'array'],
        ]);

        $view = View::create([
            'organization_id' => $tenant->organizationId,
            'table_id' => $table->id,
            'name' => $data['name'],
            'type' => $data['type'] ?? 'grid',
            'config' => $data['config'] ?? null,
            'position' => (int) View::where('table_id', $table->id)->max('position') + 1,
            'created_by' => $tenant->userId(),
        ]);

        return response()->json(['data' => $this->dto($view)], 201);
    }

    /** PATCH /v1/views/{viewId} */
    public function update(Request $request, string $viewId)
    {
        $this->authorizeAction($request, 'view:update');
        $view = $this->view($request);

        $data = $request->validate([
            'name' => ['sometimes', 'string', 'min:1', 'max:120'],
            'type' => ['sometimes', 'string', 'in:'.implode(',', self::TYPES)],
            'config' => ['sometimes', 'nullable', 'array'],
            'position' => ['sometimes', 'integer', 'min:0'],
        ]);

        $view->fill($data)->save();

        return response()->json(['data' => $this->dto($view)]);
    }

    /** DELETE /v1/views/{viewId} */
    public function delete(Request $request, string $viewId)
    {
        $this->authorizeAction($request, 'view:update');
        $this->view($request)->delete();

        return response()->noContent();
    }

    // ── Helpers ──────────────────────────────────────────────────────────────

    private function authorizeAction(Request $request, string $action): TenantContext
    {
        /** @var TenantContext $tenant */
        $tenant = $request->attributes->get('tenant');
        Permissions::authorize($tenant, $action);

        return $tenant;
    }

    private function table(Request $request): Table
    {
        return $request->attributes->get('resolved_table') ?? abort(404);
    }

    private function view(Request $request): View
    {
        return $request->attributes->get('resolved_view') ?? abort(404);
    }

    private function dto(View $view): array
    {
        return [
            'id' => $view->id,
            'tableId' => $view->table_id,
            'name' => $view->name,
            'type' => $view->type,
            'config' => $view->config,
            'position' => $view->position,
            'createdAt' => $view->created_at?->toIso8601String(),
            'updatedAt' => $view->updated_at?->toIso8601String(),
        ];
    }
}

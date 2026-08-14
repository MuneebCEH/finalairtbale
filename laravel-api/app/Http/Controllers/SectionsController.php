<?php

namespace App\Http\Controllers;

use App\Support\Permissions;
use App\Support\TenantContext;
use Illuminate\Http\Request;

/**
 * The base's secondary sections — Forms and Automations. These features are not yet ported, so the
 * endpoints return an empty, valid list: the frontend tabs render "nothing here yet" instead of
 * erroring. Full forms/automations engines are later phases.
 */
class SectionsController extends Controller
{
    public function forms(Request $request, string $tableId)
    {
        $this->authorize($request, 'table:read');

        return response()->json(['data' => []]);
    }

    public function automations(Request $request, string $baseId)
    {
        $this->authorize($request, 'base:read');

        return response()->json(['data' => []]);
    }

    private function authorize(Request $request, string $action): void
    {
        /** @var TenantContext $tenant */
        $tenant = $request->attributes->get('tenant');
        Permissions::authorize($tenant, $action);
    }
}

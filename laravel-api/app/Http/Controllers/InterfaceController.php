<?php

namespace App\Http\Controllers;

use App\Models\Base;
use App\Support\Permissions;
use App\Support\TenantContext;
use Illuminate\Http\Request;

/**
 * Interfaces — per-base dashboards. The designer state is one JSON blob of widgets
 * ({id, type, title, tableId, fieldId?, aggregation?, groupFieldId?}); the server stores and
 * bounds it, the client renders it against the ordinary records API. Reading is open to anyone
 * who can read the base; editing the layout is an editor action, like editing a view.
 */
class InterfaceController extends Controller
{
    /** GET /v1/bases/{baseId}/interfaces */
    public function show(Request $request, string $baseId)
    {
        $this->tenant($request, 'base:read');
        $base = $this->base($request);

        $config = json_decode((string) $base->interfaces_config, true);

        return response()->json(['data' => [
            'widgets' => is_array($config['widgets'] ?? null) ? $config['widgets'] : [],
        ]]);
    }

    /** PUT /v1/bases/{baseId}/interfaces */
    public function update(Request $request, string $baseId)
    {
        $this->tenant($request, 'view:update');
        $base = $this->base($request);

        $data = $request->validate([
            'widgets' => ['present', 'array', 'max:24'],
            'widgets.*' => ['array'],
        ]);

        $encoded = json_encode(['widgets' => array_values($data['widgets'])]);
        if (strlen($encoded) > 100_000) {
            return response()->json(['error' => [
                'code' => 'MALFORMED_REQUEST', 'message' => 'This dashboard is too large to save.',
            ]], 422);
        }

        $base->forceFill(['interfaces_config' => $encoded])->save();

        return response()->json(['data' => ['widgets' => array_values($data['widgets'])]]);
    }

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
}

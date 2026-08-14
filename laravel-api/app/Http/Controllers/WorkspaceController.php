<?php

namespace App\Http\Controllers;

use App\Exceptions\ApiException;
use App\Models\Workspace;
use App\Models\WorkspaceMember;
use App\Support\Permissions;
use App\Support\TenantContext;
use Illuminate\Http\Request;

class WorkspaceController extends Controller
{
    /** GET /v1/organizations/{orgId}/workspaces — the workspaces the caller may see. */
    public function list(Request $request)
    {
        /** @var TenantContext $tenant */
        $tenant = $request->attributes->get('tenant');
        Permissions::authorize($tenant, 'workspace:list');

        $query = Workspace::where('organization_id', $tenant->organizationId)->whereNull('deleted_at');

        // Owners/admins see the whole org; everyone else sees only workspaces they belong to.
        if (! $tenant->seesWholeOrg()) {
            $visibleIds = WorkspaceMember::where('organization_id', $tenant->organizationId)
                ->where('user_id', $tenant->userId())
                ->pluck('workspace_id');
            $query->whereIn('id', $visibleIds);
        }

        $rows = $query->orderBy('position')->orderBy('created_at')->get()
            ->map(fn (Workspace $w) => $this->dto($w))->all();

        return response()->json(['data' => $rows]);
    }

    /** POST /v1/organizations/{orgId}/workspaces */
    public function create(Request $request)
    {
        /** @var TenantContext $tenant */
        $tenant = $request->attributes->get('tenant');
        Permissions::authorize($tenant, 'workspace:create');

        $this->strict($request, ['name', 'description', 'icon', 'color']);
        $data = $request->validate([
            'name' => ['required', 'string', 'min:1', 'max:120'],
            'description' => ['sometimes', 'nullable', 'string', 'max:2000'],
            'icon' => ['sometimes', 'nullable', 'string', 'max:64'],
            'color' => ['sometimes', 'nullable', 'string', 'regex:/^#[0-9A-Fa-f]{6}$/'],
        ]);

        $workspace = Workspace::create([
            'organization_id' => $tenant->organizationId,
            'name' => $data['name'],
            'description' => $data['description'] ?? null,
            'icon' => $data['icon'] ?? null,
            'color' => $data['color'] ?? null,
            'created_by_id' => $tenant->userId(),
        ]);

        WorkspaceMember::create([
            'organization_id' => $tenant->organizationId,
            'workspace_id' => $workspace->id,
            'user_id' => $tenant->userId(),
            'role' => 'owner',
        ]);

        return response()->json(['data' => $this->dto($workspace)], 201);
    }

    /** GET /v1/workspaces/{workspaceId} */
    public function show(Request $request)
    {
        /** @var TenantContext $tenant */
        $tenant = $request->attributes->get('tenant');
        Permissions::authorize($tenant, 'workspace:read');

        /** @var Workspace $workspace */
        $workspace = $request->attributes->get('resolved_workspace');

        // Members who don't see the whole org must have an explicit workspace grant.
        if (! $tenant->seesWholeOrg()) {
            $isMember = WorkspaceMember::where('workspace_id', $workspace->id)
                ->where('user_id', $tenant->userId())->exists();
            if (! $isMember) {
                throw ApiException::notFound('Workspace not found.');
            }
        }

        return response()->json(['data' => $this->dto($workspace)]);
    }

    private function dto(Workspace $w): array
    {
        return [
            'id' => $w->id,
            'organizationId' => $w->organization_id,
            'name' => $w->name,
            'description' => $w->description,
            'icon' => $w->icon,
            'color' => $w->color,
            'position' => (int) $w->position,
            'archivedAt' => $w->archived_at?->copy()->utc()->format('Y-m-d\TH:i:s.v\Z'),
            'createdAt' => $w->created_at?->copy()->utc()->format('Y-m-d\TH:i:s.v\Z'),
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

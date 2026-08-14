<?php

namespace App\Http\Middleware;

use App\Exceptions\ApiException;
use App\Models\Base;
use App\Models\OrganizationMember;
use App\Models\Table;
use App\Models\User;
use App\Models\Workspace;
use App\Support\TenantContext;
use Closure;
use Illuminate\Http\Request;
use Symfony\Component\HttpFoundation\Response;

/**
 * Resolves the tenant for an org- or workspace-scoped route and enforces isolation.
 *
 * The caller must hold an active membership in the organization named by the `orgId` route
 * parameter (or the org that owns the `workspaceId`). If they do not, the response is 404 — never
 * 403 — so that the mere existence of another tenant's id is not confirmed (docs/03 §T2). Must run
 * after the `session` middleware, which populates the authenticated user.
 */
class ResolveTenant
{
    public function handle(Request $request, Closure $next): Response
    {
        /** @var User|null $user */
        $user = $request->attributes->get('auth_user');
        if (! $user) {
            throw ApiException::unauthenticated('Authentication is required.');
        }

        // The org is named directly, or derived from the workspace/base/table in the path. Each
        // resolved entity is stashed so controllers needn't re-fetch it.
        $orgId = $request->route('orgId');

        if (! $orgId && ($workspaceId = $request->route('workspaceId'))) {
            $workspace = Workspace::whereKey($workspaceId)->first();
            $orgId = $workspace?->organization_id;
            if ($workspace) {
                $request->attributes->set('resolved_workspace', $workspace);
            }
        }

        if (! $orgId && ($baseId = $request->route('baseId'))) {
            $base = Base::whereKey($baseId)->whereNull('deleted_at')->first();
            $orgId = $base?->organization_id;
            if ($base) {
                $request->attributes->set('resolved_base', $base);
            }
        }

        if (! $orgId && ($tableId = $request->route('tableId'))) {
            $table = Table::whereKey($tableId)->whereNull('deleted_at')->first();
            $orgId = $table?->organization_id;
            if ($table) {
                $request->attributes->set('resolved_table', $table);
            }
        }

        $member = $orgId
            ? OrganizationMember::where('organization_id', $orgId)
                ->where('user_id', $user->id)
                ->where('status', 'active')
                ->first()
            : null;

        // Not a member (or the org/workspace does not exist): indistinguishable by design.
        if (! $member) {
            throw ApiException::notFound('Organization not found.');
        }

        $request->attributes->set('tenant', new TenantContext($orgId, $user, $member));

        return $next($request);
    }
}

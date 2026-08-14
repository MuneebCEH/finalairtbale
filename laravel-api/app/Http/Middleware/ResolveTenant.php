<?php

namespace App\Http\Middleware;

use App\Exceptions\ApiException;
use App\Models\OrganizationMember;
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

        $orgId = $request->route('orgId');
        if (! $orgId) {
            $workspaceId = $request->route('workspaceId');
            if ($workspaceId) {
                $workspace = Workspace::whereKey($workspaceId)->first();
                $orgId = $workspace?->organization_id;
                // Stash the workspace so controllers needn't re-fetch it.
                if ($workspace) {
                    $request->attributes->set('resolved_workspace', $workspace);
                }
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

<?php

namespace App\Support;

use App\Exceptions\ApiException;

/**
 * Capability checks over the tenant's org role. This is a faithful subset of the NestJS policy
 * engine covering the Phase 3 endpoints; the full capability matrix (per docs/03) lands with the
 * rest of the port. Ranks come straight from ORGANIZATION_ROLE_RANK in packages/types/src/roles.ts.
 */
final class Permissions
{
    private const ORG_ROLE_RANK = [
        'guest' => 0,
        'member' => 1,
        'billing_admin' => 2,
        'security_admin' => 3,
        'admin' => 4,
        'owner' => 5,
    ];

    /** action => minimum org role required */
    private const ACTION_MIN_ROLE = [
        'organization:read' => 'guest',
        'member:read' => 'member',
        'workspace:list' => 'guest',
        'workspace:read' => 'guest',
        'workspace:create' => 'member',
        'organization:update' => 'admin',
        'organization:manage_settings' => 'admin',
        'member:manage' => 'admin',

        // Data plane. Reads for any member; writes for member+ (guests are read-only). NOTE:
        // finer workspace-role gating (a workspace 'viewer' being read-only even though they are an
        // org 'member') is the next Phase 4 refinement.
        'base:read' => 'guest', 'base:create' => 'member', 'base:update' => 'member', 'base:delete' => 'member',
        'table:read' => 'guest', 'table:create' => 'member', 'table:update' => 'member', 'table:delete' => 'member',
        'field:read' => 'guest', 'field:create' => 'member', 'field:update' => 'member', 'field:delete' => 'member',
        'record:read' => 'guest', 'record:create' => 'member', 'record:update' => 'member', 'record:delete' => 'member',
    ];

    public static function can(TenantContext $tenant, string $action): bool
    {
        $required = self::ACTION_MIN_ROLE[$action] ?? 'owner';
        $have = self::ORG_ROLE_RANK[$tenant->orgRole()] ?? -1;

        return $have >= (self::ORG_ROLE_RANK[$required] ?? 99);
    }

    public static function authorize(TenantContext $tenant, string $action): void
    {
        if (! self::can($tenant, $action)) {
            throw new ApiException('FORBIDDEN', 'You do not have permission to perform this action.', [
                'action' => $action,
            ]);
        }
    }
}

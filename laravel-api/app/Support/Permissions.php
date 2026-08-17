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
    /**
     * The role ladder, Airtable-shaped: viewer (read-only) < editor (records but not schema)
     * < admin (schema, automations, members) < owner (everything). `member` is the legacy seed
     * value and keeps its historical meaning — records yes, schema changes no — so existing
     * memberships keep working exactly as their name implied.
     */
    private const ORG_ROLE_RANK = [
        'guest' => 0,
        'viewer' => 1,
        'member' => 2,
        'editor' => 2,
        'billing_admin' => 3,
        'security_admin' => 4,
        'admin' => 5,
        'owner' => 6,
    ];

    /** action => minimum org role required */
    private const ACTION_MIN_ROLE = [
        'organization:read' => 'guest',
        'member:read' => 'viewer',
        'workspace:list' => 'guest',
        'workspace:read' => 'guest',
        'workspace:create' => 'admin',
        'organization:update' => 'admin',
        'organization:manage_settings' => 'admin',
        'member:manage' => 'admin',

        // Data plane. Reads for everyone in the org; record writes for editors; anything that
        // changes STRUCTURE (bases, tables, fields, automations) needs admin — an editor
        // deleting a column is how a team loses a column.
        'base:read' => 'guest', 'base:create' => 'admin', 'base:update' => 'admin', 'base:delete' => 'admin',
        'table:read' => 'guest', 'table:create' => 'admin', 'table:update' => 'admin', 'table:delete' => 'admin',
        'field:read' => 'guest', 'field:create' => 'admin', 'field:update' => 'admin', 'field:delete' => 'admin',
        'record:read' => 'guest', 'record:create' => 'editor', 'record:update' => 'editor', 'record:delete' => 'editor',

        // Views are working-surface, not structure: an editor saving a filter is normal work.
        'view:read' => 'guest', 'view:update' => 'editor',
        'automation:manage' => 'admin',
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

/**
 * The complete catalogue of authorizable actions.
 *
 * Every guarded operation names an action from this list. Making the catalogue exhaustive and
 * closed means a new endpoint cannot invent an unreviewed permission string, and the
 * permission-matrix test can iterate every action to assert the documented behaviour.
 */

export const ACTIONS = [
  // ── Organization ──
  'organization:read',
  'organization:update',
  'organization:delete',
  'organization:transfer_ownership',
  'organization:manage_settings',
  'organization:manage_security',
  'organization:manage_domains',
  'organization:view_audit_log',
  'organization:export_audit_log',
  'organization:manage_sso',

  // ── Membership ──
  'member:read',
  'member:invite',
  'member:invite_guest',
  'member:remove',
  'member:suspend',
  'member:change_role',
  'group:read',
  'group:manage',

  // ── Billing ──
  'billing:read',
  'billing:manage',

  // ── Workspace ──
  'workspace:create',
  // Enumerating the workspaces of an organization. Distinct from `workspace:read`, which is
  // about one specific workspace: the collection endpoint is organization-scoped and filters
  // its rows by grant, so requiring the per-workspace permission would deny everybody who is
  // not an administrator — including people who hold grants on individual workspaces.
  'workspace:list',
  'workspace:read',
  'workspace:update',
  'workspace:archive',
  'workspace:delete',
  'workspace:manage_members',

  // ── Base ──
  'base:create',
  'base:read',
  'base:update',
  'base:delete',
  'base:duplicate',
  'base:export',
  'base:manage_members',
  'base:share_externally',

  // ── Schema ──
  'table:create',
  'table:update',
  'table:delete',
  'field:create',
  'field:update',
  'field:delete',

  // ── Data ──
  'record:read',
  'record:create',
  'record:update',
  'record:delete',
  'record:restore',
  'record:view_history',

  // ── Views ──
  'view:create_personal',
  'view:create_shared',
  'view:update',
  'view:delete',
  'view:lock',
  'view:share',

  // ── Collaboration ──
  'comment:read',
  'comment:create',
  'comment:update_own',
  'comment:delete_any',

  // ── Forms / interfaces / automations ──
  'form:manage',
  'form:submit',
  'interface:manage',
  'interface:view',
  'automation:read',
  'automation:manage',
  'automation:run',

  // ── Developer platform ──
  'api_token:manage',
  'webhook:manage',
  'integration:manage',

  // ── Platform administration ──
  'platform:read',
  'platform:manage',
  'platform:impersonate',
] as const;

export type Action = (typeof ACTIONS)[number];

export type ResourceType =
  | 'organization'
  | 'workspace'
  | 'base'
  | 'table'
  | 'field'
  | 'record'
  | 'view'
  | 'form'
  | 'interface'
  | 'automation'
  | 'comment'
  | 'platform';

export interface Resource {
  readonly type: ResourceType;
  readonly id: string;
  readonly organizationId: string;
  readonly workspaceId?: string;
  readonly baseId?: string;
  /** Present for resources with an owner, so "update own" rules can be evaluated. */
  readonly ownerId?: string;
}

/** Actions that only ever apply at organization scope. */
export const ORGANIZATION_SCOPED_ACTIONS: ReadonlySet<Action> = new Set<Action>([
  'organization:read',
  'organization:update',
  'organization:delete',
  'organization:transfer_ownership',
  'organization:manage_settings',
  'organization:manage_security',
  'organization:manage_domains',
  'organization:view_audit_log',
  'organization:export_audit_log',
  'organization:manage_sso',
  'member:read',
  'member:invite',
  'member:invite_guest',
  'member:remove',
  'member:suspend',
  'member:change_role',
  'group:read',
  'group:manage',
  'billing:read',
  'billing:manage',
  'workspace:create',
  'workspace:list',
]);

/** Actions that mutate data or schema — used for read-only enforcement and rate-limit classing. */
export const WRITE_ACTIONS: ReadonlySet<Action> = new Set<Action>(
  ACTIONS.filter(
    (a) =>
      !a.endsWith(':read') &&
      !a.endsWith(':view') &&
      a !== 'record:view_history' &&
      a !== 'interface:view' &&
      a !== 'platform:read',
  ),
);

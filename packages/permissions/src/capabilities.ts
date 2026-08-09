import type { OrganizationRole, WorkspaceRole } from '@tessera/types';

import type { Action } from './actions';

/**
 * Role → capability tables.
 *
 * This file is the machine-readable form of the permission matrix in
 * docs/03-security-and-permissions.md §5. The permission-matrix test suite asserts the two
 * against each other, so the documentation cannot drift from the enforcement.
 *
 * A capability may be:
 *   - `true`            granted unconditionally
 *   - a settings key    granted only when that organization setting is enabled
 * Absence means denied.
 */

export type ConditionalGrant = true | { requiresSetting: OrganizationSettingKey };

export type OrganizationSettingKey =
  | 'memberCanCreateWorkspaces'
  | 'memberCanInvite'
  | 'guestCanInvite'
  | 'allowPublicSharing'
  | 'allowPublicForms'
  | 'allowExports'
  | 'allowApiAccess'
  // Not a capability gate — read directly by the policy guard to decide whether an
  // MFA-unsatisfied session may perform writes.
  | 'requireTwoFactor';

export type CapabilityTable = Readonly<Partial<Record<Action, ConditionalGrant>>>;

export const ORGANIZATION_CAPABILITIES: Readonly<Record<OrganizationRole, CapabilityTable>> = {
  owner: {
    'organization:read': true,
    'organization:update': true,
    'organization:delete': true,
    'organization:transfer_ownership': true,
    'organization:manage_settings': true,
    'organization:manage_security': true,
    'organization:manage_domains': true,
    'organization:view_audit_log': true,
    'organization:export_audit_log': true,
    'organization:manage_sso': true,
    'member:read': true,
    'member:invite': true,
    'member:invite_guest': true,
    'member:remove': true,
    'member:suspend': true,
    'member:change_role': true,
    'group:read': true,
    'group:manage': true,
    'billing:read': true,
    'billing:manage': true,
    'workspace:create': true,
    'workspace:list': true,
    'api_token:manage': true,
  },
  admin: {
    'organization:read': true,
    'organization:update': true,
    'organization:manage_settings': true,
    'organization:manage_domains': true,
    'organization:view_audit_log': true,
    'member:read': true,
    'member:invite': true,
    'member:invite_guest': true,
    'member:remove': true,
    'member:suspend': true,
    'member:change_role': true,
    'group:read': true,
    'group:manage': true,
    'billing:read': true,
    'workspace:create': true,
    'workspace:list': true,
    'api_token:manage': true,
  },
  member: {
    'organization:read': true,
    'member:read': true,
    'group:read': true,
    'workspace:create': { requiresSetting: 'memberCanCreateWorkspaces' },
    'workspace:list': true,
    'member:invite': { requiresSetting: 'memberCanInvite' },
    'member:invite_guest': { requiresSetting: 'memberCanInvite' },
  },
  guest: {
    'organization:read': true,
    'member:invite_guest': { requiresSetting: 'guestCanInvite' },
  },
  billing_admin: {
    'organization:read': true,
    'member:read': true,
    'billing:read': true,
    'billing:manage': true,
    'workspace:list': true,
  },
  security_admin: {
    'organization:read': true,
    'organization:manage_security': true,
    'organization:manage_domains': true,
    'organization:view_audit_log': true,
    'organization:export_audit_log': true,
    'organization:manage_sso': true,
    'member:read': true,
    'member:remove': true,
    'member:suspend': true,
    'group:read': true,
    'workspace:list': true,
    'group:manage': true,
    'api_token:manage': true,
  },
};

export const WORKSPACE_CAPABILITIES: Readonly<Record<WorkspaceRole, CapabilityTable>> = {
  owner: {
    'workspace:read': true,
    'workspace:update': true,
    'workspace:archive': true,
    'workspace:delete': true,
    'workspace:manage_members': true,
    'base:create': true,
    'base:read': true,
    'base:update': true,
    'base:delete': true,
    'base:duplicate': true,
    'base:export': { requiresSetting: 'allowExports' },
    'base:manage_members': true,
    'base:share_externally': { requiresSetting: 'allowPublicSharing' },
    'table:create': true,
    'table:update': true,
    'table:delete': true,
    'field:create': true,
    'field:update': true,
    'field:delete': true,
    'record:read': true,
    'record:create': true,
    'record:update': true,
    'record:delete': true,
    'record:restore': true,
    'record:view_history': true,
    'view:create_personal': true,
    'view:create_shared': true,
    'view:update': true,
    'view:delete': true,
    'view:lock': true,
    'view:share': { requiresSetting: 'allowPublicSharing' },
    'comment:read': true,
    'comment:create': true,
    'comment:update_own': true,
    'comment:delete_any': true,
    'form:manage': true,
    'form:submit': true,
    'interface:manage': true,
    'interface:view': true,
    'automation:read': true,
    'automation:manage': true,
    'automation:run': true,
    'webhook:manage': true,
    'integration:manage': true,
  },
  creator: {
    'workspace:read': true,
    'base:create': true,
    'base:read': true,
    'base:update': true,
    'base:duplicate': true,
    'base:export': { requiresSetting: 'allowExports' },
    'base:manage_members': true,
    'base:share_externally': { requiresSetting: 'allowPublicSharing' },
    'table:create': true,
    'table:update': true,
    'table:delete': true,
    'field:create': true,
    'field:update': true,
    'field:delete': true,
    'record:read': true,
    'record:create': true,
    'record:update': true,
    'record:delete': true,
    'record:restore': true,
    'record:view_history': true,
    'view:create_personal': true,
    'view:create_shared': true,
    'view:update': true,
    'view:delete': true,
    'view:lock': true,
    'view:share': { requiresSetting: 'allowPublicSharing' },
    'comment:read': true,
    'comment:create': true,
    'comment:update_own': true,
    'comment:delete_any': true,
    'form:manage': true,
    'form:submit': true,
    'interface:manage': true,
    'interface:view': true,
    'automation:read': true,
    'automation:manage': true,
    'automation:run': true,
    'webhook:manage': true,
  },
  editor: {
    'workspace:read': true,
    'base:read': true,
    'base:export': { requiresSetting: 'allowExports' },
    'record:read': true,
    'record:create': true,
    'record:update': true,
    'record:delete': true,
    'record:restore': true,
    'record:view_history': true,
    'view:create_personal': true,
    'view:create_shared': true,
    'view:update': true,
    'comment:read': true,
    'comment:create': true,
    'comment:update_own': true,
    'form:submit': true,
    'interface:view': true,
    'automation:read': true,
    'automation:run': true,
  },
  commenter: {
    'workspace:read': true,
    'base:read': true,
    'record:read': true,
    'record:view_history': true,
    'view:create_personal': true,
    'comment:read': true,
    'comment:create': true,
    'comment:update_own': true,
    'form:submit': true,
    'interface:view': true,
  },
  viewer: {
    'workspace:read': true,
    'base:read': true,
    'record:read': true,
    'record:view_history': true,
    'view:create_personal': true,
    'comment:read': true,
    'interface:view': true,
  },
  guest: {
    // A guest sees only what an explicit base grant gives them. Workspace-level read is not
    // implied: a guest must never be able to enumerate the workspace tree.
    'base:read': true,
    'record:read': true,
    'comment:read': true,
    'comment:create': true,
    'comment:update_own': true,
    'view:create_personal': true,
    'form:submit': true,
    'interface:view': true,
  },
};

/** Capabilities a public share link can confer on an anonymous principal. */
export const SHARE_CAPABILITIES = {
  view_read: ['record:read', 'base:read'] as const,
  view_read_comment: ['record:read', 'base:read', 'comment:read', 'comment:create'] as const,
  form_submit: ['form:submit'] as const,
  interface_view: ['interface:view', 'record:read'] as const,
  interface_interact: ['interface:view', 'record:read', 'record:create', 'record:update'] as const,
} satisfies Record<string, readonly Action[]>;

export type ShareCapability = keyof typeof SHARE_CAPABILITIES;

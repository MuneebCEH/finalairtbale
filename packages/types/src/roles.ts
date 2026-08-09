/**
 * Role definitions.
 *
 * The capability sets these roles map to live in `@tessera/permissions`, and the mapping is
 * asserted against docs/03-security-and-permissions.md by the permission-matrix test suite —
 * so the documented matrix and the enforced matrix cannot drift apart.
 */

export const ORGANIZATION_ROLES = [
  'owner',
  'admin',
  'member',
  'guest',
  'billing_admin',
  'security_admin',
] as const;

export type OrganizationRole = (typeof ORGANIZATION_ROLES)[number];

export const WORKSPACE_ROLES = [
  'owner',
  'creator',
  'editor',
  'commenter',
  'viewer',
  'guest',
] as const;

export type WorkspaceRole = (typeof WORKSPACE_ROLES)[number];

/** Base membership reuses the workspace vocabulary; a base grant overrides the inherited one. */
export type BaseRole = WorkspaceRole;

/** Ordering used for "at least this role" checks. Higher is more privileged. */
export const WORKSPACE_ROLE_RANK: Readonly<Record<WorkspaceRole, number>> = {
  guest: 0,
  viewer: 1,
  commenter: 2,
  editor: 3,
  creator: 4,
  owner: 5,
};

export const ORGANIZATION_ROLE_RANK: Readonly<Record<OrganizationRole, number>> = {
  guest: 0,
  member: 1,
  billing_admin: 2,
  security_admin: 3,
  admin: 4,
  owner: 5,
};

export function isAtLeastWorkspaceRole(actual: WorkspaceRole, required: WorkspaceRole): boolean {
  return WORKSPACE_ROLE_RANK[actual] >= WORKSPACE_ROLE_RANK[required];
}

/**
 * Deliberately *not* a simple rank comparison: `billing_admin` and `security_admin` are
 * specialised roles, not steps on a ladder. A billing admin is not "more than" a member for
 * membership purposes. Call sites should check capabilities, not ranks; this helper exists only
 * for the small number of genuinely hierarchical checks (owner > admin > member).
 */
export function isAtLeastOrganizationRole(
  actual: OrganizationRole,
  required: 'owner' | 'admin' | 'member',
): boolean {
  const hierarchy: OrganizationRole[] = ['member', 'admin', 'owner'];
  const actualIndex = hierarchy.indexOf(actual);
  const requiredIndex = hierarchy.indexOf(required);
  if (actualIndex === -1 || requiredIndex === -1) return false;
  return actualIndex >= requiredIndex;
}

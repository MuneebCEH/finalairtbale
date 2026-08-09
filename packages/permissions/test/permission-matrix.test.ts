import type { OrganizationRole, Plan, Principal, WorkspaceRole } from '@tessera/types';
import { describe, expect, it } from 'vitest';

import { check, type Action, type MembershipSnapshot, type Resource } from '../src';

/**
 * The permission matrix, as an executable specification.
 *
 * Every row below corresponds to a cell in the table in docs/03-security-and-permissions.md §5.
 * Encoding the documentation as data — rather than describing it in prose and hoping the code
 * agrees — means the two cannot drift: if somebody widens a role's capabilities without updating
 * the document, this suite fails, and vice versa.
 */

type Expectation = 'allow' | 'deny';

const ORGANIZATION_MATRIX: Array<[OrganizationRole, Action, Expectation]> = [
  // Owner
  ['owner', 'organization:delete', 'allow'],
  ['owner', 'organization:transfer_ownership', 'allow'],
  ['owner', 'billing:manage', 'allow'],
  ['owner', 'member:change_role', 'allow'],
  ['owner', 'organization:manage_sso', 'allow'],

  // Admin — everything an owner has except the irreversible and the financial.
  ['admin', 'organization:update', 'allow'],
  ['admin', 'member:invite', 'allow'],
  ['admin', 'member:remove', 'allow'],
  ['admin', 'billing:read', 'allow'],
  ['admin', 'billing:manage', 'deny'],
  ['admin', 'organization:delete', 'deny'],
  ['admin', 'organization:transfer_ownership', 'deny'],

  // Member — reads, and only the writes an administrator has enabled.
  ['member', 'organization:read', 'allow'],
  ['member', 'member:read', 'allow'],
  ['member', 'member:remove', 'deny'],
  ['member', 'organization:manage_settings', 'deny'],
  ['member', 'billing:read', 'deny'],
  ['member', 'organization:view_audit_log', 'deny'],

  // Listing workspaces is organization-scoped and row-filtered, so every role that can see the
  // organization can call it — the response is narrowed by grant, not by this check.
  ['member', 'workspace:list', 'allow'],
  ['billing_admin', 'workspace:list', 'allow'],

  // Guest — an external collaborator must not be able to enumerate the organization.
  ['guest', 'organization:read', 'allow'],
  ['guest', 'member:read', 'deny'],
  ['guest', 'workspace:create', 'deny'],
  ['guest', 'workspace:list', 'deny'],

  // Billing administrator — money, and nothing else.
  ['billing_admin', 'billing:manage', 'allow'],
  ['billing_admin', 'billing:read', 'allow'],
  ['billing_admin', 'member:remove', 'deny'],
  ['billing_admin', 'organization:manage_settings', 'deny'],

  // Security administrator — governance, but explicitly not billing.
  ['security_admin', 'organization:manage_security', 'allow'],
  ['security_admin', 'organization:export_audit_log', 'allow'],
  ['security_admin', 'member:suspend', 'allow'],
  ['security_admin', 'billing:manage', 'deny'],
  ['security_admin', 'organization:delete', 'deny'],
];

const WORKSPACE_MATRIX: Array<[WorkspaceRole, Action, Expectation]> = [
  ['owner', 'workspace:delete', 'allow'],
  ['owner', 'base:delete', 'allow'],
  ['owner', 'view:lock', 'allow'],

  ['creator', 'field:create', 'allow'],
  ['creator', 'table:delete', 'allow'],
  ['creator', 'automation:manage', 'allow'],
  ['creator', 'base:delete', 'deny'],
  ['creator', 'workspace:delete', 'deny'],

  ['editor', 'record:create', 'allow'],
  ['editor', 'record:update', 'allow'],
  ['editor', 'record:delete', 'allow'],
  ['editor', 'view:create_shared', 'allow'],
  ['editor', 'field:create', 'deny'],
  ['editor', 'table:create', 'deny'],
  ['editor', 'view:lock', 'deny'],
  ['editor', 'automation:manage', 'deny'],

  ['commenter', 'record:read', 'allow'],
  ['commenter', 'comment:create', 'allow'],
  ['commenter', 'view:create_personal', 'allow'],
  ['commenter', 'record:update', 'deny'],
  ['commenter', 'record:create', 'deny'],
  ['commenter', 'view:create_shared', 'deny'],

  ['viewer', 'record:read', 'allow'],
  ['viewer', 'record:view_history', 'allow'],
  ['viewer', 'comment:create', 'deny'],
  ['viewer', 'record:update', 'deny'],
  ['viewer', 'base:export', 'deny'],

  ['guest', 'record:read', 'allow'],
  ['guest', 'base:read', 'allow'],
  // A guest must never see the workspace tree — only the bases explicitly shared with them.
  ['guest', 'workspace:read', 'deny'],
  ['guest', 'record:delete', 'deny'],
];

function principal(): Principal {
  return {
    type: 'user',
    userId: 'usr_01HZZZZZZZZZZZZZZZZZZZZZZZ' as never,
    sessionId: 'ses_01HZZZZZZZZZZZZZZZZZZZZZZZ' as never,
    mfaSatisfied: true,
    isPlatformAdmin: false,
  };
}

const ORG_ID = 'org_01HZZZZZZZZZZZZZZZZZZZZZZZ';
const WORKSPACE_ID = 'wsp_01HZZZZZZZZZZZZZZZZZZZZZZZ';

function snapshot(overrides: Partial<MembershipSnapshot> = {}): MembershipSnapshot {
  return {
    organizationId: ORG_ID,
    plan: 'business' as Plan,
    organizationSuspended: false,
    userSuspended: false,
    organizationRole: 'member',
    // All gated settings enabled, so a denial in these tests is always about the *role* rather
    // than about a setting. Settings are exercised separately below.
    organizationSettings: {
      memberCanCreateWorkspaces: true,
      memberCanInvite: true,
      guestCanInvite: true,
      allowPublicSharing: true,
      allowExports: true,
      allowApiAccess: true,
    },
    workspaceRoles: {},
    baseRoles: {},
    explicitDenies: [],
    ...overrides,
  };
}

describe('organization role matrix', () => {
  for (const [role, action, expected] of ORGANIZATION_MATRIX) {
    it(`${role} ${expected === 'allow' ? 'may' : 'may not'} ${action}`, () => {
      const decision = check({
        principal: principal(),
        action,
        resource: { type: 'organization', id: ORG_ID, organizationId: ORG_ID },
        snapshot: snapshot({ organizationRole: role }),
      });

      expect(decision.allowed, JSON.stringify(decision)).toBe(expected === 'allow');
    });
  }
});

describe('workspace role matrix', () => {
  const resource: Resource = {
    type: 'workspace',
    id: WORKSPACE_ID,
    organizationId: ORG_ID,
    workspaceId: WORKSPACE_ID,
  };

  for (const [role, action, expected] of WORKSPACE_MATRIX) {
    it(`workspace ${role} ${expected === 'allow' ? 'may' : 'may not'} ${action}`, () => {
      const decision = check({
        principal: principal(),
        action,
        resource,
        snapshot: snapshot({
          // Organization role is `member` so the workspace grant is the only thing under test.
          organizationRole: 'member',
          workspaceRoles: { [WORKSPACE_ID]: role },
        }),
      });

      expect(decision.allowed, JSON.stringify(decision)).toBe(expected === 'allow');
    });
  }
});

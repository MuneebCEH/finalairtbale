import type { OrganizationRole, Plan, Principal, Scope, WorkspaceRole } from '@tessera/types';
import { PLAN_ENTITLEMENTS } from '@tessera/types';

import type { Action, Resource } from './actions';
import { ORGANIZATION_SCOPED_ACTIONS, WRITE_ACTIONS } from './actions';
import {
  ORGANIZATION_CAPABILITIES,
  SHARE_CAPABILITIES,
  WORKSPACE_CAPABILITIES,
  type CapabilityTable,
  type ConditionalGrant,
  type OrganizationSettingKey,
  type ShareCapability,
} from './capabilities';

/**
 * The policy engine.
 *
 * It is a **pure function** of (principal, action, resource, snapshot). It performs no I/O, so it
 * is exhaustively testable, cheap to call in a loop, and impossible to accidentally couple to
 * request state. Loading the snapshot is the caller's job — see `MembershipLoader` in
 * `@tessera/database`, which caches it per (principal, organization) for 60 seconds.
 *
 * Resolution order (docs/03-security-and-permissions.md §4):
 *   1. platform suspension
 *   2. explicit field/record-level deny
 *   3. resource-level explicit grant (base ACL)
 *   4. workspace role
 *   5. organization role
 *   6. group grants
 *   7. share-link capability (anonymous)
 *   8. default deny
 */

export interface MembershipSnapshot {
  readonly organizationId: string;
  readonly plan: Plan;
  readonly organizationSuspended: boolean;
  readonly userSuspended: boolean;
  /** Null when the principal is not a member of the organization at all. */
  readonly organizationRole: OrganizationRole | null;
  readonly organizationSettings: Readonly<Partial<Record<OrganizationSettingKey, boolean>>>;
  /** workspaceId → role, including roles inherited from group membership. */
  readonly workspaceRoles: Readonly<Record<string, WorkspaceRole>>;
  /** baseId → role. A base grant overrides the workspace role for that base. */
  readonly baseRoles: Readonly<Record<string, WorkspaceRole>>;
  /** Explicit denies win over everything except platform suspension. */
  readonly explicitDenies: readonly { readonly resourceId: string; readonly action: Action }[];
  /** Present only for anonymous principals arriving through a share link. */
  readonly share?: {
    readonly id: string;
    readonly capability: ShareCapability;
    readonly resourceId: string;
    readonly expiresAt: string | null;
    readonly revoked: boolean;
  };
}

export type DenyReason =
  | 'organization_suspended'
  | 'user_suspended'
  | 'not_a_member'
  | 'explicit_deny'
  | 'insufficient_role'
  | 'setting_disabled'
  | 'plan_restriction'
  | 'scope_missing'
  | 'mfa_required'
  | 'share_expired'
  | 'share_scope'
  | 'read_only_principal'
  | 'unknown_resource';

export interface Grant {
  readonly source: 'organization_role' | 'workspace_role' | 'base_role' | 'share' | 'platform_admin';
  readonly detail: string;
}

export type Decision =
  | { readonly allowed: true; readonly via: readonly Grant[] }
  | { readonly allowed: false; readonly reason: DenyReason; readonly explanation: string };

export interface PolicyInput {
  readonly principal: Principal;
  readonly action: Action;
  readonly resource: Resource;
  readonly snapshot: MembershipSnapshot;
  /** True when the organization enforces MFA and the session has not satisfied it. */
  readonly mfaRequiredButUnsatisfied?: boolean;
}

const allow = (via: Grant[]): Decision => ({ allowed: true, via });
const deny = (reason: DenyReason, explanation: string): Decision => ({
  allowed: false,
  reason,
  explanation,
});

/** Maps an API scope requirement onto an action. Token principals must hold the scope *and* the role. */
const ACTION_SCOPE: Readonly<Partial<Record<Action, Scope>>> = {
  'record:read': 'data:read',
  'record:create': 'data:write',
  'record:update': 'data:write',
  'record:delete': 'data:write',
  'record:restore': 'data:write',
  'table:create': 'schema:write',
  'table:update': 'schema:write',
  'table:delete': 'schema:write',
  'field:create': 'schema:write',
  'field:update': 'schema:write',
  'field:delete': 'schema:write',
  'webhook:manage': 'webhook:manage',
  'automation:read': 'automation:read',
  'automation:run': 'automation:run',
  'organization:update': 'org:admin',
  'member:invite': 'org:admin',
  'member:remove': 'org:admin',
};

/** Capabilities that a plan gates regardless of role. */
const PLAN_GATED_ACTIONS: Readonly<Partial<Record<Action, keyof typeof PLAN_ENTITLEMENTS.free>>> = {
  'interface:manage': 'interfaces',
  'organization:export_audit_log': 'auditLogExport',
  'organization:manage_sso': 'sso',
};

export function check(input: PolicyInput): Decision {
  const { principal, action, resource, snapshot } = input;

  // ── 1. Platform-level blocks ───────────────────────────────────────────────
  if (snapshot.organizationSuspended) {
    return deny('organization_suspended', 'This organization is suspended.');
  }
  if (snapshot.userSuspended) {
    return deny('user_suspended', 'Your account is suspended in this organization.');
  }

  // Cross-tenant attempt. Should be unreachable — the repository layer scopes by organization —
  // but authorization must not assume another layer did its job.
  if (resource.organizationId !== snapshot.organizationId) {
    return deny('unknown_resource', 'The resource does not belong to this organization.');
  }

  // ── Platform administrators ────────────────────────────────────────────────
  if (principal.type === 'user' && principal.isPlatformAdmin && action.startsWith('platform:')) {
    return allow([{ source: 'platform_admin', detail: 'platform administrator' }]);
  }
  if (action.startsWith('platform:')) {
    return deny('insufficient_role', 'Platform administration requires an elevated account.');
  }

  // ── Anonymous / share-link principals ──────────────────────────────────────
  if (principal.type === 'anonymous') {
    return checkShare(input);
  }

  // ── Service principals ─────────────────────────────────────────────────────
  if (principal.type === 'service') {
    // Internal callers are trusted for the action set they request, but never for platform
    // administration (handled above) and never outside a tenant context.
    return allow([{ source: 'platform_admin', detail: `service:${principal.service}` }]);
  }

  // ── 1b. MFA enforcement ────────────────────────────────────────────────────
  if (input.mfaRequiredButUnsatisfied && WRITE_ACTIONS.has(action)) {
    return deny('mfa_required', 'This organization requires two-factor authentication.');
  }

  // ── Token scope check (applies before role resolution) ─────────────────────
  if (principal.type === 'api_token' || principal.type === 'oauth') {
    const required = ACTION_SCOPE[action];
    if (required && !principal.scopes.includes(required)) {
      return deny('scope_missing', `This token is missing the "${required}" scope.`);
    }
  }

  // ── 2. Explicit denies ─────────────────────────────────────────────────────
  const denied = snapshot.explicitDenies.some(
    (d) => d.action === action && (d.resourceId === resource.id || d.resourceId === resource.baseId),
  );
  if (denied) {
    return deny('explicit_deny', 'Access to this resource has been explicitly revoked for you.');
  }

  // ── Plan gating ────────────────────────────────────────────────────────────
  const gate = PLAN_GATED_ACTIONS[action];
  if (gate) {
    const entitlement = PLAN_ENTITLEMENTS[snapshot.plan][gate];
    if (entitlement === false) {
      return deny('plan_restriction', `The ${snapshot.plan} plan does not include this feature.`);
    }
  }

  if (snapshot.organizationRole === null) {
    return deny('not_a_member', 'You are not a member of this organization.');
  }

  // ── 3–5. Resource-scoped roles, most specific first ────────────────────────
  if (!ORGANIZATION_SCOPED_ACTIONS.has(action)) {
    const baseId = resource.type === 'base' ? resource.id : resource.baseId;
    if (baseId) {
      const baseRole = snapshot.baseRoles[baseId];
      if (baseRole) {
        const decision = evaluate(WORKSPACE_CAPABILITIES[baseRole], action, snapshot);
        if (decision.kind === 'allow') {
          return allow([{ source: 'base_role', detail: `base role "${baseRole}"` }]);
        }
        if (decision.kind === 'setting') {
          return deny(
            'setting_disabled',
            `Your role allows this, but the organization setting "${decision.setting}" is disabled.`,
          );
        }
        // Fall through: a base grant adds permissions, it does not cap the workspace role.
      }
    }

    const workspaceId = resource.type === 'workspace' ? resource.id : resource.workspaceId;
    if (workspaceId) {
      const workspaceRole = snapshot.workspaceRoles[workspaceId];
      if (workspaceRole) {
        const decision = evaluate(WORKSPACE_CAPABILITIES[workspaceRole], action, snapshot);
        if (decision.kind === 'allow') {
          return allow([{ source: 'workspace_role', detail: `workspace role "${workspaceRole}"` }]);
        }
        if (decision.kind === 'setting') {
          return deny(
            'setting_disabled',
            `Your role allows this, but the organization setting "${decision.setting}" is disabled.`,
          );
        }
      }
    }
  }

  // Organization owners and admins inherit workspace capability across their organization,
  // except for the destructive base/workspace deletions that owners alone may perform.
  const orgRole = snapshot.organizationRole;
  if ((orgRole === 'owner' || orgRole === 'admin') && !ORGANIZATION_SCOPED_ACTIONS.has(action)) {
    const inheritedRole: WorkspaceRole = orgRole === 'owner' ? 'owner' : 'creator';
    const decision = evaluate(WORKSPACE_CAPABILITIES[inheritedRole], action, snapshot);
    if (decision.kind === 'allow') {
      return allow([
        { source: 'organization_role', detail: `organization ${orgRole} (inherits ${inheritedRole})` },
      ]);
    }
    if (decision.kind === 'setting') {
      return deny(
        'setting_disabled',
        `Your role allows this, but the organization setting "${decision.setting}" is disabled.`,
      );
    }
  }

  const orgDecision = evaluate(ORGANIZATION_CAPABILITIES[orgRole], action, snapshot);
  if (orgDecision.kind === 'allow') {
    return allow([{ source: 'organization_role', detail: `organization role "${orgRole}"` }]);
  }
  if (orgDecision.kind === 'setting') {
    return deny(
      'setting_disabled',
      `Your role allows this, but the organization setting "${orgDecision.setting}" is disabled.`,
    );
  }

  // ── 8. Default deny ────────────────────────────────────────────────────────
  return deny(
    'insufficient_role',
    `Your role "${orgRole}" does not grant "${action}" on this ${resource.type}.`,
  );
}

type CapabilityOutcome =
  | { kind: 'allow' }
  | { kind: 'setting'; setting: OrganizationSettingKey }
  | { kind: 'absent' };

function evaluate(
  table: CapabilityTable,
  action: Action,
  snapshot: MembershipSnapshot,
): CapabilityOutcome {
  const grant: ConditionalGrant | undefined = table[action];
  if (grant === undefined) return { kind: 'absent' };
  if (grant === true) return { kind: 'allow' };
  const enabled = snapshot.organizationSettings[grant.requiresSetting];
  return enabled === false ? { kind: 'setting', setting: grant.requiresSetting } : { kind: 'allow' };
}

function checkShare(input: PolicyInput): Decision {
  const { action, resource, snapshot } = input;
  const share = snapshot.share;

  if (!share) {
    return deny('not_a_member', 'This resource is not publicly shared.');
  }
  if (share.revoked) {
    return deny('share_expired', 'This share link has been revoked.');
  }
  if (share.expiresAt && new Date(share.expiresAt).getTime() <= Date.now()) {
    return deny('share_expired', 'This share link has expired.');
  }
  if (share.resourceId !== resource.id && share.resourceId !== resource.baseId) {
    return deny('share_scope', 'This share link does not cover the requested resource.');
  }

  const permitted: readonly Action[] = SHARE_CAPABILITIES[share.capability];
  if (!permitted.includes(action)) {
    return deny('share_scope', `This share link permits only: ${permitted.join(', ')}.`);
  }

  return allow([{ source: 'share', detail: `share link (${share.capability})` }]);
}

/** Convenience wrapper used by guards: throws nothing, returns a boolean. */
export function can(input: PolicyInput): boolean {
  return check(input).allowed;
}

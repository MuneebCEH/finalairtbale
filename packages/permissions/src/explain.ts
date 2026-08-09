import { ForbiddenError } from '@tessera/types';

import type { Action, Resource } from './actions';
import { check, type Decision, type MembershipSnapshot, type PolicyInput } from './policy-engine';

/**
 * The permission inspector.
 *
 * "Why can't I edit this?" is the single most common support question a permissions system
 * generates, and the usual answer — a bare 403 — is useless to both the user and the
 * administrator. This produces a human-readable trace of the decision, which is surfaced in the
 * UI and exposed at `GET /v1/permissions/explain`.
 */

export interface Explanation {
  readonly allowed: boolean;
  readonly summary: string;
  readonly action: Action;
  readonly resource: { readonly type: string; readonly id: string };
  readonly grants: readonly string[];
  readonly reason?: string;
  /** Concrete, actionable next steps rather than "contact your administrator". */
  readonly remediation: readonly string[];
}

export function explain(input: PolicyInput): Explanation {
  const decision = check(input);
  const base = {
    action: input.action,
    resource: { type: input.resource.type, id: input.resource.id },
  } as const;

  if (decision.allowed) {
    return {
      ...base,
      allowed: true,
      summary: `Allowed via ${decision.via.map((g) => g.detail).join(' and ')}.`,
      grants: decision.via.map((g) => `${g.source}: ${g.detail}`),
      remediation: [],
    };
  }

  return {
    ...base,
    allowed: false,
    summary: decision.explanation,
    grants: [],
    reason: decision.reason,
    remediation: remediationFor(decision, input.snapshot),
  };
}

function remediationFor(
  decision: Extract<Decision, { allowed: false }>,
  snapshot: MembershipSnapshot,
): string[] {
  switch (decision.reason) {
    case 'organization_suspended':
      return ['An organization owner or billing administrator must resolve the account status.'];
    case 'user_suspended':
      return ['An organization administrator can reinstate your membership.'];
    case 'not_a_member':
      return ['Ask an organization administrator to invite you.'];
    case 'explicit_deny':
      return ['An administrator has revoked your access to this specific resource; only they can restore it.'];
    case 'insufficient_role':
      return [
        `Your organization role is "${snapshot.organizationRole ?? 'none'}".`,
        'Ask a workspace owner to grant you a higher role on this workspace or base.',
      ];
    case 'setting_disabled':
      return ['An organization administrator can enable this in organization settings.'];
    case 'plan_restriction':
      return [`This feature requires a higher plan than "${snapshot.plan}".`];
    case 'scope_missing':
      return ['Create a new API token that includes the required scope.'];
    case 'mfa_required':
      return ['Enrol an authenticator app in your security settings, then sign in again.'];
    case 'share_expired':
      return ['Ask the person who shared this link for a new one.'];
    case 'share_scope':
      return ['This link grants limited access. Sign in with an account that has access.'];
    case 'read_only_principal':
      return ['This credential is read-only.'];
    case 'unknown_resource':
      return [];
  }
}

/**
 * Assertion helper used by guards and services. Throws a `ForbiddenError` carrying the deny
 * reason and remediation, so the client can render something useful instead of "Forbidden".
 */
export function assertAllowed(input: PolicyInput): void {
  const decision = check(input);
  if (decision.allowed) return;

  const explanation = explain(input);
  throw new ForbiddenError(decision.explanation, {
    reason: decision.reason,
    action: input.action,
    resourceType: input.resource.type,
    remediation: explanation.remediation,
  });
}

/**
 * Filters a list of resources to those the principal may act on. Used for list endpoints so a
 * response never contains an item the caller could not fetch individually.
 *
 * Note: this is a *post-filter*, appropriate only for small collections already scoped by the
 * repository. Row-level restrictions on large tables are pushed into SQL instead — post-filtering
 * a paginated query produces short pages and broken cursors.
 */
export function filterAllowed<T extends Resource>(
  resources: readonly T[],
  action: Action,
  base: Omit<PolicyInput, 'resource' | 'action'>,
): T[] {
  return resources.filter((resource) => check({ ...base, action, resource }).allowed);
}

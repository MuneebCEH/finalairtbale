import { SCOPES, type Principal, type Scope } from '@tessera/types';

import { ACTIONS, type Action } from './actions';

/**
 * Scope enforcement for API tokens and OAuth grants.
 *
 * ## Why this exists separately from the role check
 *
 * A token carries two independent limits: what its *owner* may do (their role) and what the
 * *token* is allowed to do (its scopes). Both must hold. A read-only token issued by an owner
 * must not be able to write, and a full-scope token issued by a viewer must not be able to
 * either. Checking only the role means the scope list on the token-creation screen is decoration;
 * checking only the scope means anybody can mint themselves an admin token.
 *
 * An unenforced scope is worse than no scope at all: it advertises a restriction that does not
 * exist, so people hand out tokens believing they are limited.
 */

/**
 * The scope an action requires.
 *
 * Derived from the action's resource and verb rather than listed one by one — a table with two
 * hundred entries goes stale silently, and a missing entry would mean an action nobody can reach
 * or, worse, one that requires nothing. `requiredScope` throws for an unmapped action instead of
 * defaulting, so a new action cannot slip through unguarded.
 */
const SCOPE_BY_RESOURCE: Readonly<Record<string, { read: Scope; write: Scope }>> = {
  organization: { read: 'org:admin', write: 'org:admin' },
  member: { read: 'user:read', write: 'org:admin' },
  group: { read: 'user:read', write: 'org:admin' },
  billing: { read: 'org:admin', write: 'org:admin' },
  workspace: { read: 'schema:read', write: 'schema:write' },
  base: { read: 'schema:read', write: 'schema:write' },
  table: { read: 'schema:read', write: 'schema:write' },
  field: { read: 'schema:read', write: 'schema:write' },
  view: { read: 'schema:read', write: 'schema:write' },
  form: { read: 'schema:read', write: 'schema:write' },
  interface: { read: 'schema:read', write: 'schema:write' },
  record: { read: 'data:read', write: 'data:write' },
  comment: { read: 'data:read', write: 'data:write' },
  attachment: { read: 'data:read', write: 'data:write' },
  webhook: { read: 'webhook:manage', write: 'webhook:manage' },
  automation: { read: 'automation:read', write: 'automation:run' },
  user: { read: 'user:read', write: 'user:read' },
  share: { read: 'schema:read', write: 'schema:write' },
  api_token: { read: 'org:admin', write: 'org:admin' },
  integration: { read: 'org:admin', write: 'org:admin' },
};

/**
 * Platform actions are administrative operations across every tenant — reading platform state,
 * changing it, impersonating a user. No API token may reach them at any scope, including
 * `org:admin`, which is an *organization* administrator and not a platform one. Conflating the
 * two would let any customer's admin token act on every other customer.
 */
const TOKEN_FORBIDDEN_RESOURCES = new Set(['platform']);

/** Verbs that only observe. Everything else is treated as a write. */
const READ_VERBS = new Set(['read', 'list', 'view_audit_log', 'export_audit_log', 'export']);

/** True when no token scope can reach the action, whatever it holds. */
export function isTokenForbidden(action: Action): boolean {
  return TOKEN_FORBIDDEN_RESOURCES.has(action.split(':')[0] as string);
}

export function requiredScope(action: Action): Scope {
  const [resource, verb] = action.split(':') as [string, string];

  // Platform actions have no scope because none may reach them; reporting one would suggest a
  // token could be minted that does.
  if (TOKEN_FORBIDDEN_RESOURCES.has(resource)) return 'org:admin';

  const mapping = SCOPE_BY_RESOURCE[resource];

  // Deliberately fatal rather than defaulting. A default of `org:admin` would lock out a
  // legitimate token; a default of `data:read` would leave a new action effectively unguarded.
  // Either way the mistake would be invisible, so it is made loud at the first call instead.
  if (!mapping) {
    throw new Error(`No scope is defined for the action "${action}". Add its resource to SCOPE_BY_RESOURCE.`);
  }

  return READ_VERBS.has(verb) ? mapping.read : mapping.write;
}

/**
 * Whether a principal's scopes permit an action.
 *
 * A user session has no scopes and is unrestricted here — the role check is its only limit.
 * Tokens and OAuth grants carry a scope list and are held to it.
 */
export function scopeAllows(principal: Principal, action: Action): boolean {
  if (principal.type === 'user' || principal.type === 'service') return true;
  if (principal.type === 'anonymous') return false;

  // Checked before the scope list: an `org:admin` token is an organization administrator, not a
  // platform one, and must not reach across tenants.
  if (isTokenForbidden(action)) return false;

  const held = (principal as { scopes?: readonly Scope[] }).scopes ?? [];
  const needed = requiredScope(action);

  if (held.includes(needed)) return true;

  // `org:admin` implies the rest: an administrative token that could not read data would be
  // useless, and the alternative is making every caller list nine scopes.
  if (held.includes('org:admin')) return true;

  // No implication between write and read. `data:write` does not grant `data:read`: a caller that
  // needs both asks for both, which is what the policy engine enforces on the request path. An
  // implication here would have this module disagree with the engine — and when two authorization
  // rules disagree, the looser one is the one that decides.
  return false;
}

/** Validates a requested scope list when a token is minted. */
export function parseScopes(requested: readonly string[]): { ok: true; scopes: Scope[] } | { ok: false; unknown: string[] } {
  const unknown = requested.filter((scope) => !SCOPES.includes(scope as Scope));
  if (unknown.length > 0) return { ok: false, unknown };

  // De-duplicated and ordered so two tokens asking for the same access store the same list —
  // which makes them comparable in an audit log and in the UI.
  const scopes = [...new Set(requested as Scope[])].sort();
  return { ok: true, scopes };
}

/**
 * Every action reachable with a given scope set. Used to describe a token in the UI, and by the
 * test that proves each action maps to something.
 */
export function actionsForScopes(scopes: readonly Scope[]): Action[] {
  return ACTIONS.filter((action) => {
    try {
      return scopeAllows({ type: 'api_token', scopes } as unknown as Principal, action);
    } catch {
      return false;
    }
  });
}

import { SCOPES, type Principal, type Scope } from '@tessera/types';
import { describe, expect, it } from 'vitest';

import { ACTIONS } from '../src/actions';
import { actionsForScopes, isTokenForbidden, parseScopes, requiredScope, scopeAllows } from '../src/scopes';

/**
 * An unenforced scope is worse than no scope: it advertises a restriction that does not exist, so
 * people hand out tokens believing they are limited. These tests hold the enforcement to that.
 */

const token = (scopes: Scope[]): Principal =>
  ({ type: 'api_token', scopes }) as unknown as Principal;

describe('every action maps to a scope', () => {
  // The guard against a new action slipping through unguarded — the failure mode where an
  // endpoint exists that no scope restricts.
  for (const action of ACTIONS) {
    it(action, () => {
      expect(() => requiredScope(action)).not.toThrow();
      expect(SCOPES).toContain(requiredScope(action));
    });
  }

  it('refuses loudly for an action nobody mapped', () => {
    expect(() => requiredScope('telepathy:invoke' as never)).toThrow(/No scope is defined/);
  });
});

describe('read and write are distinguished', () => {
  it('gives reads a read scope and writes a write scope', () => {
    expect(requiredScope('record:read')).toBe('data:read');
    expect(requiredScope('record:update')).toBe('data:write');
    expect(requiredScope('field:read')).toBe('schema:read');
    expect(requiredScope('field:create')).toBe('schema:write');
  });
});

describe('scopeAllows', () => {
  it('permits an action the token holds the scope for', () => {
    expect(scopeAllows(token(['data:read']), 'record:read')).toBe(true);
  });

  it('refuses a write to a read-only token', () => {
    // The whole point: a read-only token issued by an owner must not be able to write.
    expect(scopeAllows(token(['data:read']), 'record:update')).toBe(false);
    expect(scopeAllows(token(['data:read']), 'record:delete')).toBe(false);
  });

  it('refuses an unrelated resource', () => {
    expect(scopeAllows(token(['data:read']), 'field:create')).toBe(false);
    expect(scopeAllows(token(['schema:write']), 'record:update')).toBe(false);
  });

  it('does not let a write scope imply a read', () => {
    // Scopes are explicit. An earlier draft granted read from write, which disagreed with the
    // policy engine on the request path — and when two authorization rules disagree, the looser
    // one decides. A caller that needs both asks for both.
    expect(scopeAllows(token(['data:write']), 'record:read')).toBe(false);
    expect(scopeAllows(token(['data:read', 'data:write']), 'record:read')).toBe(true);
  });

  it('does not let a read scope imply a write', () => {
    expect(scopeAllows(token(['schema:read']), 'field:create')).toBe(false);
  });

  it('treats org:admin as covering everything an organization owns', () => {
    for (const action of ACTIONS.filter((a) => !isTokenForbidden(a))) {
      expect(scopeAllows(token(['org:admin']), action), action).toBe(true);
    }
  });

  it('refuses platform actions to every token, including org:admin', () => {
    // `org:admin` is an *organization* administrator. Conflating that with a platform one would
    // let any customer's admin token act on every other customer.
    for (const action of ACTIONS.filter(isTokenForbidden)) {
      expect(scopeAllows(token(['org:admin']), action), action).toBe(false);
    }
    expect(isTokenForbidden('platform:impersonate')).toBe(true);
    expect(isTokenForbidden('record:read')).toBe(false);
  });

  it('refuses a token with no scopes at all', () => {
    expect(scopeAllows(token([]), 'record:read')).toBe(false);
  });

  it('leaves a user session to the role check', () => {
    // A signed-in person has no scopes; their role is the only limit that applies.
    const user = { type: 'user', userId: 'usr_1' } as unknown as Principal;
    expect(scopeAllows(user, 'record:update')).toBe(true);
  });

  it('refuses an anonymous principal outright', () => {
    const anonymous = { type: 'anonymous' } as unknown as Principal;
    expect(scopeAllows(anonymous, 'record:read')).toBe(false);
  });
});

describe('parseScopes', () => {
  it('accepts known scopes', () => {
    expect(parseScopes(['data:read', 'data:write'])).toEqual({
      ok: true,
      scopes: ['data:read', 'data:write'],
    });
  });

  it('names the ones it does not know', () => {
    const result = parseScopes(['data:read', 'everything', 'root']);
    expect(result).toEqual({ ok: false, unknown: ['everything', 'root'] });
  });

  it('de-duplicates and orders, so two equal tokens store the same list', () => {
    // Comparable in an audit log and in the UI.
    expect(parseScopes(['data:write', 'data:read', 'data:write'])).toEqual({
      ok: true,
      scopes: ['data:read', 'data:write'],
    });
  });

  it('accepts an empty list, which grants nothing', () => {
    expect(parseScopes([])).toEqual({ ok: true, scopes: [] });
    expect(scopeAllows(token([]), 'record:read')).toBe(false);
  });
});

describe('actionsForScopes', () => {
  it('describes what a token can do', () => {
    const readOnly = actionsForScopes(['data:read']);
    expect(readOnly).toContain('record:read');
    expect(readOnly).not.toContain('record:update');
  });

  it('reports everything an admin token can reach, and not the platform actions', () => {
    const reachable = actionsForScopes(['org:admin']);
    expect(reachable.length).toBe(ACTIONS.filter((a) => !isTokenForbidden(a)).length);
    expect(reachable.some(isTokenForbidden)).toBe(false);
  });

  it('reports nothing for an empty scope set', () => {
    expect(actionsForScopes([])).toEqual([]);
  });
});

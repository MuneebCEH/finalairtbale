import type { Principal } from '@tessera/types';
import { describe, expect, it } from 'vitest';

import { check, explain, type MembershipSnapshot } from '../src';

/**
 * Behaviour of the policy engine beyond the role matrix: the precedence rules, the escape
 * hatches, and the cases where a decision must be denied for a reason other than role.
 */

const ORG_A = 'org_01HAAAAAAAAAAAAAAAAAAAAAAA';
const ORG_B = 'org_01HBBBBBBBBBBBBBBBBBBBBBBB';
const WORKSPACE = 'wsp_01HWWWWWWWWWWWWWWWWWWWWWWW';
const BASE = 'bas_01HBASEBASEBASEBASEBASEBA';

const user: Principal = {
  type: 'user',
  userId: 'usr_01HUUUUUUUUUUUUUUUUUUUUUUU' as never,
  sessionId: 'ses_01HSSSSSSSSSSSSSSSSSSSSSSS' as never,
  mfaSatisfied: true,
  isPlatformAdmin: false,
};

function snapshot(overrides: Partial<MembershipSnapshot> = {}): MembershipSnapshot {
  return {
    organizationId: ORG_A,
    plan: 'business',
    organizationSuspended: false,
    userSuspended: false,
    organizationRole: 'member',
    organizationSettings: {
      memberCanCreateWorkspaces: true,
      memberCanInvite: true,
      allowExports: true,
      allowPublicSharing: true,
    },
    workspaceRoles: {},
    baseRoles: {},
    explicitDenies: [],
    ...overrides,
  };
}

describe('tenant boundary', () => {
  it('denies a resource belonging to a different organization', () => {
    // This is the case the repository layer should already have made impossible. Authorization
    // still checks it, because a control that assumes another layer did its job is not a control.
    const decision = check({
      principal: user,
      action: 'record:read',
      resource: { type: 'record', id: 'rec_1', organizationId: ORG_B },
      snapshot: snapshot({ organizationRole: 'owner' }),
    });

    expect(decision.allowed).toBe(false);
    if (!decision.allowed) expect(decision.reason).toBe('unknown_resource');
  });

  it('denies a non-member outright', () => {
    const decision = check({
      principal: user,
      action: 'organization:read',
      resource: { type: 'organization', id: ORG_A, organizationId: ORG_A },
      snapshot: snapshot({ organizationRole: null }),
    });

    expect(decision.allowed).toBe(false);
    if (!decision.allowed) expect(decision.reason).toBe('not_a_member');
  });
});

describe('precedence', () => {
  it('lets a base grant add permissions the workspace role does not carry', () => {
    const decision = check({
      principal: user,
      action: 'field:create',
      resource: { type: 'base', id: BASE, organizationId: ORG_A, workspaceId: WORKSPACE, baseId: BASE },
      snapshot: snapshot({
        workspaceRoles: { [WORKSPACE]: 'viewer' },
        baseRoles: { [BASE]: 'creator' },
      }),
    });

    expect(decision.allowed).toBe(true);
    if (decision.allowed) expect(decision.via[0]?.source).toBe('base_role');
  });

  it('does not let a base grant cap a broader workspace role', () => {
    // A grant is additive. Somebody who is a workspace owner does not lose the ability to delete
    // a base because they were also, redundantly, added to it as a viewer.
    const decision = check({
      principal: user,
      action: 'base:delete',
      resource: { type: 'base', id: BASE, organizationId: ORG_A, workspaceId: WORKSPACE, baseId: BASE },
      snapshot: snapshot({
        workspaceRoles: { [WORKSPACE]: 'owner' },
        baseRoles: { [BASE]: 'viewer' },
      }),
    });

    expect(decision.allowed).toBe(true);
  });

  it('honours an explicit deny over every grant', () => {
    const decision = check({
      principal: user,
      action: 'record:read',
      resource: { type: 'base', id: BASE, organizationId: ORG_A, baseId: BASE },
      snapshot: snapshot({
        organizationRole: 'owner',
        baseRoles: { [BASE]: 'owner' },
        explicitDenies: [{ resourceId: BASE, action: 'record:read' }],
      }),
    });

    expect(decision.allowed).toBe(false);
    if (!decision.allowed) expect(decision.reason).toBe('explicit_deny');
  });

  it('denies everything to a suspended organization, including reads by the owner', () => {
    const decision = check({
      principal: user,
      action: 'organization:read',
      resource: { type: 'organization', id: ORG_A, organizationId: ORG_A },
      snapshot: snapshot({ organizationRole: 'owner', organizationSuspended: true }),
    });

    expect(decision.allowed).toBe(false);
    if (!decision.allowed) expect(decision.reason).toBe('organization_suspended');
  });
});

describe('organization settings', () => {
  it('withholds a role-granted capability when its setting is disabled', () => {
    const decision = check({
      principal: user,
      action: 'workspace:create',
      resource: { type: 'organization', id: ORG_A, organizationId: ORG_A },
      snapshot: snapshot({
        organizationRole: 'member',
        organizationSettings: { memberCanCreateWorkspaces: false },
      }),
    });

    expect(decision.allowed).toBe(false);
    if (!decision.allowed) expect(decision.reason).toBe('setting_disabled');
  });

  it('does not apply the setting to an administrator', () => {
    const decision = check({
      principal: user,
      action: 'workspace:create',
      resource: { type: 'organization', id: ORG_A, organizationId: ORG_A },
      snapshot: snapshot({
        organizationRole: 'admin',
        organizationSettings: { memberCanCreateWorkspaces: false },
      }),
    });

    expect(decision.allowed).toBe(true);
  });
});

describe('API tokens', () => {
  it('denies an action whose scope the token does not hold', () => {
    const token: Principal = {
      type: 'api_token',
      tokenId: 'tok_1',
      userId: 'usr_01HUUUUUUUUUUUUUUUUUUUUUUU' as never,
      scopes: ['data:read'],
    };

    const decision = check({
      principal: token,
      action: 'record:update',
      resource: { type: 'record', id: 'rec_1', organizationId: ORG_A, baseId: BASE },
      snapshot: snapshot({ organizationRole: 'owner', baseRoles: { [BASE]: 'owner' } }),
    });

    expect(decision.allowed).toBe(false);
    if (!decision.allowed) expect(decision.reason).toBe('scope_missing');
  });

  it('still requires the underlying role even when the scope is present', () => {
    // A token cannot grant its owner more than the owner has. Scope narrows; it never widens.
    const token: Principal = {
      type: 'api_token',
      tokenId: 'tok_1',
      userId: 'usr_01HUUUUUUUUUUUUUUUUUUUUUUU' as never,
      scopes: ['data:write'],
    };

    const decision = check({
      principal: token,
      action: 'record:update',
      resource: { type: 'base', id: BASE, organizationId: ORG_A, baseId: BASE },
      snapshot: snapshot({ organizationRole: 'member', baseRoles: { [BASE]: 'viewer' } }),
    });

    expect(decision.allowed).toBe(false);
    if (!decision.allowed) expect(decision.reason).toBe('insufficient_role');
  });
});

describe('share links', () => {
  const anonymous: Principal = { type: 'anonymous', shareId: 'shr_1' };

  it('grants exactly the share capability and nothing more', () => {
    const base = snapshot({
      organizationRole: null,
      share: {
        id: 'shr_1',
        capability: 'view_read',
        resourceId: BASE,
        expiresAt: null,
        revoked: false,
      },
    });
    const resource = { type: 'base', id: BASE, organizationId: ORG_A, baseId: BASE } as const;

    expect(check({ principal: anonymous, action: 'record:read', resource, snapshot: base }).allowed).toBe(true);
    expect(check({ principal: anonymous, action: 'record:update', resource, snapshot: base }).allowed).toBe(false);
  });

  it('rejects an expired link', () => {
    const decision = check({
      principal: anonymous,
      action: 'record:read',
      resource: { type: 'base', id: BASE, organizationId: ORG_A, baseId: BASE },
      snapshot: snapshot({
        organizationRole: null,
        share: {
          id: 'shr_1',
          capability: 'view_read',
          resourceId: BASE,
          expiresAt: new Date(Date.now() - 1_000).toISOString(),
          revoked: false,
        },
      }),
    });

    expect(decision.allowed).toBe(false);
    if (!decision.allowed) expect(decision.reason).toBe('share_expired');
  });
});

describe('two-factor enforcement', () => {
  it('blocks writes but not reads when the organization requires MFA and the session lacks it', () => {
    const resource = { type: 'base', id: BASE, organizationId: ORG_A, baseId: BASE } as const;
    const snap = snapshot({ organizationRole: 'owner', baseRoles: { [BASE]: 'owner' } });

    const write = check({
      principal: user,
      action: 'record:update',
      resource,
      snapshot: snap,
      mfaRequiredButUnsatisfied: true,
    });
    const read = check({
      principal: user,
      action: 'record:read',
      resource,
      snapshot: snap,
      mfaRequiredButUnsatisfied: true,
    });

    expect(write.allowed).toBe(false);
    if (!write.allowed) expect(write.reason).toBe('mfa_required');
    expect(read.allowed).toBe(true);
  });
});

describe('explanations', () => {
  it('tells a denied user what to do about it', () => {
    const explanation = explain({
      principal: user,
      action: 'record:update',
      resource: { type: 'base', id: BASE, organizationId: ORG_A, baseId: BASE },
      snapshot: snapshot({ baseRoles: { [BASE]: 'viewer' } }),
    });

    expect(explanation.allowed).toBe(false);
    expect(explanation.remediation.length).toBeGreaterThan(0);
    expect(explanation.summary).toContain('record:update');
  });

  it('names the grant that allowed an action', () => {
    const explanation = explain({
      principal: user,
      action: 'record:update',
      resource: { type: 'base', id: BASE, organizationId: ORG_A, baseId: BASE },
      snapshot: snapshot({ baseRoles: { [BASE]: 'editor' } }),
    });

    expect(explanation.allowed).toBe(true);
    expect(explanation.grants[0]).toContain('base_role');
  });
});

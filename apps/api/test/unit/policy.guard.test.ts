import type { ExecutionContext } from '@nestjs/common';
import type { Reflector } from '@nestjs/core';
import type { MembershipSnapshot } from '@tessera/permissions';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { PolicyGuard } from '../../src/bootstrap/policy.guard';
import type { MembershipService } from '../../src/infrastructure/membership.service';

/**
 * These run the *real* policy engine rather than a mocked `assertAllowed`. Mocking it would leave
 * the only thing worth proving untested: that the guard hands the engine the right resource. The
 * engine's own rules are covered in the permissions package; what is under test here is the wiring
 * between an HTTP route and a policy decision.
 */

const ORG = 'org_00000000000000000000000A';
const USER = 'usr_0000000000000000000000001';

function snapshot(overrides: Partial<MembershipSnapshot> = {}): MembershipSnapshot {
  return {
    organizationId: ORG,
    plan: 'professional',
    organizationSuspended: false,
    userSuspended: false,
    organizationRole: 'owner',
    organizationSettings: {},
    workspaceRoles: {},
    baseRoles: {},
    explicitDenies: [],
    ...overrides,
  } as MembershipSnapshot;
}

function makeContext(request: unknown): ExecutionContext {
  return {
    switchToHttp: () => ({ getRequest: () => request }),
    getHandler: () => undefined,
    getClass: () => undefined,
  } as unknown as ExecutionContext;
}

function makeRequest(params: Record<string, string>, extra: Record<string, unknown> = {}) {
  return {
    params,
    principal: { type: 'user', userId: USER, mfaSatisfied: true },
    tenant: { organizationId: ORG },
    ...extra,
  } as never;
}

describe('PolicyGuard', () => {
  let memberships: MembershipService;
  let reflector: Reflector;
  let guard: PolicyGuard;
  let captured: MembershipSnapshot;

  const build = (action: string | undefined, snap: MembershipSnapshot = snapshot()) => {
    captured = snap;
    reflector = { getAllAndOverride: vi.fn().mockReturnValue(action) } as unknown as Reflector;
    memberships = { snapshot: vi.fn().mockResolvedValue(snap) } as unknown as MembershipService;
    guard = new PolicyGuard(reflector, memberships);
  };

  beforeEach(() => build('record:read'));

  describe('when the guard has nothing to decide', () => {
    /**
     * A route that declares no action is not checked. That is deliberate — health and auth routes
     * have no meaningful resource — but it means an omitted decorator on a data route is an open
     * door, which is why the integration suite asserts every data route declares one.
     */
    it('passes a route that declares no action', async () => {
      build(undefined);
      await expect(guard.canActivate(makeContext(makeRequest({})))).resolves.toBe(true);
      expect(memberships.snapshot).not.toHaveBeenCalled();
    });

    it('passes when the tenant guard set no tenant', async () => {
      const request = { params: {}, principal: { type: 'user', userId: USER } } as never;
      await expect(guard.canActivate(makeContext(request))).resolves.toBe(true);
    });
  });

  describe('enforcement', () => {
    it('allows an owner to read', async () => {
      await expect(guard.canActivate(makeContext(makeRequest({})))).resolves.toBe(true);
    });

    it('refuses a caller who is not a member', async () => {
      build('record:read', snapshot({ organizationRole: null }));
      await expect(guard.canActivate(makeContext(makeRequest({})))).rejects.toThrow();
    });

    it('refuses a write to a guest', async () => {
      build('record:update', snapshot({ organizationRole: 'guest' }));
      await expect(guard.canActivate(makeContext(makeRequest({})))).rejects.toThrow();
    });

    it('refuses a suspended organization even for an owner', async () => {
      build('record:read', snapshot({ organizationSuspended: true }));
      await expect(guard.canActivate(makeContext(makeRequest({})))).rejects.toThrow();
    });
  });

  describe('two-factor enforcement', () => {
    const unverified = {
      principal: { type: 'user', userId: USER, mfaSatisfied: false },
    };

    it('refuses a write from a user who has not satisfied a required second factor', async () => {
      build('record:update', snapshot({ organizationSettings: { requireTwoFactor: true } }));

      await expect(
        guard.canActivate(makeContext(makeRequest({}, unverified))),
      ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    });

    /**
     * Reads are deliberately still allowed. The requirement gates changes, not visibility: a user
     * midway through enrolling can still see their work, and the alternative — locking them out of
     * everything the moment an administrator enables the setting — is how people end up turning it
     * back off. The distinction lives in `WRITE_ACTIONS` in the policy engine.
     */
    it('still allows a read from that same user', async () => {
      build('record:read', snapshot({ organizationSettings: { requireTwoFactor: true } }));

      await expect(
        guard.canActivate(makeContext(makeRequest({}, unverified))),
      ).resolves.toBe(true);
    });

    /**
     * The requirement is on interactive sign-in, not on machine callers: an API token cannot
     * present a second factor, so applying the rule to it would break every integration the moment
     * an administrator turned the setting on.
     */
    it('does not apply the requirement to an api token', async () => {
      build('record:read', snapshot({ organizationSettings: { requireTwoFactor: true } }));
      const request = makeRequest({}, {
        principal: { type: 'api_token', userId: USER, scopes: ['data:read'] },
      });

      await expect(guard.canActivate(makeContext(request))).resolves.toBe(true);
    });
  });

  describe('the resource the engine is asked about', () => {
    /**
     * The regression this protects: a route like `/tables/:tableId/records` names no base, but a
     * user whose only access is a base-level grant must still be allowed through. The guard has to
     * read the base id from the ancestry the tenant guard resolved, not from the path.
     */
    it('lets a base-level grant authorize a route that names only a table', async () => {
      build(
        'record:update',
        snapshot({ organizationRole: 'guest', baseRoles: { bas_1: 'editor' } }),
      );
      const request = makeRequest({ tableId: 'tbl_1' }, {
        ancestry: { organizationId: ORG, baseId: 'bas_1', workspaceId: 'wsp_1' },
      });

      await expect(guard.canActivate(makeContext(request))).resolves.toBe(true);
    });

    it('does not invent a grant when the ancestry names a different base', async () => {
      build(
        'record:update',
        snapshot({ organizationRole: 'guest', baseRoles: { bas_other: 'editor' } }),
      );
      const request = makeRequest({ tableId: 'tbl_1' }, {
        ancestry: { organizationId: ORG, baseId: 'bas_1' },
      });

      await expect(guard.canActivate(makeContext(request))).rejects.toThrow();
    });

    it('honours an explicit deny on the specific record', async () => {
      build(
        'record:read',
        snapshot({ explicitDenies: [{ resourceId: 'rec_1', action: 'record:read' }] }),
      );
      const request = makeRequest({ recordId: 'rec_1' });

      // An explicit deny outranks the owner role, which is the whole point of having one.
      await expect(guard.canActivate(makeContext(request))).rejects.toThrow();
    });

    it('scopes to the organization when the route names nothing more specific', async () => {
      await expect(guard.canActivate(makeContext(makeRequest({})))).resolves.toBe(true);
      expect(memberships.snapshot).toHaveBeenCalledWith(ORG, USER);
      expect(captured.organizationId).toBe(ORG);
    });
  });
});

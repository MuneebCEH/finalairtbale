import type { ExecutionContext } from '@nestjs/common';
import type { Reflector } from '@nestjs/core';
import { AppError } from '@tessera/types';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { TenantGuard } from '../../src/bootstrap/tenant.guard';
import type { PrismaService } from '../../src/infrastructure/prisma.service';

/**
 * The tenant guard is the boundary that makes cross-organization access impossible, and it is the
 * one file in this codebase whose own comments record four repeat failures. Every branch it grew
 * to fix one of those is asserted here, so the fifth is a failing test rather than a support call.
 *
 * The property that matters most is in "cross-tenant pairing": the organization is taken from the
 * *resource*, never from the path segment the client controls. A test suite that only checked the
 * happy path would pass while that hole was open, so it is stated as its own case.
 */

const ORG_A = 'org_00000000000000000000000A';
const ORG_B = 'org_00000000000000000000000B';
const USER = 'usr_0000000000000000000000001';

/** Every model the guard reads, each returning null until a test says otherwise. */
function fakePrisma() {
  const models = [
    'automation',
    'form',
    'comment',
    'view',
    'record',
    'table',
    'base',
    'workspace',
    'organizationMember',
  ] as const;

  const client = Object.fromEntries(
    models.map((model) => [model, { findFirst: vi.fn().mockResolvedValue(null), findUnique: vi.fn().mockResolvedValue(null) }]),
  ) as Record<(typeof models)[number], { findFirst: ReturnType<typeof vi.fn>; findUnique: ReturnType<typeof vi.fn> }>;

  return { client, service: { client } as unknown as PrismaService };
}

function makeContext(request: unknown): ExecutionContext {
  return {
    switchToHttp: () => ({ getRequest: () => request }),
    getHandler: () => undefined,
    getClass: () => undefined,
  } as unknown as ExecutionContext;
}

/**
 * What the guard reads off the request and what it writes back. Typed rather than cast to `never`,
 * so an assertion against `request.tenant` is checked instead of silently accepted.
 */
interface TestRequest {
  params: Record<string, string>;
  correlationId: string;
  principal?: { type: string; userId?: string };
  tenant?: { organizationId: string; workspaceId?: string; baseId?: string; correlationId: string };
  ancestry?: { organizationId: string; workspaceId?: string; baseId?: string };
}

function makeRequest(params: Record<string, string>, principalType = 'user'): TestRequest {
  return {
    params,
    correlationId: 'cid_test',
    principal:
      principalType === 'anonymous'
        ? { type: 'anonymous' }
        : { type: principalType, userId: USER },
  };
}

describe('TenantGuard', () => {
  let prisma: ReturnType<typeof fakePrisma>;
  let reflector: Reflector;
  let guard: TenantGuard;

  /** Membership that exists and is active, which is the precondition most tests are not about. */
  const grantMembership = () => {
    prisma.client.organizationMember.findUnique.mockResolvedValue({ status: 'active' });
  };

  beforeEach(() => {
    prisma = fakePrisma();
    reflector = { getAllAndOverride: vi.fn().mockReturnValue(false) } as unknown as Reflector;
    guard = new TenantGuard(reflector, prisma.service);
  });

  describe('when scoping does not apply', () => {
    it('lets a route through when it is marked as skipping tenancy', async () => {
      (reflector.getAllAndOverride as ReturnType<typeof vi.fn>).mockReturnValue(true);
      const request = makeRequest({});

      await expect(guard.canActivate(makeContext(request))).resolves.toBe(true);
      // Nothing was looked up: a skipped route must not pay for a query it does not use.
      expect(prisma.client.workspace.findFirst).not.toHaveBeenCalled();
    });

    it('defers to the auth guard when there is no principal', async () => {
      const request: TestRequest = { params: {}, correlationId: 'c' };
      await expect(guard.canActivate(makeContext(request))).resolves.toBe(true);
    });
  });

  describe('resolving the organization from the route', () => {
    it('takes an explicit organization id', async () => {
      grantMembership();
      const request = makeRequest({ orgId: ORG_A });

      await expect(guard.canActivate(makeContext(request))).resolves.toBe(true);
      expect(request.tenant?.organizationId).toBe(ORG_A);
    });

    it('walks upward from a workspace', async () => {
      grantMembership();
      prisma.client.workspace.findFirst.mockResolvedValue({ organizationId: ORG_A });
      const request = makeRequest({ workspaceId: 'wsp_1' });

      await guard.canActivate(makeContext(request));
      expect(request.ancestry).toEqual({ organizationId: ORG_A, workspaceId: 'wsp_1' });
    });

    it('resolves a table to its full ancestry', async () => {
      grantMembership();
      prisma.client.table.findFirst.mockResolvedValue({
        organizationId: ORG_A,
        baseId: 'bas_1',
        base: { workspaceId: 'wsp_1' },
      });
      const request = makeRequest({ tableId: 'tbl_1' });

      await guard.canActivate(makeContext(request));
      // The base and workspace matter: a grant held only on a base is matched against these.
      expect(request.ancestry).toEqual({
        organizationId: ORG_A,
        baseId: 'bas_1',
        workspaceId: 'wsp_1',
      });
    });

    it('resolves a record through its table', async () => {
      grantMembership();
      prisma.client.record.findFirst.mockResolvedValue({ organizationId: ORG_A, tableId: 'tbl_1' });
      prisma.client.table.findFirst.mockResolvedValue({
        baseId: 'bas_1',
        base: { workspaceId: 'wsp_1' },
      });
      const request = makeRequest({ recordId: 'rec_1' });

      await guard.canActivate(makeContext(request));
      expect(request.ancestry).toEqual({
        organizationId: ORG_A,
        baseId: 'bas_1',
        workspaceId: 'wsp_1',
      });
    });

    /**
     * Comments, views, forms and automations carry no table id in their routes. Each was once
     * rejected as "no organization in the path" — a 400 that read as a client mistake rather than
     * the scoping gap it was.
     */
    it.each([
      ['commentId', 'comment', { organizationId: ORG_A, baseId: 'bas_1' }],
      ['formId', 'form', { organizationId: ORG_A, baseId: 'bas_1' }],
      ['automationId', 'automation', { organizationId: ORG_A, baseId: 'bas_1' }],
    ] as const)('scopes a route that carries only %s', async (param, model, row) => {
      grantMembership();
      prisma.client[model].findFirst.mockResolvedValue(row);
      prisma.client.base.findFirst.mockResolvedValue({ workspaceId: 'wsp_1' });
      const request = makeRequest({ [param]: 'leaf_1' });

      await expect(guard.canActivate(makeContext(request))).resolves.toBe(true);
      expect(request.tenant?.organizationId).toBe(ORG_A);
    });

    it('scopes a route that carries only a view id', async () => {
      grantMembership();
      prisma.client.view.findFirst.mockResolvedValue({
        organizationId: ORG_A,
        table: { baseId: 'bas_1', base: { workspaceId: 'wsp_1' } },
      });
      const request = makeRequest({ viewId: 'viw_1' });

      await guard.canActivate(makeContext(request));
      expect(request.ancestry).toEqual({
        organizationId: ORG_A,
        baseId: 'bas_1',
        workspaceId: 'wsp_1',
      });
    });

    it('rejects a route with nothing to scope against', async () => {
      const request = makeRequest({ somethingElse: 'x' });
      await expect(guard.canActivate(makeContext(request))).rejects.toMatchObject({
        code: 'MALFORMED_REQUEST',
      });
    });
  });

  describe('cross-tenant pairing', () => {
    /**
     * The attack this guard exists to stop: the caller is a member of organization A and pairs
     * A's id in the path with a workspace belonging to B. The organization must come from the
     * workspace row, so the membership check runs against B and fails.
     */
    it("uses the resource's organization, not the one named in the path", async () => {
      prisma.client.workspace.findFirst.mockResolvedValue({ organizationId: ORG_B });
      prisma.client.organizationMember.findUnique.mockResolvedValue(null);
      const request = makeRequest({ orgId: ORG_A, workspaceId: 'wsp_of_b' });

      await expect(guard.canActivate(makeContext(request))).rejects.toMatchObject({
        code: 'NOT_FOUND',
      });

      expect(prisma.client.organizationMember.findUnique).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { organizationId_userId: { organizationId: ORG_B, userId: USER } },
        }),
      );
    });

    it('answers 404 rather than 403 for a resource in another tenant', async () => {
      prisma.client.table.findFirst.mockResolvedValue(null);
      const request = makeRequest({ tableId: 'tbl_of_b' });

      // A 403 here would confirm the id exists, turning enumeration into a map of the platform.
      const error = await guard.canActivate(makeContext(request)).catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(AppError);
      expect((error as AppError).status).toBe(404);
    });
  });

  describe('membership', () => {
    it('refuses a caller with no membership of the resolved organization', async () => {
      prisma.client.organizationMember.findUnique.mockResolvedValue(null);
      const request = makeRequest({ orgId: ORG_A });

      await expect(guard.canActivate(makeContext(request))).rejects.toMatchObject({
        code: 'NOT_FOUND',
      });
    });

    it('refuses a suspended member', async () => {
      prisma.client.organizationMember.findUnique.mockResolvedValue({ status: 'suspended' });
      const request = makeRequest({ orgId: ORG_A });

      await expect(guard.canActivate(makeContext(request))).rejects.toMatchObject({
        code: 'FORBIDDEN',
      });
    });

    /**
     * API tokens and OAuth grants act as their owning user, so they are held to the same
     * membership check. If this ever stopped being true, a token minted in one organization would
     * reach another, and the guard's whole promise would be false for machine callers.
     */
    it.each(['api_token', 'oauth'])('checks membership for a %s principal', async (type) => {
      prisma.client.organizationMember.findUnique.mockResolvedValue(null);
      const request = makeRequest({ orgId: ORG_A }, type);

      await expect(guard.canActivate(makeContext(request))).rejects.toMatchObject({
        code: 'NOT_FOUND',
      });
    });

    /**
     * An anonymous principal is a public form submission. It has no membership by definition, so
     * requiring one would break every public form; the form's own field filtering is the boundary
     * there instead.
     */
    it('does not require membership of an anonymous principal', async () => {
      const request = makeRequest({ orgId: ORG_A }, 'anonymous');

      await expect(guard.canActivate(makeContext(request))).resolves.toBe(true);
      expect(prisma.client.organizationMember.findUnique).not.toHaveBeenCalled();
    });
  });

  it('attaches the tenant context the handlers read', async () => {
    grantMembership();
    prisma.client.base.findFirst.mockResolvedValue({
      organizationId: ORG_A,
      workspaceId: 'wsp_1',
    });
    const request = makeRequest({ baseId: 'bas_1' });

    await guard.canActivate(makeContext(request));
    expect(request.tenant).toMatchObject({
      organizationId: ORG_A,
      workspaceId: 'wsp_1',
      baseId: 'bas_1',
      correlationId: 'cid_test',
    });
  });
});

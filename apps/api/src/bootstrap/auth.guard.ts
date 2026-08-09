import { Inject, Injectable, type CanActivate, type ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { hashToken } from '@tessera/auth';
import type { Env } from '@tessera/config';
import { SessionRepository, UserRepository } from '@tessera/database';
import { extendContext } from '@tessera/logger';
import { AppError, type Principal, type TenantContext } from '@tessera/types';
import type { Request } from 'express';

import { PrismaService } from '../infrastructure/prisma.service';
import { ENV } from '../infrastructure/tokens';

import { PUBLIC_KEY } from './decorators';
import { clientIp } from './rate-limit.guard';

export interface AuthenticatedRequest extends Request {
  principal?: Principal;
  tenant?: TenantContext;
  /** Containment chain resolved by the tenant guard, used by the policy guard. */
  ancestry?: { organizationId: string; workspaceId?: string | undefined; baseId?: string | undefined };
  correlationId: string;
}

/**
 * Resolves the caller's identity.
 *
 * Three credential shapes are accepted, in a fixed order:
 *   1. `Authorization: Bearer tsk_…`  — personal access token
 *   2. `Authorization: Bearer tsa_…`  — OAuth access token
 *   3. the session cookie             — the first-party web app
 *
 * A route reaches its handler only if one of them resolved, or if it is explicitly `@Public()`.
 * There is no third state: an unauthenticated request to an unmarked route is a 401 before any
 * business code runs.
 */
@Injectable()
export class AuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly prisma: PrismaService,
    // `Env` is a Zod-inferred type, not a class, so there is no constructor to inject by. It
    // must be requested by token — without the decorator Nest sees `Object` and fails to
    // resolve the dependency.
    @Inject(ENV) private readonly env: Env,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    const isPublic = this.reflector.getAllAndOverride<boolean>(PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);

    const principal = await this.resolve(request);

    if (principal) {
      request.principal = principal;
      if (principal.type === 'user') {
        extendContext({ userId: principal.userId });
      }
      return true;
    }

    if (isPublic) {
      request.principal = { type: 'anonymous' };
      return true;
    }

    throw new AppError('UNAUTHENTICATED', 'Authentication is required for this endpoint.');
  }

  private async resolve(request: AuthenticatedRequest): Promise<Principal | null> {
    const bearer = readBearer(request);
    if (bearer) return this.resolveToken(bearer, request);

    const cookie = request.cookies?.[this.env.SESSION_COOKIE_NAME] as string | undefined;
    if (cookie) return this.resolveSession(cookie, request);

    return null;
  }

  private async resolveToken(token: string, request: AuthenticatedRequest): Promise<Principal | null> {
    const row = await this.prisma.client.apiToken.findUnique({
      where: { tokenHash: hashToken(token) },
      select: {
        id: true,
        userId: true,
        scopes: true,
        expiresAt: true,
        revokedAt: true,
        ipAllowlist: true,
      },
    });

    if (!row || row.revokedAt || (row.expiresAt && row.expiresAt.getTime() <= Date.now())) {
      return null;
    }

    // An IP allowlist on a token is only meaningful if it is checked on every request, not only
    // at creation.
    if (row.ipAllowlist.length > 0 && !row.ipAllowlist.includes(clientIp(request))) {
      throw new AppError('FORBIDDEN', 'This token may not be used from this address.');
    }

    // Last-used is best-effort: a write on every read would be a hot row. Fire and forget.
    void this.prisma.client.apiToken
      .update({ where: { id: row.id }, data: { lastUsedAt: new Date() } })
      .catch(() => undefined);

    return {
      type: token.startsWith('tsa_') ? 'oauth' : 'api_token',
      tokenId: row.id,
      appId: row.id,
      userId: row.userId as Principal extends { userId: infer U } ? U : never,
      scopes: row.scopes as never,
    } as Principal;
  }

  private async resolveSession(
    cookie: string,
    request: AuthenticatedRequest,
  ): Promise<Principal | null> {
    const sessions = new SessionRepository(this.prisma.client);
    const session = await sessions.findValidByTokenHash(hashToken(cookie));

    if (!session) {
      // Not merely invalid — check whether this is a *rotated* token being replayed, which means
      // a copy of the cookie escaped. The whole session family is revoked immediately.
      const family = await sessions.findRotatedFamily(hashToken(cookie));
      if (family) {
        await sessions.revokeFamily(family.familyId, 'refresh_token_reuse_detected');
        throw new AppError(
          'UNAUTHENTICATED',
          'Your session was ended for security reasons. Please sign in again.',
        );
      }
      return null;
    }

    const users = new UserRepository(this.prisma.client);
    const user = await users.findById(session.userId);
    if (!user || user.status !== 'active') return null;

    void sessions.touch(session.id, clientIp(request)).catch(() => undefined);

    return {
      type: 'user',
      userId: session.userId as never,
      sessionId: session.id as never,
      mfaSatisfied: session.mfaSatisfied,
      isPlatformAdmin: user.isPlatformAdmin,
    };
  }
}

function readBearer(request: Request): string | null {
  const header = request.header('authorization');
  if (!header?.startsWith('Bearer ')) return null;
  const token = header.slice(7).trim();
  return token.length > 0 ? token : null;
}

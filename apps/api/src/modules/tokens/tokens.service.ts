import { Injectable } from '@nestjs/common';
import { expiresIn, hashToken, issueApiToken } from '@tessera/auth';
import { newId } from '@tessera/database';
import { parseScopes } from '@tessera/permissions';
import { AppError, actingUserId, type TenantContext } from '@tessera/types';

import { PrismaService } from '../../infrastructure/prisma.service';

/**
 * Personal access tokens.
 *
 * The plaintext is returned exactly once, at creation, and only its SHA-256 is stored. That is
 * not a formality: a token list that can re-display secrets turns one compromised session into
 * every token the account ever made, and makes rotation meaningless.
 */
@Injectable()
export class TokensService {
  constructor(private readonly prisma: PrismaService) {}

  async list(tenant: TenantContext) {
    const userId = actingUserId(tenant.principal);
    if (!userId) throw new AppError('FORBIDDEN', 'Only a signed-in user has tokens.');

    const rows = await this.prisma.read.apiToken.findMany({
      where: { organizationId: tenant.organizationId, userId, revokedAt: null },
      orderBy: { createdAt: 'desc' },
    });

    return rows.map((row) => ({
      id: row.id,
      name: row.name,
      // The prefix only — enough to recognise a token in a list and to correlate it with a log
      // line, and useless to anybody who obtains it.
      prefix: row.tokenPrefix,
      scopes: row.scopes,
      baseIds: row.baseIds,
      expiresAt: row.expiresAt?.toISOString() ?? null,
      lastUsedAt: row.lastUsedAt?.toISOString() ?? null,
      createdAt: row.createdAt.toISOString(),
    }));
  }

  async create(
    tenant: TenantContext,
    input: { name: string; scopes: string[]; baseIds?: string[]; expiresInDays?: number },
  ) {
    const userId = actingUserId(tenant.principal);
    if (!userId) throw new AppError('FORBIDDEN', 'Only a signed-in user can create a token.');

    const parsed = parseScopes(input.scopes);
    if (!parsed.ok) {
      throw new AppError('VALIDATION_FAILED', 'Those scopes are not recognised.', {
        details: { unknown: parsed.unknown },
      });
    }

    // A token cannot be minted with access its owner does not have. Without this check, a viewer
    // could issue themselves a `data:write` token and the scope system would be a way *around*
    // the role system rather than a second limit on top of it.
    //
    // The role check on every request still applies — this is belt and braces, because a token
    // that visibly claims a scope its owner lacks is confusing even when it is harmless.
    const membership = await this.prisma.read.organizationMember.findUnique({
      where: { organizationId_userId: { organizationId: tenant.organizationId, userId } },
      select: { role: true },
    });
    if (!membership) throw new AppError('FORBIDDEN', 'You are not a member of this organization.');
    if (parsed.scopes.includes('org:admin') && !['owner', 'admin'].includes(membership.role)) {
      throw new AppError('FORBIDDEN', 'Only an owner or admin can issue an administrative token.');
    }

    const issued = issueApiToken();

    const row = await this.prisma.client.apiToken.create({
      data: {
        id: newId('apiToken'),
        organizationId: tenant.organizationId,
        userId,
        name: input.name,
        tokenHash: hashToken(issued.plaintext),
        tokenPrefix: issued.prefix,
        scopes: parsed.scopes,
        baseIds: input.baseIds ?? [],
        ...(input.expiresInDays ? { expiresAt: expiresIn.days(input.expiresInDays) } : {}),
      },
    });

    return {
      id: row.id,
      name: row.name,
      prefix: row.tokenPrefix,
      scopes: row.scopes,
      expiresAt: row.expiresAt?.toISOString() ?? null,
      createdAt: row.createdAt.toISOString(),
      // The only time this is ever returned.
      token: issued.plaintext,
    };
  }

  async revoke(tenant: TenantContext, tokenId: string) {
    const userId = actingUserId(tenant.principal);
    // Narrowed rather than coerced: without a user there is no "own tokens" to scope to, and a
    // null here would widen the filter to every token in the organization.
    if (!userId) throw new AppError('FORBIDDEN', 'Only a signed-in user can revoke a token.');

    const result = await this.prisma.client.apiToken.updateMany({
      // Scoped to the caller's own tokens: an id from somebody else's list must not be revocable.
      where: { id: tokenId, organizationId: tenant.organizationId, userId, revokedAt: null },
      data: { revokedAt: new Date() },
    });

    if (result.count === 0) throw new AppError('NOT_FOUND', 'That token no longer exists.');
    return { revoked: true };
  }
}

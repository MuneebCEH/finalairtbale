import type { Db, TransactionClient } from '../client';
import { newId } from '../ids';

/**
 * Session storage.
 *
 * Sessions are stored server-side rather than as self-contained JWTs, because the product
 * requires immediate revocation: "sign out all other devices" and "revoke this session" must
 * take effect at once, and a stateless token cannot be un-issued. The cookie carries an opaque
 * refresh token; only its SHA-256 is stored.
 *
 * **Refresh-token rotation with reuse detection.** Each refresh mints a new token and retires the
 * old one, recording the lineage in `familyId`. If a retired token is ever presented again, that
 * means a copy escaped — the entire family is revoked immediately and the user is notified. This
 * turns silent token theft into a detectable, contained event.
 */
export class SessionRepository {
  constructor(private readonly db: Db | TransactionClient) {}

  async create(input: {
    userId: string;
    tokenHash: string;
    familyId?: string;
    previousTokenHash?: string;
    expiresAt: Date;
    mfaSatisfied: boolean;
    ipAddress?: string | null;
    userAgent?: string | null;
    deviceLabel?: string | null;
  }) {
    return this.db.userSession.create({
      data: {
        id: newId('session'),
        userId: input.userId,
        tokenHash: input.tokenHash,
        familyId: input.familyId ?? newId('session'),
        previousTokenHash: input.previousTokenHash ?? null,
        expiresAt: input.expiresAt,
        mfaSatisfied: input.mfaSatisfied,
        ipAddress: input.ipAddress ?? null,
        userAgent: input.userAgent ?? null,
        deviceLabel: input.deviceLabel ?? null,
      },
    });
  }

  async findValidByTokenHash(tokenHash: string) {
    return this.db.userSession.findFirst({
      where: {
        tokenHash,
        revokedAt: null,
        expiresAt: { gt: new Date() },
      },
    });
  }

  /**
   * Detects presentation of a token that was already rotated away.
   *
   * A live token is found by `findValidByTokenHash`. If that misses but the hash appears as some
   * session's `previousTokenHash`, the token is a replay of a rotated credential.
   */
  async findRotatedFamily(tokenHash: string): Promise<{ familyId: string; userId: string } | null> {
    const row = await this.db.userSession.findFirst({
      where: { previousTokenHash: tokenHash },
      select: { familyId: true, userId: true },
    });
    return row ?? null;
  }

  async revokeFamily(familyId: string, reason: string): Promise<number> {
    const result = await this.db.userSession.updateMany({
      where: { familyId, revokedAt: null },
      data: { revokedAt: new Date(), revokedReason: reason },
    });
    return result.count;
  }

  async touch(sessionId: string, ip: string | null): Promise<void> {
    await this.db.userSession.update({
      where: { id: sessionId },
      data: { lastSeenAt: new Date(), ...(ip ? { ipAddress: ip } : {}) },
    });
  }

  async listForUser(userId: string) {
    return this.db.userSession.findMany({
      where: { userId, revokedAt: null, expiresAt: { gt: new Date() } },
      orderBy: { lastSeenAt: 'desc' },
      take: 100,
      select: {
        id: true,
        createdAt: true,
        lastSeenAt: true,
        expiresAt: true,
        ipAddress: true,
        userAgent: true,
        deviceLabel: true,
        location: true,
      },
    });
  }

  async revoke(sessionId: string, userId: string, reason: string): Promise<boolean> {
    const result = await this.db.userSession.updateMany({
      // The `userId` predicate is what stops one user revoking another's session by id.
      where: { id: sessionId, userId, revokedAt: null },
      data: { revokedAt: new Date(), revokedReason: reason },
    });
    return result.count > 0;
  }

  async revokeAllExcept(userId: string, keepSessionId: string, reason: string): Promise<number> {
    const result = await this.db.userSession.updateMany({
      where: { userId, id: { not: keepSessionId }, revokedAt: null },
      data: { revokedAt: new Date(), revokedReason: reason },
    });
    return result.count;
  }

  async revokeAll(userId: string, reason: string): Promise<number> {
    const result = await this.db.userSession.updateMany({
      where: { userId, revokedAt: null },
      data: { revokedAt: new Date(), revokedReason: reason },
    });
    return result.count;
  }

  /** Removes expired and long-revoked rows. Run by the maintenance worker. */
  async prune(olderThan: Date): Promise<number> {
    const result = await this.db.userSession.deleteMany({
      where: {
        OR: [{ expiresAt: { lt: olderThan } }, { revokedAt: { lt: olderThan } }],
      },
    });
    return result.count;
  }
}

import type { Db, TransactionClient } from '../client';
import { newId } from '../ids';

/**
 * User and session access.
 *
 * **This repository is deliberately not tenant-scoped.** A user is a global entity: the same
 * person belongs to many organizations, and authentication happens before any tenant is known.
 * Every other repository in the codebase extends `TenantScopedRepository`; this one documents
 * why it does not, so the exception is a considered decision rather than an oversight — and so a
 * reviewer seeing an unscoped query here knows it is intentional.
 *
 * The tenant boundary for user data is enforced one level up: an endpoint may only *resolve* a
 * user id it obtained from a tenant-scoped membership query.
 */
export class UserRepository {
  constructor(private readonly db: Db | TransactionClient) {}

  async findByEmail(email: string) {
    return this.db.user.findFirst({
      where: { email: email.toLowerCase(), deletedAt: null },
    });
  }

  async findById(userId: string) {
    return this.db.user.findFirst({ where: { id: userId, deletedAt: null } });
  }

  async create(input: {
    email: string;
    name: string;
    passwordHash: string | null;
    emailVerified: boolean;
    timezone?: string;
    locale?: string;
  }) {
    return this.db.user.create({
      data: {
        id: newId('user'),
        email: input.email.toLowerCase(),
        name: input.name,
        passwordHash: input.passwordHash,
        emailVerifiedAt: input.emailVerified ? new Date() : null,
        timezone: input.timezone ?? 'UTC',
        locale: input.locale ?? 'en',
      },
    });
  }

  async update(userId: string, data: Record<string, unknown>) {
    return this.db.user.update({ where: { id: userId }, data: data as never });
  }

  async markEmailVerified(userId: string): Promise<void> {
    await this.db.user.update({
      where: { id: userId },
      data: { emailVerifiedAt: new Date() },
    });
  }

  /**
   * Records a failed sign-in and locks the account once the threshold is crossed.
   *
   * Returned so the caller can decide what to say — which is: nothing specific. The response to
   * a locked account is identical to the response to a wrong password, because distinguishing
   * them tells an attacker which accounts exist and which they have already tripped.
   */
  async recordFailedLogin(
    userId: string,
    maxAttempts: number,
    lockoutMinutes: number,
  ): Promise<{ locked: boolean; attempts: number }> {
    const updated = await this.db.user.update({
      where: { id: userId },
      data: { failedLoginCount: { increment: 1 } },
      select: { failedLoginCount: true },
    });

    if (updated.failedLoginCount >= maxAttempts) {
      await this.db.user.update({
        where: { id: userId },
        data: { lockedUntil: new Date(Date.now() + lockoutMinutes * 60_000) },
      });
      return { locked: true, attempts: updated.failedLoginCount };
    }

    return { locked: false, attempts: updated.failedLoginCount };
  }

  async recordSuccessfulLogin(userId: string, ip: string | null): Promise<void> {
    await this.db.user.update({
      where: { id: userId },
      data: {
        failedLoginCount: 0,
        lockedUntil: null,
        lastLoginAt: new Date(),
        lastLoginIp: ip,
      },
    });
  }

  async isLocked(userId: string): Promise<boolean> {
    const row = await this.db.user.findUnique({
      where: { id: userId },
      select: { lockedUntil: true },
    });
    return Boolean(row?.lockedUntil && row.lockedUntil.getTime() > Date.now());
  }

  async listOrganizations(userId: string) {
    return this.db.organizationMember.findMany({
      where: { userId, status: 'active' },
      select: {
        role: true,
        joinedAt: true,
        organization: {
          select: {
            id: true,
            name: true,
            slug: true,
            logoUrl: true,
            plan: true,
            status: true,
          },
        },
      },
      orderBy: { joinedAt: 'asc' },
      take: 200,
    });
  }

  async listGroupIds(userId: string): Promise<string[]> {
    const rows = await this.db.organizationGroupMember.findMany({
      where: { userId },
      select: { groupId: true },
    });
    return rows.map((r) => r.groupId);
  }
}

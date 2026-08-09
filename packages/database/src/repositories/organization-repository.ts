import {
  type OrganizationRole,
  type Page,
  type TenantContext,
  decodeCursor,
  encodeCursor,
} from '@tessera/types';

import type { Db, TransactionClient } from '../client';
import { newId } from '../ids';
import { TenantScopedRepository } from '../tenant/tenant-repository';

export interface OrganizationRecord {
  id: string;
  name: string;
  slug: string;
  logoUrl: string | null;
  brandColor: string | null;
  plan: string;
  status: string;
  settings: Record<string, unknown>;
  createdAt: Date;
}

export interface MemberRecord {
  id: string;
  userId: string;
  role: string;
  status: string;
  joinedAt: Date;
  user: { id: string; email: string; name: string; avatarUrl: string | null };
}

export class OrganizationRepository extends TenantScopedRepository {
  constructor(db: Db | TransactionClient, ctx: TenantContext) {
    super(db, ctx);
  }

  async findById(): Promise<OrganizationRecord> {
    const row = await this.db.organization.findFirst({
      where: { id: this.organizationId, deletedAt: null },
    });
    const org = this.required(row, 'Organization', this.organizationId);
    return toOrganization(org);
  }

  async update(data: Partial<Pick<OrganizationRecord, 'name' | 'slug' | 'logoUrl' | 'brandColor'>>) {
    const row = await this.db.organization.update({
      where: { id: this.organizationId },
      data,
    });
    return toOrganization(row);
  }

  /**
   * Merges governance settings rather than replacing them, so a client that knows about three
   * settings cannot silently clear the two it has never heard of. Forward compatibility for
   * older clients is a security property here, not just a convenience.
   */
  async updateSettings(patch: Record<string, unknown>): Promise<Record<string, unknown>> {
    const current = await this.db.organization.findFirstOrThrow({
      where: { id: this.organizationId },
      select: { settings: true },
    });
    const merged = { ...((current.settings ?? {}) as Record<string, unknown>), ...patch };
    const row = await this.db.organization.update({
      where: { id: this.organizationId },
      data: { settings: merged as never },
      select: { settings: true },
    });
    return (row.settings ?? {}) as Record<string, unknown>;
  }

  async listMembers(input: { limit: number; cursor?: string }): Promise<Page<MemberRecord>> {
    const limit = this.take(input.limit);
    const cursor = input.cursor ? decodeCursor(input.cursor) : null;

    const rows = await this.db.organizationMember.findMany({
      where: this.scope(cursor ? { id: { gt: cursor.i } } : {}),
      orderBy: { id: 'asc' },
      take: limit + 1,
      select: {
        id: true,
        userId: true,
        role: true,
        status: true,
        joinedAt: true,
        user: { select: { id: true, email: true, name: true, avatarUrl: true } },
      },
    });

    const hasMore = rows.length > limit;
    const page = hasMore ? rows.slice(0, limit) : rows;
    const last = page.at(-1);

    return {
      data: page as MemberRecord[],
      meta: {
        hasMore,
        count: page.length,
        nextCursor:
          hasMore && last ? encodeCursor({ v: 1, k: [], i: last.id, q: 'org-members' }) : null,
      },
    };
  }

  async findMember(userId: string): Promise<MemberRecord | null> {
    const row = await this.db.organizationMember.findFirst({
      where: this.scope({ userId }),
      select: {
        id: true,
        userId: true,
        role: true,
        status: true,
        joinedAt: true,
        user: { select: { id: true, email: true, name: true, avatarUrl: true } },
      },
    });
    return row as MemberRecord | null;
  }

  async addMember(input: {
    userId: string;
    role: OrganizationRole;
    invitedById?: string;
  }): Promise<MemberRecord> {
    const row = await this.db.organizationMember.create({
      data: {
        id: newId('user'),
        organizationId: this.organizationId,
        userId: input.userId,
        role: input.role,
        invitedById: input.invitedById ?? null,
      },
      select: {
        id: true,
        userId: true,
        role: true,
        status: true,
        joinedAt: true,
        user: { select: { id: true, email: true, name: true, avatarUrl: true } },
      },
    });
    return row as MemberRecord;
  }

  async updateMemberRole(userId: string, role: OrganizationRole): Promise<void> {
    const result = await this.db.organizationMember.updateMany({
      where: this.scope({ userId }),
      data: { role },
    });
    if (result.count === 0) this.required(null, 'Member', userId);
  }

  async setMemberStatus(userId: string, status: 'active' | 'suspended'): Promise<void> {
    const result = await this.db.organizationMember.updateMany({
      where: this.scope({ userId }),
      data: { status },
    });
    if (result.count === 0) this.required(null, 'Member', userId);
  }

  async removeMember(userId: string): Promise<void> {
    const result = await this.db.organizationMember.deleteMany({
      where: this.scope({ userId }),
    });
    if (result.count === 0) this.required(null, 'Member', userId);
  }

  /**
   * Counts owners. Used to refuse the last-owner removal or demotion — an organization without
   * an owner is unrecoverable without platform intervention.
   */
  async countOwners(): Promise<number> {
    return this.db.organizationMember.count({
      where: this.scope({ role: 'owner', status: 'active' }),
    });
  }

  async countSeats(): Promise<{ members: number; guests: number }> {
    const [members, guests] = await Promise.all([
      this.db.organizationMember.count({
        where: this.scope({ status: 'active', NOT: { role: 'guest' } }),
      }),
      this.db.organizationMember.count({ where: this.scope({ status: 'active', role: 'guest' }) }),
    ]);
    return { members, guests };
  }
}

function toOrganization(row: {
  id: string;
  name: string;
  slug: string;
  logoUrl: string | null;
  brandColor: string | null;
  plan: string;
  status: string;
  settings: unknown;
  createdAt: Date;
}): OrganizationRecord {
  return {
    id: row.id,
    name: row.name,
    slug: row.slug,
    logoUrl: row.logoUrl,
    brandColor: row.brandColor,
    plan: row.plan,
    status: row.status,
    settings: (row.settings ?? {}) as Record<string, unknown>,
    createdAt: row.createdAt,
  };
}

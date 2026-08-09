import { type Page, type TenantContext, decodeCursor, encodeCursor } from '@tessera/types';

import type { Db, TransactionClient } from '../client';
import { newId } from '../ids';
import { TenantScopedRepository } from '../tenant/tenant-repository';

export interface BaseRecord {
  id: string;
  organizationId: string;
  workspaceId: string;
  name: string;
  description: string | null;
  icon: string | null;
  color: string | null;
  position: number;
  schemaVersion: number;
  archivedAt: Date | null;
  createdById: string;
  createdAt: Date;
  updatedAt: Date;
}

export class BaseRepository extends TenantScopedRepository {
  constructor(db: Db | TransactionClient, ctx: TenantContext) {
    super(db, ctx);
  }

  async listForWorkspace(input: {
    workspaceId: string;
    includeArchived?: boolean;
    limit: number;
    cursor?: string;
  }): Promise<Page<BaseRecord>> {
    const limit = this.take(input.limit);
    const cursor = input.cursor ? decodeCursor(input.cursor) : null;

    const rows = await this.db.base.findMany({
      where: {
        ...this.scopeLive({ workspaceId: input.workspaceId }),
        ...(input.includeArchived ? {} : { archivedAt: null }),
        ...(cursor ? { id: { gt: cursor.i } } : {}),
      },
      orderBy: [{ position: 'asc' }, { id: 'asc' }],
      take: limit + 1,
    });

    const hasMore = rows.length > limit;
    const page = hasMore ? rows.slice(0, limit) : rows;
    const last = page.at(-1);

    return {
      data: page as BaseRecord[],
      meta: {
        hasMore,
        count: page.length,
        nextCursor:
          hasMore && last ? encodeCursor({ v: 1, k: [last.position], i: last.id, q: 'bases' }) : null,
      },
    };
  }

  async findById(baseId: string): Promise<BaseRecord> {
    const row = await this.db.base.findFirst({ where: this.scopeLive({ id: baseId }) });
    return this.required(row, 'Base', baseId) as BaseRecord;
  }

  async create(input: {
    workspaceId: string;
    name: string;
    description?: string;
    icon?: string;
    color?: string;
    createdById: string;
  }): Promise<BaseRecord> {
    const maxPosition = await this.db.base.aggregate({
      where: this.scopeLive({ workspaceId: input.workspaceId }),
      _max: { position: true },
    });

    const row = await this.db.base.create({
      data: {
        id: newId('base'),
        organizationId: this.organizationId,
        workspaceId: input.workspaceId,
        name: input.name,
        description: input.description ?? null,
        icon: input.icon ?? null,
        color: input.color ?? null,
        position: (maxPosition._max.position ?? 0) + 1,
        createdById: input.createdById,
      },
    });
    return row as BaseRecord;
  }

  async update(baseId: string, data: Record<string, unknown>): Promise<BaseRecord> {
    const result = await this.db.base.updateMany({
      where: this.scopeLive({ id: baseId }),
      data: data as never,
    });
    if (result.count === 0) this.required(null, 'Base', baseId);
    return this.findById(baseId);
  }

  /**
   * Bumps the base's schema version.
   *
   * Every cache key that holds schema-derived data embeds this number, so one increment makes
   * every stale entry unreachable at once — no invalidation fan-out, no window where a client
   * renders a grid against a field list that no longer exists.
   */
  async bumpSchemaVersion(baseId: string): Promise<number> {
    const row = await this.db.base.update({
      where: { id: baseId },
      data: { schemaVersion: { increment: 1 } },
      select: { schemaVersion: true },
    });
    return row.schemaVersion;
  }

  async setArchived(baseId: string, archived: boolean): Promise<void> {
    const result = await this.db.base.updateMany({
      where: this.scopeLive({ id: baseId }),
      data: { archivedAt: archived ? new Date() : null },
    });
    if (result.count === 0) this.required(null, 'Base', baseId);
  }

  async softDelete(baseId: string): Promise<void> {
    const result = await this.db.base.updateMany({
      where: this.scopeLive({ id: baseId }),
      data: { deletedAt: new Date() },
    });
    if (result.count === 0) this.required(null, 'Base', baseId);
  }

  async countForWorkspace(workspaceId: string): Promise<number> {
    return this.db.base.count({ where: this.scopeLive({ workspaceId, archivedAt: null }) });
  }
}

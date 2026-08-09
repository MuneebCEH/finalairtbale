import type { TenantContext } from '@tessera/types';

import type { Db, TransactionClient } from '../client';
import { newId } from '../ids';
import { TenantScopedRepository } from '../tenant/tenant-repository';

export interface TableRecord {
  id: string;
  organizationId: string;
  baseId: string;
  name: string;
  description: string | null;
  icon: string | null;
  color: string | null;
  position: number;
  primaryFieldId: string | null;
  recordCount: number;
  createdById: string;
  createdAt: Date;
  updatedAt: Date;
}

export class TableRepository extends TenantScopedRepository {
  constructor(db: Db | TransactionClient, ctx: TenantContext) {
    super(db, ctx);
  }

  /**
   * The columns a table row exposes.
   *
   * Explicit rather than `SELECT *` for two reasons. `dataVersion` and `autoNumberSeq` are
   * internal bookkeeping that no client should see or depend on — and they are `BigInt`, which
   * `JSON.stringify` refuses outright, so returning the raw row turns every table read into a
   * 500. Selecting deliberately fixes the leak and the crash at once.
   */
  private static readonly PUBLIC_COLUMNS = {
    id: true,
    organizationId: true,
    baseId: true,
    name: true,
    description: true,
    icon: true,
    color: true,
    position: true,
    primaryFieldId: true,
    recordCount: true,
    createdById: true,
    createdAt: true,
    updatedAt: true,
  } as const;

  async listForBase(baseId: string): Promise<TableRecord[]> {
    const rows = await this.db.table.findMany({
      where: this.scopeLive({ baseId }),
      orderBy: [{ position: 'asc' }, { id: 'asc' }],
      select: TableRepository.PUBLIC_COLUMNS,
      // Bounded like every other list. A base with more than 500 tables is pathological, and an
      // unbounded query here would be the one place a tenant could make the API allocate freely.
      take: 500,
    });
    return rows as TableRecord[];
  }

  async findById(tableId: string): Promise<TableRecord> {
    const row = await this.db.table.findFirst({
      where: this.scopeLive({ id: tableId }),
      select: TableRepository.PUBLIC_COLUMNS,
    });
    return this.required(row, 'Table', tableId) as TableRecord;
  }

  async create(input: {
    baseId: string;
    name: string;
    description?: string;
    icon?: string;
    color?: string;
    createdById: string;
  }): Promise<TableRecord> {
    const maxPosition = await this.db.table.aggregate({
      where: this.scopeLive({ baseId: input.baseId }),
      _max: { position: true },
    });

    const row = await this.db.table.create({
      data: {
        id: newId('table'),
        organizationId: this.organizationId,
        baseId: input.baseId,
        name: input.name,
        description: input.description ?? null,
        icon: input.icon ?? null,
        color: input.color ?? null,
        position: (maxPosition._max.position ?? 0) + 1,
        createdById: input.createdById,
      },
      select: TableRepository.PUBLIC_COLUMNS,
    });
    return row as TableRecord;
  }

  async update(tableId: string, data: Record<string, unknown>): Promise<TableRecord> {
    const result = await this.db.table.updateMany({
      where: this.scopeLive({ id: tableId }),
      data: data as never,
    });
    if (result.count === 0) this.required(null, 'Table', tableId);
    return this.findById(tableId);
  }

  async setPrimaryField(tableId: string, fieldId: string): Promise<void> {
    await this.db.table.updateMany({
      where: this.scopeLive({ id: tableId }),
      data: { primaryFieldId: fieldId },
    });
  }

  async softDelete(tableId: string): Promise<void> {
    const result = await this.db.table.updateMany({
      where: this.scopeLive({ id: tableId }),
      data: { deletedAt: new Date() },
    });
    if (result.count === 0) this.required(null, 'Table', tableId);
  }

  /**
   * Advances the table's data version and record count in one statement.
   *
   * `dataVersion` is embedded in every view-query cache key, so bumping it on write is what
   * makes cache invalidation free: stale entries become unreachable rather than needing to be
   * hunted down and deleted.
   */
  async bumpDataVersion(tableId: string, recordDelta = 0): Promise<void> {
    await this.db.table.updateMany({
      where: this.scope({ id: tableId }),
      data: {
        dataVersion: { increment: 1 },
        ...(recordDelta !== 0 ? { recordCount: { increment: recordDelta } } : {}),
      },
    });
  }

  /** Reserves the next block of auto-numbers atomically, so concurrent inserts cannot collide. */
  async reserveAutoNumbers(tableId: string, count: number): Promise<bigint> {
    const row = await this.db.table.update({
      where: { id: tableId },
      data: { autoNumberSeq: { increment: count } },
      select: { autoNumberSeq: true },
    });
    // The returned value is the sequence *after* the increment, so the block runs from
    // (value - count + 1) to value.
    return BigInt(row.autoNumberSeq) - BigInt(count) + 1n;
  }

  async countForBase(baseId: string): Promise<number> {
    return this.db.table.count({ where: this.scopeLive({ baseId }) });
  }
}

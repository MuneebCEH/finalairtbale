import { getFieldSpec, type FieldDefinition } from '@tessera/fields';
import { FIELD_SLOT_FAMILY, type FieldType, type TenantContext } from '@tessera/types';

import type { Db, TransactionClient } from '../client';
import { newId } from '../ids';
import { TenantScopedRepository } from '../tenant/tenant-repository';

export interface FieldRow extends FieldDefinition {
  organizationId: string;
  tableId: string;
  description: string | null;
  position: number;
  isPrimary: boolean;
  isRequired: boolean;
  isUnique: boolean;
  promotedSlot: string | null;
  promotionState: string | null;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * Slot inventory.
 *
 * The budget is fixed and small by design: a bounded number of typed columns per table shape
 * keeps the index count predictable, which is the whole reason the hybrid model scales where
 * dynamic physical tables do not. See docs/02-database-design.md §1.5.
 */
const SLOTS: Readonly<Record<'string' | 'number' | 'date' | 'boolean', readonly string[]>> = {
  string: ['s0', 's1', 's2', 's3'],
  number: ['n0', 'n1', 'n2', 'n3'],
  date: ['d0', 'd1', 'd2'],
  boolean: ['b0', 'b1'],
};

export class FieldRepository extends TenantScopedRepository {
  constructor(db: Db | TransactionClient, ctx: TenantContext) {
    super(db, ctx);
  }

  async listForTable(tableId: string): Promise<FieldRow[]> {
    const rows = await this.db.field.findMany({
      where: this.scopeLive({ tableId }),
      orderBy: [{ position: 'asc' }, { id: 'asc' }],
      take: 1_000,
    });
    return rows.map(toFieldRow);
  }

  async findById(fieldId: string): Promise<FieldRow> {
    const row = await this.db.field.findFirst({ where: this.scopeLive({ id: fieldId }) });
    return toFieldRow(this.required(row, 'Field', fieldId));
  }

  async create(input: {
    tableId: string;
    name: string;
    type: FieldType;
    description?: string;
    options: Record<string, unknown>;
    isRequired?: boolean;
    isUnique?: boolean;
    isPrimary?: boolean;
    position?: number;
    createdById: string;
  }): Promise<FieldRow> {
    const position =
      input.position ??
      ((
        await this.db.field.aggregate({
          where: this.scopeLive({ tableId: input.tableId }),
          _max: { position: true },
        })
      )._max.position ?? 0) + 1;

    // The first field of a table becomes its primary field automatically. A table whose label
    // column is unset renders as a list of ids everywhere it is referenced.
    const isPrimary =
      input.isPrimary ??
      (await this.db.field.count({ where: this.scopeLive({ tableId: input.tableId }) })) === 0;

    const row = await this.db.field.create({
      data: {
        id: newId('field'),
        organizationId: this.organizationId,
        tableId: input.tableId,
        name: input.name,
        type: input.type,
        description: input.description ?? null,
        options: input.options as never,
        isRequired: input.isRequired ?? false,
        isUnique: input.isUnique ?? false,
        isPrimary,
        position,
        createdById: input.createdById,
      },
    });

    return toFieldRow(row);
  }

  async update(fieldId: string, data: Record<string, unknown>): Promise<FieldRow> {
    const result = await this.db.field.updateMany({
      where: this.scopeLive({ id: fieldId }),
      data: data as never,
    });
    if (result.count === 0) this.required(null, 'Field', fieldId);
    return this.findById(fieldId);
  }

  /**
   * Soft-deletes a field.
   *
   * The values stay in each record's `data` blob rather than being stripped. That is deliberate:
   * restoring a field deleted by mistake is then a metadata flip instead of an unrecoverable
   * loss, and the cost is a few orphaned JSONB keys that the retention sweeper clears once the
   * trash window closes.
   */
  async softDelete(fieldId: string): Promise<void> {
    const field = await this.findById(fieldId);
    if (field.isPrimary) {
      throw new Error('The primary field cannot be deleted; change the primary field first.');
    }

    await this.db.field.updateMany({
      where: this.scopeLive({ id: fieldId }),
      data: { deletedAt: new Date(), promotedSlot: null, promotionState: null },
    });
  }

  /**
   * Assigns a promoted slot, if one of the right type is free.
   *
   * Returns `null` when the budget for that family is exhausted. The caller reports this to the
   * user rather than silently degrading: "this table already has four sortable text columns" is
   * actionable, a mysteriously slow sort is not.
   */
  async assignSlot(tableId: string, type: FieldType): Promise<string | null> {
    const family = FIELD_SLOT_FAMILY[type];
    if (!family) return null;

    const taken = await this.db.field.findMany({
      where: this.scopeLive({ tableId, NOT: { promotedSlot: null } }),
      select: { promotedSlot: true },
    });

    const used = new Set(taken.map((row) => row.promotedSlot));
    return SLOTS[family].find((slot) => !used.has(slot)) ?? null;
  }

  async setPromotion(
    fieldId: string,
    slot: string | null,
    state: 'pending' | 'backfilling' | 'ready' | null,
  ): Promise<void> {
    await this.db.field.updateMany({
      where: this.scope({ id: fieldId }),
      data: { promotedSlot: slot, promotionState: state },
    });
  }

  /** Names must be unique within a table, or formulas and imports become ambiguous. */
  async nameExists(tableId: string, name: string, excludeFieldId?: string): Promise<boolean> {
    const count = await this.db.field.count({
      where: this.scopeLive({
        tableId,
        name,
        ...(excludeFieldId ? { NOT: { id: excludeFieldId } } : {}),
      }),
    });
    return count > 0;
  }
}

function toFieldRow(row: {
  id: string;
  organizationId: string;
  tableId: string;
  name: string;
  type: string;
  description: string | null;
  options: unknown;
  position: number;
  isPrimary: boolean;
  isRequired: boolean;
  isUnique: boolean;
  promotedSlot: string | null;
  promotionState: string | null;
  createdAt: Date;
  updatedAt: Date;
}): FieldRow {
  return {
    id: row.id,
    organizationId: row.organizationId,
    tableId: row.tableId,
    name: row.name,
    type: row.type,
    description: row.description,
    options: (row.options ?? {}) as Record<string, unknown>,
    position: row.position,
    isPrimary: row.isPrimary,
    isRequired: row.isRequired,
    isUnique: row.isUnique,
    promotedSlot: row.promotedSlot,
    promotionState: row.promotionState,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

/** Validates a field's options against its own type's schema. */
export function validateFieldOptions(
  type: FieldType,
  options: Record<string, unknown> | undefined,
): { ok: true; options: Record<string, unknown> } | { ok: false; error: string } {
  const spec = getFieldSpec(type);
  const candidate = options ?? spec.defaultOptions();
  const parsed = spec.optionsSchema.safeParse(candidate);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues.map((issue) => issue.message).join('; ') };
  }
  return { ok: true, options: parsed.data as Record<string, unknown> };
}

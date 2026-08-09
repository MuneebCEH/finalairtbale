import { getFieldSpec, contextFor, valuesEqual, type FieldDefinition } from '@tessera/fields';
import { AppError, type Page, type TenantContext } from '@tessera/types';

import type { Db, TransactionClient } from '../client';
import { newId } from '../ids';
import type { ViewQuery } from '../query/filter-ir';
import { buildViewQuery, cursorForRow, type RecordRow } from '../query/view-query';
import { TenantScopedRepository } from '../tenant/tenant-repository';

export interface StoredRecord {
  id: string;
  version: number;
  autoNumber: number;
  data: Record<string, unknown>;
  createdAt: Date;
  createdBy: string | null;
  updatedAt: Date;
  updatedBy: string | null;
}

/**
 * Record storage against the hybrid model.
 *
 * Reads go through the query builder as raw SQL, because the filter/sort/group shape is dynamic
 * and no ORM DSL expresses the promoted-slot dispatch. Writes go through Prisma for the metadata
 * and raw SQL for the JSONB merge, because `jsonb_set` on only the changed keys is what makes
 * two people editing different columns of one row not collide.
 */
export class RecordRepository extends TenantScopedRepository {
  constructor(db: Db | TransactionClient, ctx: TenantContext) {
    super(db, ctx);
  }

  // ── Read ──────────────────────────────────────────────────────────────────

  async list(input: {
    tableId: string;
    query: ViewQuery;
    fields: readonly FieldDefinition[];
    currentUserId: string | null;
    timezone?: string;
  }): Promise<Page<StoredRecord>> {
    const compiled = buildViewQuery({
      organizationId: this.organizationId,
      tableId: input.tableId,
      query: input.query,
      fields: input.fields,
      currentUserId: input.currentUserId,
      ...(input.timezone ? { timezone: input.timezone } : {}),
    });

    const rows = await this.db.$queryRawUnsafe<RecordRow[]>(
      compiled.sql,
      ...(compiled.values as unknown[]),
    );

    const hasMore = rows.length > compiled.limit;
    const page = hasMore ? rows.slice(0, compiled.limit) : rows;
    const last = page.at(-1);

    const fieldMap = new Map(input.fields.map((field) => [field.id, field]));

    return {
      data: page.map(toStoredRecord),
      meta: {
        hasMore,
        count: page.length,
        nextCursor:
          hasMore && last ? cursorForRow(last, compiled.sorts, fieldMap, compiled.shapeHash) : null,
      },
    };
  }

  async findById(tableId: string, recordId: string): Promise<StoredRecord> {
    const rows = await this.db.$queryRawUnsafe<RecordRow[]>(
      `SELECT r.id, r.version, r.data, r.auto_number, r.created_at, r.updated_at,
              r.created_by, r.updated_by
         FROM records r
        WHERE r.organization_id = $1 AND r.table_id = $2 AND r.id = $3 AND r.deleted_at IS NULL`,
      this.organizationId,
      tableId,
      recordId,
    );

    const row = rows[0];
    if (!row) this.required(null, 'Record', recordId);
    return toStoredRecord(row as RecordRow);
  }

  // ── Write ─────────────────────────────────────────────────────────────────

  /**
   * Inserts a batch of records.
   *
   * One multi-row `INSERT` rather than a loop: a hundred round trips for a hundred rows is the
   * difference between a paste that feels instant and one that does not. Auto-numbers are
   * reserved as a block beforehand so concurrent batches cannot collide.
   */
  async createMany(input: {
    tableId: string;
    fields: readonly FieldDefinition[];
    rows: ReadonlyArray<Record<string, unknown>>;
    autoNumberStart: bigint;
    actorId: string | null;
  }): Promise<StoredRecord[]> {
    if (input.rows.length === 0) return [];

    const now = new Date();
    const created: StoredRecord[] = [];
    const values: unknown[] = [];
    const tuples: string[] = [];

    // Column order is fixed here and mirrored in the tuple builder below.
    const slotColumns = collectSlotColumns(input.fields);

    for (const [index, data] of input.rows.entries()) {
      const id = newId('record');
      const autoNumber = input.autoNumberStart + BigInt(index);
      const slots = slotValuesFor(input.fields, data);

      const placeholders: string[] = [];
      /**
       * Casts are mandatory, not decorative.
       *
       * A parameter arrives as text unless told otherwise, and Postgres will not implicitly
       * coerce text into `jsonb` or `bigint` in an INSERT target position — it raises 42804
       * rather than guessing. The cast is attached to the placeholder so the type is stated
       * once, next to the value it applies to.
       */
      const push = (value: unknown, cast?: string): void => {
        values.push(value);
        placeholders.push(cast ? `$${values.length}::${cast}` : `$${values.length}`);
      };

      push(id);
      push(this.organizationId);
      push(input.tableId);
      push(JSON.stringify(data), 'jsonb');
      push(autoNumber.toString(), 'bigint');
      push(input.actorId);
      push(input.actorId);
      push(now, 'timestamptz');
      push(now, 'timestamptz');
      for (const column of slotColumns) push(slots[column] ?? null);

      tuples.push(`(${placeholders.join(', ')})`);

      created.push({
        id,
        version: 1,
        autoNumber: Number(autoNumber),
        data,
        createdAt: now,
        createdBy: input.actorId,
        updatedAt: now,
        updatedBy: input.actorId,
      });
    }

    const slotClause = slotColumns.length > 0 ? `, ${slotColumns.join(', ')}` : '';

    await this.db.$executeRawUnsafe(
      `INSERT INTO records
         (id, organization_id, table_id, data, auto_number, created_by, updated_by,
          created_at, updated_at${slotClause})
       VALUES ${tuples.join(', ')}`,
      ...values,
    );

    return created;
  }

  /**
   * Updates a record's cells.
   *
   * Two properties are load-bearing:
   *
   *   • **Only the sent keys are touched.** `jsonb_set` is applied per changed field, so an
   *     update to column A does not overwrite a concurrent update to column B. Sending the whole
   *     record back — the obvious implementation — silently discards the other person's edit.
   *   • **The version guard is optional but honoured.** With `expectedVersion` supplied, zero
   *     rows affected means somebody else got there first, and the caller raises a conflict
   *     rather than clobbering.
   */
  async update(input: {
    tableId: string;
    recordId: string;
    fields: readonly FieldDefinition[];
    changes: Record<string, unknown>;
    expectedVersion?: number;
    actorId: string | null;
  }): Promise<{ updated: boolean; record: StoredRecord | null }> {
    const changedFieldIds = Object.keys(input.changes);
    if (changedFieldIds.length === 0) {
      return { updated: true, record: await this.findById(input.tableId, input.recordId) };
    }

    const values: unknown[] = [];
    const bind = (value: unknown): string => {
      values.push(value);
      return `$${values.length}`;
    };

    // Nested jsonb_set calls, one per changed key, so untouched keys keep their existing values.
    let dataExpression = 'data';
    for (const fieldId of changedFieldIds) {
      const value = input.changes[fieldId];
      dataExpression =
        value === null || value === undefined
          ? `(${dataExpression} - ${bind(fieldId)})`
          : `jsonb_set(${dataExpression}, ARRAY[${bind(fieldId)}], ${bind(JSON.stringify(value))}::jsonb, true)`;
    }

    const assignments = [`data = ${dataExpression}`, 'version = version + 1'];
    assignments.push(`updated_at = ${bind(new Date())}`);
    assignments.push(`updated_by = ${bind(input.actorId)}`);

    // Promoted slots are maintained in the same statement, so the column and the JSONB can never
    // disagree — a mismatch would make a filtered view silently omit a row that matches.
    const fieldMap = new Map(input.fields.map((field) => [field.id, field]));
    for (const fieldId of changedFieldIds) {
      const field = fieldMap.get(fieldId);
      if (!field?.promotedSlot) continue;
      const spec = getFieldSpec(field.type);
      const slotValue = spec.toSlot(input.changes[fieldId] ?? null, contextFor(field));
      assignments.push(`${field.promotedSlot} = ${bind(slotValue)}`);
    }

    const affected = await this.db.$executeRawUnsafe(
      `UPDATE records
          SET ${assignments.join(', ')}
        WHERE organization_id = ${bind(this.organizationId)}
          AND table_id = ${bind(input.tableId)}
          AND id = ${bind(input.recordId)}
          AND deleted_at IS NULL
          ${input.expectedVersion !== undefined ? `AND version = ${bind(input.expectedVersion)}` : ''}`,
      ...values,
    );

    if (affected === 0) return { updated: false, record: null };
    return { updated: true, record: await this.findById(input.tableId, input.recordId) };
  }

  /** Soft delete. The trash row and retention clock are the service layer's responsibility. */
  async softDeleteMany(tableId: string, recordIds: readonly string[]): Promise<number> {
    if (recordIds.length === 0) return 0;

    return this.db.$executeRawUnsafe(
      `UPDATE records
          SET deleted_at = now()
        WHERE organization_id = $1 AND table_id = $2 AND deleted_at IS NULL
          AND id = ANY($3::text[])`,
      this.organizationId,
      tableId,
      recordIds as string[],
    );
  }

  async restoreMany(tableId: string, recordIds: readonly string[]): Promise<number> {
    if (recordIds.length === 0) return 0;
    return this.db.$executeRawUnsafe(
      `UPDATE records SET deleted_at = NULL
        WHERE organization_id = $1 AND table_id = $2 AND id = ANY($3::text[])`,
      this.organizationId,
      tableId,
      recordIds as string[],
    );
  }

  /**
   * Computes the field-level diff between stored and incoming values.
   *
   * Uses each field type's own equality, so reordering a multi-select does not register as a
   * change and generate a revision, a realtime broadcast and an automation trigger for an edit
   * nobody made.
   */
  diff(
    fields: readonly FieldDefinition[],
    before: Record<string, unknown>,
    incoming: Record<string, unknown>,
  ): Record<string, { from: unknown; to: unknown }> {
    const changes: Record<string, { from: unknown; to: unknown }> = {};
    const fieldMap = new Map(fields.map((field) => [field.id, field]));

    for (const [fieldId, next] of Object.entries(incoming)) {
      const field = fieldMap.get(fieldId);
      if (!field) continue;
      const previous = before[fieldId] ?? null;
      if (!valuesEqual(field, previous, next ?? null)) {
        changes[fieldId] = { from: previous, to: next ?? null };
      }
    }
    return changes;
  }

  async countForTable(tableId: string): Promise<number> {
    const rows = await this.db.$queryRawUnsafe<Array<{ count: bigint }>>(
      `SELECT COUNT(*)::bigint AS count FROM records
        WHERE organization_id = $1 AND table_id = $2 AND deleted_at IS NULL`,
      this.organizationId,
      tableId,
    );
    return Number(rows[0]?.count ?? 0);
  }
}

// ── Helpers ─────────────────────────────────────────────────────────────────

function toStoredRecord(row: RecordRow): StoredRecord {
  return {
    id: row.id,
    version: row.version,
    autoNumber: Number(row.auto_number),
    data: (row.data ?? {}) as Record<string, unknown>,
    createdAt: row.created_at,
    createdBy: row.created_by,
    updatedAt: row.updated_at,
    updatedBy: row.updated_by,
  };
}

function collectSlotColumns(fields: readonly FieldDefinition[]): string[] {
  const slots = fields
    .map((field) => field.promotedSlot)
    .filter((slot): slot is string => Boolean(slot));
  // Deduplicated and sorted so the column list is deterministic — an INSERT whose column order
  // varies between calls defeats Postgres's prepared-statement cache.
  return [...new Set(slots)].sort();
}

function slotValuesFor(
  fields: readonly FieldDefinition[],
  data: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const field of fields) {
    if (!field.promotedSlot) continue;
    const spec = getFieldSpec(field.type);
    out[field.promotedSlot] = spec.toSlot(data[field.id] ?? null, contextFor(field));
  }
  return out;
}

/** Raised when an update loses an optimistic-concurrency race. */
export function recordConflict(recordId: string, expectedVersion: number): AppError {
  return new AppError('RECORD_VERSION_CONFLICT', 'The record was modified by another user.', {
    details: { recordId, expectedVersion },
  });
}

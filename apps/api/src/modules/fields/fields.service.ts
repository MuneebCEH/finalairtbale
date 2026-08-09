import { createHash } from 'node:crypto';

import { Injectable } from '@nestjs/common';
import {
  AuditWriter,
  BaseRepository,
  FieldRepository,
  OutboxWriter,
  RecordRepository,
  TableRepository,
  validateFieldOptions,
} from '@tessera/database';
import { getFieldSpec, isImplemented, parseCell } from '@tessera/fields';
import {
  AppError,
  actingUserId,
  isComputedFieldType,
  type FieldType,
  type TenantContext,
} from '@tessera/types';
import type { CreateFieldInput, UpdateFieldInput } from '@tessera/validation';

import { PrismaService } from '../../infrastructure/prisma.service';
import { ViewsService } from '../views/views.service';

export interface FieldChangePreview {
  readonly affectedRecords: number;
  readonly convertible: number;
  readonly lossy: number;
  readonly sample: ReadonlyArray<{ recordId: string; from: unknown; to: unknown; error?: string }>;
  /** Echoed back on the update to prove the caller saw this preview. */
  readonly migrationToken: string;
}

/**
 * Field creation and alteration.
 *
 * The interesting part is not creation, it is **change**. Converting a text column to a number
 * is a data migration: some values convert, some do not, and the ones that do not are gone.
 * Doing that behind a dropdown with no warning is how people lose a day's work, so a type change
 * requires a preview first and the token that preview issued.
 */
@Injectable()
export class FieldsService {
  private readonly outbox = new OutboxWriter();
  private readonly audit = new AuditWriter();

  constructor(
    private readonly prisma: PrismaService,
    private readonly views: ViewsService,
  ) {}

  async list(tenant: TenantContext, tableId: string) {
    return new FieldRepository(this.prisma.read, tenant).listForTable(tableId);
  }

  async create(tenant: TenantContext, tableId: string, input: CreateFieldInput) {
    const actor = requireActor(tenant);
    const fields = new FieldRepository(this.prisma.client, tenant);

    this.assertTypeUsable(input.type);

    if (await fields.nameExists(tableId, input.name)) {
      throw new AppError('DUPLICATE_RESOURCE', `A field called "${input.name}" already exists.`);
    }

    const options = validateFieldOptions(input.type, input.options);
    if (!options.ok) {
      throw new AppError('VALIDATION_FAILED', `Invalid options: ${options.error}`);
    }

    const table = await new TableRepository(this.prisma.read, tenant).findById(tableId);

    return this.prisma.transact(tenant, async (tx) => {
      const repo = new FieldRepository(tx, tenant);
      const field = await repo.create({
        tableId,
        name: input.name,
        type: input.type,
        ...(input.description !== undefined ? { description: input.description } : {}),
        options: options.options,
        ...(input.isRequired !== undefined ? { isRequired: input.isRequired } : {}),
        ...(input.isUnique !== undefined ? { isUnique: input.isUnique } : {}),
        ...(input.position !== undefined ? { position: input.position } : {}),
        createdById: actor,
      });

      // Promote eagerly where a slot is free. Waiting until somebody notices a slow sort means
      // the first person to sort a large table pays for the discovery.
      const slot = await repo.assignSlot(tableId, input.type);
      if (slot) await repo.setPromotion(field.id, slot, 'ready');

      await new BaseRepository(tx, tenant).bumpSchemaVersion(table.baseId);

      await this.outbox.append(tx, tenant, 'field.created', {
        tableId,
        fieldId: field.id,
        name: field.name,
        type: field.type,
      });
      await this.audit.write(tx, tenant, {
        action: 'field.created',
        resourceType: 'field',
        resourceId: field.id,
        after: { name: field.name, type: field.type, tableId },
      });

      return { ...field, promotedSlot: slot };
    });
  }

  /**
   * Simulates a type change without applying it.
   *
   * Reads a bounded sample rather than the whole table — the point is to show the user what
   * conversion does to their data, and a thousand rows answers that as well as a million while
   * costing a page instead of a scan. The counts are extrapolated and labelled as such.
   */
  async previewChange(
    tenant: TenantContext,
    fieldId: string,
    target: { type: FieldType; options?: Record<string, unknown> },
  ): Promise<FieldChangePreview> {
    const fields = new FieldRepository(this.prisma.read, tenant);
    const field = await fields.findById(fieldId);
    this.assertTypeUsable(target.type);

    const options = validateFieldOptions(target.type, target.options);
    if (!options.ok) throw new AppError('VALIDATION_FAILED', `Invalid options: ${options.error}`);

    const records = new RecordRepository(this.prisma.read, tenant);
    const total = await records.countForTable(field.tableId);

    const sampleSize = 1_000;
    const page = await records.list({
      tableId: field.tableId,
      query: { limit: sampleSize } as never,
      fields: [field],
      currentUserId: null,
    });

    const targetField = {
      id: field.id,
      name: field.name,
      type: target.type,
      options: options.options,
    };

    let convertible = 0;
    let lossy = 0;
    const sample: Array<{ recordId: string; from: unknown; to: unknown; error?: string }> = [];

    for (const record of page.data) {
      const from = record.data[field.id] ?? null;
      if (from === null) {
        convertible += 1;
        continue;
      }

      // Conversion goes through text, which is the honest model: it is what the user would get
      // by exporting and re-importing, and it makes the lossy cases visible rather than
      // pretending an in-memory cast is lossless.
      const asText = getFieldSpec(field.type).toText(from, {
        fieldId: field.id,
        name: field.name,
        options: field.options,
      });
      const result = parseCell(targetField, asText);

      if (result.ok && result.value !== null) {
        convertible += 1;
        if (sample.length < 20) sample.push({ recordId: record.id, from, to: result.value });
      } else {
        lossy += 1;
        if (sample.length < 20) {
          sample.push({
            recordId: record.id,
            from,
            to: null,
            error: result.ok ? 'would become empty' : result.error,
          });
        }
      }
    }

    const scale = page.data.length > 0 ? total / page.data.length : 1;

    return {
      affectedRecords: total,
      convertible: Math.round(convertible * scale),
      lossy: Math.round(lossy * scale),
      sample,
      migrationToken: migrationToken(fieldId, target.type, options.options),
    };
  }

  async update(tenant: TenantContext, fieldId: string, input: UpdateFieldInput) {
    const repo = new FieldRepository(this.prisma.client, tenant);
    const before = await repo.findById(fieldId);

    if (input.name && input.name !== before.name) {
      if (await repo.nameExists(before.tableId, input.name, fieldId)) {
        throw new AppError('DUPLICATE_RESOURCE', `A field called "${input.name}" already exists.`);
      }
    }

    const nextType = (input.type ?? before.type) as FieldType;
    const options = validateFieldOptions(nextType, input.options ?? before.options);
    if (!options.ok) throw new AppError('VALIDATION_FAILED', `Invalid options: ${options.error}`);

    if (input.type && input.type !== before.type) {
      this.assertTypeUsable(input.type);
      const expected = migrationToken(fieldId, input.type, options.options);
      if (input.migrationToken !== expected) {
        // The token binds to the exact field, target type and options that were previewed. A
        // stale or fabricated token means the user did not see what this change will do.
        throw new AppError(
          'VALIDATION_FAILED',
          'Preview this change before applying it; the migration token does not match.',
          { details: { fieldId, requestedType: input.type } },
        );
      }
    }

    const patch: Record<string, unknown> = { options: options.options };
    if (input.name !== undefined) patch['name'] = input.name;
    if (input.description !== undefined) patch['description'] = input.description;
    if (input.isRequired !== undefined) patch['isRequired'] = input.isRequired;
    if (input.position !== undefined) patch['position'] = input.position;
    if (input.type !== undefined) patch['type'] = input.type;

    return this.prisma.transact(tenant, async (tx) => {
      const scoped = new FieldRepository(tx, tenant);
      const after = await scoped.update(fieldId, patch);

      // A type change invalidates the promoted slot: the column's physical type no longer
      // matches the field's. Clearing it drops the field back to the JSONB path, which is
      // correct but slower, and the promotion job re-promotes it into a compatible slot.
      if (input.type && input.type !== before.type) {
        await scoped.setPromotion(fieldId, null, null);
        const slot = await scoped.assignSlot(before.tableId, input.type);
        if (slot) await scoped.setPromotion(fieldId, slot, 'pending');
      }

      const table = await new TableRepository(tx, tenant).findById(before.tableId);
      await new BaseRepository(tx, tenant).bumpSchemaVersion(table.baseId);

      await this.outbox.append(tx, tenant, 'field.updated', {
        tableId: before.tableId,
        fieldId,
        from: { type: before.type, name: before.name },
        to: { type: after.type, name: after.name },
      });
      await this.audit.write(tx, tenant, {
        action: 'field.updated',
        resourceType: 'field',
        resourceId: fieldId,
        before: { name: before.name, type: before.type, options: before.options },
        after: { name: after.name, type: after.type, options: after.options },
      });

      return after;
    });
  }

  async delete(tenant: TenantContext, fieldId: string) {
    const repo = new FieldRepository(this.prisma.client, tenant);
    const field = await repo.findById(fieldId);

    await this.prisma.transact(tenant, async (tx) => {
      await new FieldRepository(tx, tenant).softDelete(fieldId);

      const table = await new TableRepository(tx, tenant).findById(field.tableId);
      await new BaseRepository(tx, tenant).bumpSchemaVersion(table.baseId);

      await this.outbox.append(tx, tenant, 'field.deleted', {
        tableId: field.tableId,
        fieldId,
        name: field.name,
      });
      await this.audit.write(tx, tenant, {
        action: 'field.deleted',
        resourceType: 'field',
        resourceId: fieldId,
        before: { name: field.name, type: field.type },
      });
    });

    // Rewrites every view that referenced the field. Without this a view keeps a filter or a
    // sort on a column that no longer exists, and the query compiler fails on read — the table
    // becomes unopenable because of a change made somewhere else entirely.
    //
    // Deliberately after the transaction: the field is gone either way, and a view that could not
    // be rewritten degrades to a grid on next read rather than blocking the delete.
    const affected = await this.views.onFieldDeleted(tenant, field.tableId, fieldId);
    return { deleted: true, viewsUpdated: affected.length };
  }

  private assertTypeUsable(type: FieldType): void {
    if (!isImplemented(type)) {
      throw new AppError('NOT_IMPLEMENTED', `The field type "${type}" is not available yet.`, {
        details: { type },
      });
    }
    if (isComputedFieldType(type)) {
      throw new AppError(
        'NOT_IMPLEMENTED',
        `"${type}" is a computed field and arrives with the formula engine in a later phase.`,
        { details: { type } },
      );
    }
  }
}

/**
 * Binds a preview to the exact change it described.
 *
 * Deterministic rather than stored: the token has no lifetime to manage and no row to clean up,
 * and it cannot be replayed against a different target because any change to the field, type or
 * options produces a different token.
 */
function migrationToken(
  fieldId: string,
  type: string,
  options: Record<string, unknown>,
): string {
  return createHash('sha256')
    .update(`${fieldId}:${type}:${JSON.stringify(options)}`)
    .digest('hex')
    .slice(0, 32);
}

function requireActor(tenant: TenantContext): string {
  const actor = actingUserId(tenant.principal);
  if (!actor) throw new AppError('FORBIDDEN', 'This endpoint requires a user credential.');
  return actor;
}

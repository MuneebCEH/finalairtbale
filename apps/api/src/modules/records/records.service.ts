import { Injectable } from '@nestjs/common';
import {
  AuditWriter,
  FieldRepository,
  OrganizationRepository,
  OutboxWriter,
  RecordRepository,
  TableRepository,
  newId,
  recordConflict,
} from '@tessera/database';
import { parseRecord, serializeRecord, type FieldDefinition } from '@tessera/fields';
import { channelFor } from '@tessera/realtime';
import {
  AppError,
  PLAN_ENTITLEMENTS,
  ValidationError,
  actingUserId,
  type Plan,
  type TenantContext,
} from '@tessera/types';
import type { CreateRecordsInput, ListRecordsInput, UpdateRecordInput } from '@tessera/validation';

import { PrismaService } from '../../infrastructure/prisma.service';
import { AttachmentsService } from '../attachments/attachments.service';
import { RealtimeGateway } from '../realtime/realtime.gateway';

/**
 * Record reads and writes.
 *
 * The service owns three things the repository deliberately does not: validation through the
 * field registry, the revision trail, and the domain events that drive automations, search
 * indexing and realtime. Keeping those out of the repository is what lets the importer reuse the
 * repository for bulk loads without emitting a million events.
 */
@Injectable()
export class RecordsService {
  private readonly outbox = new OutboxWriter();
  private readonly audit = new AuditWriter();

  constructor(
    private readonly prisma: PrismaService,
    private readonly attachments: AttachmentsService,
    private readonly realtime: RealtimeGateway,
  ) {}

  /**
   * Announces a record change to everyone watching the table.
   *
   * Called *after* the write commits, never before: broadcasting an edit that then fails to
   * persist leaves every other viewer's grid showing a value the database never held, and
   * nothing later corrects it.
   *
   * Failures here are swallowed deliberately. The write has already succeeded and been audited;
   * turning a broadcast problem into a failed request would make the caller retry a change that
   * actually landed.
   */
  private announce(
    tableId: string,
    actorId: string | null,
    op: 'create' | 'update' | 'delete' | 'restore',
    records: ReadonlyArray<{ id: string; version: number; changed?: Record<string, unknown> }>,
  ): void {
    if (records.length === 0) return;
    try {
      this.realtime.publish(channelFor('table', tableId), {
        t: 'delta',
        ch: channelFor('table', tableId),
        ops: records.map((record) => ({
          recordId: record.id,
          version: record.version,
          // Only what changed: a 60-field record with one edited cell is ~120 bytes, not 12 KB.
          changed: record.changed ?? {},
          actorId,
          op,
        })),
      } as never);
    } catch {
      // See above: a delivery problem must not fail a committed write.
    }
  }

  async list(tenant: TenantContext, tableId: string, query: ListRecordsInput) {
    const fields = await this.fieldsFor(tenant, tableId);
    const repo = new RecordRepository(this.prisma.read, tenant);

    const page = await repo.list({
      tableId,
      query: query as never,
      fields,
      currentUserId: actingUserId(tenant.principal),
    });

    // Only the requested fields are serialised, but the query still read whatever the filter and
    // sort needed — narrowing the payload must not narrow the query, or the results change.
    const visible = query.fieldIds?.length
      ? fields.filter((field) => query.fieldIds?.includes(field.id))
      : fields;

    const serialised = page.data.map((record) => ({
      id: record.id,
      version: record.version,
      autoNumber: record.autoNumber,
      createdAt: record.createdAt.toISOString(),
      updatedAt: record.updatedAt.toISOString(),
      fields: serializeRecord(visible, record.data),
    }));

    return {
      data: await this.withSignedAttachments(tenant, visible, serialised),
      meta: page.meta,
    };
  }

  /**
   * Replaces stored attachment metadata with freshly signed download URLs.
   *
   * Signed at read time, for the whole page in one query, rather than stored: a URL persisted in
   * the record would either never expire — which defeats the point of signing — or be dead by
   * the time anyone clicked it.
   */
  private async withSignedAttachments<T extends { fields: Record<string, unknown> }>(
    tenant: TenantContext,
    fields: readonly FieldDefinition[],
    records: T[],
  ): Promise<T[]> {
    const attachmentFields = fields.filter((field) => field.type === 'attachment');
    if (attachmentFields.length === 0) return records;

    const ids = new Set<string>();
    for (const record of records) {
      for (const field of attachmentFields) {
        const value = record.fields[field.id];
        if (!Array.isArray(value)) continue;
        for (const file of value) {
          const id = (file as { id?: string }).id;
          if (id) ids.add(id);
        }
      }
    }
    if (ids.size === 0) return records;

    const signed = await this.attachments.signMany(tenant, [...ids]);

    for (const record of records) {
      for (const field of attachmentFields) {
        const value = record.fields[field.id];
        if (!Array.isArray(value)) continue;
        record.fields[field.id] = value.map((file) => {
          const id = (file as { id?: string }).id;
          const match = id ? signed.get(id) : undefined;
          // An attachment that no longer resolves keeps its metadata but gets no URL, so the
          // grid shows the filename greyed out rather than a link that 404s.
          return match ?? { ...(file as object), url: null };
        });
      }
    }

    return records;
  }

  async get(tenant: TenantContext, tableId: string, recordId: string) {
    const fields = await this.fieldsFor(tenant, tableId);
    const record = await new RecordRepository(this.prisma.read, tenant).findById(tableId, recordId);

    return {
      id: record.id,
      version: record.version,
      autoNumber: record.autoNumber,
      createdAt: record.createdAt.toISOString(),
      updatedAt: record.updatedAt.toISOString(),
      fields: serializeRecord(fields, record.data),
    };
  }

  /**
   * Creates a batch of records.
   *
   * Atomic by default: one invalid row fails the whole batch, which is what a user pasting a
   * range expects — a half-applied paste is worse than a rejected one. `partial: true` opts into
   * per-row results for importers that would rather salvage what they can.
   */
  async createMany(tenant: TenantContext, tableId: string, input: CreateRecordsInput) {
    const actor = actingUserId(tenant.principal);
    const fields = await this.fieldsFor(tenant, tableId);
    await this.assertRecordQuota(tenant, tableId, input.records.length);

    const parsed: Array<Record<string, unknown>> = [];
    const issues: Array<{ path: string; code: string; message: string }> = [];

    for (const [index, row] of input.records.entries()) {
      const result = parseRecord(fields, row.fields);
      if (result.ok) {
        parsed.push(result.values);
      } else {
        for (const issue of result.issues) {
          issues.push({
            path: `records[${index}].fields.${issue.path}`,
            code: 'invalid_value',
            message: issue.message,
          });
        }
      }
    }

    if (issues.length > 0 && !input.partial) throw new ValidationError(issues);
    if (parsed.length === 0) throw new ValidationError(issues);

    return this.prisma.transact(tenant, async (tx) => {
      const tables = new TableRepository(tx, tenant);
      const autoNumberStart = await tables.reserveAutoNumbers(tableId, parsed.length);

      const created = await new RecordRepository(tx, tenant).createMany({
        tableId,
        fields,
        rows: parsed,
        autoNumberStart,
        actorId: actor,
      });

      await tables.bumpDataVersion(tableId, created.length);

      for (const record of created) {
        await tx.recordRevision.create({
          data: {
            id: newId('event'),
            organizationId: tenant.organizationId,
            tableId,
            recordId: record.id,
            version: 1,
            changes: { created: true } as never,
            actorType: tenant.principal.type,
            actorId: actor,
            source: 'api',
            correlationId: tenant.correlationId,
          },
        });

        await this.outbox.append(tx, tenant, 'record.created', {
          tableId,
          recordId: record.id,
          version: 1,
          changed: {},
        });
      }

      const result = {
        records: created.map((record) => ({
          id: record.id,
          version: record.version,
          autoNumber: record.autoNumber,
          createdAt: record.createdAt.toISOString(),
          updatedAt: record.updatedAt.toISOString(),
          fields: serializeRecord(fields, record.data),
        })),
        skipped: issues.length > 0 ? issues : undefined,
      };

      this.announce(
        tableId,
        actingUserId(tenant.principal),
        'create',
        result.records.map((record) => ({
          id: record.id,
          version: record.version,
          changed: record.fields as Record<string, unknown>,
        })),
      );

      return result;
    });
  }

  /**
   * Updates one record.
   *
   * Only fields whose value actually changed are written, so a client that echoes the whole
   * record back does not generate a revision for every column, and does not overwrite a
   * concurrent edit to a column it merely re-sent unchanged.
   */
  async update(
    tenant: TenantContext,
    tableId: string,
    recordId: string,
    input: UpdateRecordInput,
  ) {
    const actor = actingUserId(tenant.principal);
    const fields = await this.fieldsFor(tenant, tableId);

    const parsed = parseRecord(fields, input.fields);
    if (!parsed.ok) {
      throw new ValidationError(
        parsed.issues.map((issue) => ({
          path: `fields.${issue.path}`,
          code: 'invalid_value',
          message: issue.message,
        })),
      );
    }

    return this.prisma.transact(tenant, async (tx) => {
      const repo = new RecordRepository(tx, tenant);
      const before = await repo.findById(tableId, recordId);
      const changes = repo.diff(fields, before.data, parsed.values);

      if (Object.keys(changes).length === 0) {
        return {
          id: before.id,
          version: before.version,
          autoNumber: before.autoNumber,
          createdAt: before.createdAt.toISOString(),
          updatedAt: before.updatedAt.toISOString(),
          fields: serializeRecord(fields, before.data),
        };
      }

      const applied: Record<string, unknown> = {};
      for (const fieldId of Object.keys(changes)) applied[fieldId] = parsed.values[fieldId] ?? null;

      const result = await repo.update({
        tableId,
        recordId,
        fields,
        changes: applied,
        ...(input.version !== undefined ? { expectedVersion: input.version } : {}),
        actorId: actor,
      });

      if (!result.updated || !result.record) {
        // Zero rows affected with a version supplied means somebody else committed first. The
        // existing value is preserved and the caller is told, rather than being silently
        // overwritten — see docs/06-realtime-collaboration.md §3.
        throw recordConflict(recordId, input.version ?? before.version);
      }

      await new TableRepository(tx, tenant).bumpDataVersion(tableId);

      await tx.recordRevision.create({
        data: {
          id: newId('event'),
          organizationId: tenant.organizationId,
          tableId,
          recordId,
          version: result.record.version,
          changes: changes as never,
          actorType: tenant.principal.type,
          actorId: actor,
          source: 'api',
          correlationId: tenant.correlationId,
        },
      });

      await this.outbox.append(tx, tenant, 'record.updated', {
        tableId,
        recordId,
        version: result.record.version,
        changed: changes,
      });

      // Only the fields this write actually touched travel to other viewers, which is what keeps
      // a single-cell edit a small message rather than a whole-record payload.
      this.announce(tableId, actingUserId(tenant.principal), 'update', [
        {
          id: result.record.id,
          version: result.record.version,
          changed: serializeRecord(
            fields.filter((field) => Object.hasOwn(changes, field.id)),
            result.record.data,
          ) as Record<string, unknown>,
        },
      ]);

      return {
        id: result.record.id,
        version: result.record.version,
        autoNumber: result.record.autoNumber,
        createdAt: result.record.createdAt.toISOString(),
        updatedAt: result.record.updatedAt.toISOString(),
        fields: serializeRecord(fields, result.record.data),
      };
    });
  }

  async deleteMany(tenant: TenantContext, tableId: string, recordIds: readonly string[]) {
    const actor = actingUserId(tenant.principal);
    const organization = await new OrganizationRepository(this.prisma.read, tenant).findById();
    const retentionDays = PLAN_ENTITLEMENTS[organization.plan as Plan].trashRetentionDays;

    return this.prisma.transact(tenant, async (tx) => {
      const deleted = await new RecordRepository(tx, tenant).softDeleteMany(tableId, recordIds);
      await new TableRepository(tx, tenant).bumpDataVersion(tableId, -deleted);

      for (const recordId of recordIds) {
        await tx.deletedItem.create({
          data: {
            id: newId('event'),
            organizationId: tenant.organizationId,
            resourceType: 'record',
            resourceId: recordId,
            parentType: 'table',
            parentId: tableId,
            deletedById: actor,
            purgeAfter: new Date(Date.now() + retentionDays * 86_400_000),
          },
        });

        await this.outbox.append(tx, tenant, 'record.deleted', {
          tableId,
          recordId,
          version: 0,
          changed: {},
        });
      }

      await this.audit.write(tx, tenant, {
        action: 'record.deleted',
        resourceType: 'table',
        resourceId: tableId,
        before: { count: deleted },
      });

      this.announce(
        tableId,
        actingUserId(tenant.principal),
        'delete',
        recordIds.map((id) => ({ id, version: 0 })),
      );

      return { deleted };
    });
  }

  // ── Helpers ───────────────────────────────────────────────────────────────

  private async fieldsFor(tenant: TenantContext, tableId: string): Promise<FieldDefinition[]> {
    const fields = await new FieldRepository(this.prisma.read, tenant).listForTable(tableId);
    if (fields.length === 0) {
      throw new AppError('NOT_FOUND', 'This table has no fields.');
    }
    return fields;
  }

  private async assertRecordQuota(
    tenant: TenantContext,
    tableId: string,
    additional: number,
  ): Promise<void> {
    const organization = await new OrganizationRepository(this.prisma.read, tenant).findById();
    const limit = PLAN_ENTITLEMENTS[organization.plan as Plan].recordsPerBase;
    if (limit === null) return;

    const table = await new TableRepository(this.prisma.read, tenant).findById(tableId);
    const tables = await new TableRepository(this.prisma.read, tenant).listForBase(table.baseId);
    const current = tables.reduce((total, row) => total + row.recordCount, 0);

    if (current + additional > limit) {
      throw new AppError(
        'PLAN_LIMIT_EXCEEDED',
        `The ${organization.plan} plan allows ${limit.toLocaleString()} records per base.`,
        { details: { limit: 'recordsPerBase', allowed: limit, usage: current } },
      );
    }
  }
}

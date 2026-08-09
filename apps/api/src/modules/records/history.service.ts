import { Injectable } from '@nestjs/common';
import { FieldRepository } from '@tessera/database';
import { serializeRecord, type FieldDefinition } from '@tessera/fields';
import { AppError, type TenantContext } from '@tessera/types';

import { PrismaService } from '../../infrastructure/prisma.service';

/**
 * Record history.
 *
 * Revisions are stored as **diffs**, not snapshots (`{ fieldId: { from, to } }`). A table with
 * sixty fields edited a hundred times would otherwise store six thousand values to describe a
 * hundred changes, and the history table would outgrow the data it describes within weeks.
 *
 * The cost of diffs is that "what did this record look like on Tuesday" is a fold rather than a
 * lookup — which is what `stateAt` does, replaying backwards from the present.
 */
@Injectable()
export class HistoryService {
  constructor(private readonly prisma: PrismaService) {}

  /** The change log for one record, newest first. */
  async list(
    tenant: TenantContext,
    recordId: string,
    options: { limit?: number; before?: number } = {},
  ) {
    const record = await this.requireRecord(tenant, recordId);
    const fields = await this.fieldsFor(tenant, record.tableId);
    const byId = new Map(fields.map((field) => [field.id, field]));

    const revisions = await this.prisma.read.recordRevision.findMany({
      where: {
        organizationId: tenant.organizationId,
        recordId,
        ...(options.before !== undefined ? { version: { lt: options.before } } : {}),
      },
      orderBy: { version: 'desc' },
      take: Math.min(options.limit ?? 50, 200),
    });

    return revisions.map((revision) => ({
      version: revision.version,
      actorId: revision.actorId,
      actorType: revision.actorType,
      source: revision.source,
      createdAt: revision.createdAt.toISOString(),
      // Field names travel with the diff so the panel does not need a second request, and so a
      // change to a field that has since been deleted still reads as something rather than as a
      // bare id.
      changes: Object.entries(revision.changes as Record<string, { from?: unknown; to?: unknown }>).map(
        ([fieldId, change]) => ({
          fieldId,
          fieldName: byId.get(fieldId)?.name ?? null,
          from: change.from ?? null,
          to: change.to ?? null,
        }),
      ),
    }));
  }

  /**
   * The record as it stood at a given version.
   *
   * Replays backwards from the current state, undoing each diff newer than the target. Going
   * forwards from empty would be wrong: the earliest revision is not necessarily the record's
   * creation, because history is pruned and an import can create a record with values already in
   * place.
   */
  async stateAt(tenant: TenantContext, recordId: string, version: number) {
    const record = await this.requireRecord(tenant, recordId);
    if (version > record.version) {
      throw new AppError('VALIDATION_FAILED', 'That version is newer than the record.');
    }

    const newer = await this.prisma.read.recordRevision.findMany({
      where: { organizationId: tenant.organizationId, recordId, version: { gt: version } },
      orderBy: { version: 'desc' },
    });

    const data: Record<string, unknown> = { ...(record.data as Record<string, unknown>) };

    for (const revision of newer) {
      for (const [fieldId, change] of Object.entries(
        revision.changes as Record<string, { from?: unknown }>,
      )) {
        // `from` absent means the field did not exist before this change, so undoing it removes
        // the value rather than setting it to null — null is a value a user can have chosen.
        if (change.from === undefined) delete data[fieldId];
        else data[fieldId] = change.from;
      }
    }

    const fields = await this.fieldsFor(tenant, record.tableId);
    return {
      recordId,
      version,
      fields: serializeRecord(fields, data),
      // True when nothing newer exists, i.e. the requested version is the current one.
      isCurrent: newer.length === 0,
    };
  }

  /** Activity across a whole table, for the base's activity feed. */
  async forTable(tenant: TenantContext, tableId: string, options: { limit?: number } = {}) {
    const revisions = await this.prisma.read.recordRevision.findMany({
      where: { organizationId: tenant.organizationId, tableId },
      orderBy: { createdAt: 'desc' },
      take: Math.min(options.limit ?? 100, 500),
    });

    return revisions.map((revision) => ({
      recordId: revision.recordId,
      version: revision.version,
      actorId: revision.actorId,
      source: revision.source,
      createdAt: revision.createdAt.toISOString(),
      changedFieldIds: Object.keys(revision.changes as Record<string, unknown>),
    }));
  }

  private async requireRecord(tenant: TenantContext, recordId: string) {
    const record = await this.prisma.read.record.findFirst({
      where: { id: recordId, organizationId: tenant.organizationId, deletedAt: null },
      select: { id: true, tableId: true, version: true, data: true },
    });
    if (!record) throw new AppError('NOT_FOUND', 'That record no longer exists.');
    return record;
  }

  private async fieldsFor(tenant: TenantContext, tableId: string): Promise<FieldDefinition[]> {
    return new FieldRepository(this.prisma.read, tenant).listForTable(tableId);
  }
}

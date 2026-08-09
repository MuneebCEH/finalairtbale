import { Injectable } from '@nestjs/common';
import { newId } from '@tessera/database';
import { channelFor } from '@tessera/realtime';
import { AppError, actingUserId, type TenantContext } from '@tessera/types';
import {
  filterFieldIds,
  pruneDeletedField,
  requiredFieldIds,
  viewSchema,
  type View,
  type ViewConfig,
} from '@tessera/views';

import { PrismaService } from '../../infrastructure/prisma.service';
import { RealtimeGateway } from '../realtime/realtime.gateway';

/**
 * Views.
 *
 * A view is stored as two blobs — `config` (filters, sorts, grouping, field visibility) and
 * `typeConfig` (the kanban stack field, the calendar date field, the chart spec) — validated
 * together by `@tessera/views` before either is written. Splitting them in the database and
 * validating them as one object is deliberate: the split is how a type change keeps everything
 * still meaningful, and the joint validation is what stops a kanban being saved without the
 * field it stacks by.
 */
@Injectable()
export class ViewsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly realtime: RealtimeGateway,
  ) {}

  async list(tenant: TenantContext, tableId: string) {
    const userId = actingUserId(tenant.principal);

    const rows = await this.prisma.read.view.findMany({
      where: {
        organizationId: tenant.organizationId,
        tableId,
        deletedAt: null,
        // A personal view belongs to one person and is not part of the shared schema; showing
        // somebody else's would leak both their filters and the fact that they made one.
        OR: [{ isPersonal: false }, { ownerId: userId }],
      },
      orderBy: [{ position: 'asc' }, { createdAt: 'asc' }],
    });

    return rows.map((row) => this.present(row));
  }

  async get(tenant: TenantContext, viewId: string) {
    return this.present(await this.requireView(tenant, viewId));
  }

  async create(
    tenant: TenantContext,
    tableId: string,
    input: { name: string; view: View; isPersonal?: boolean; description?: string; icon?: string },
  ) {
    const userId = actingUserId(tenant.principal);
    if (!userId) throw new AppError('FORBIDDEN', 'Only a signed-in user can create a view.');

    await this.assertFieldsExist(tenant, tableId, input.view);

    const last = await this.prisma.read.view.findFirst({
      where: { organizationId: tenant.organizationId, tableId, deletedAt: null },
      orderBy: { position: 'desc' },
      select: { position: true },
    });

    const row = await this.prisma.client.view.create({
      data: {
        id: newId('view'),
        organizationId: tenant.organizationId,
        tableId,
        name: input.name,
        type: input.view.config.type,
        description: input.description ?? null,
        icon: input.icon ?? null,
        position: (last?.position ?? -1) + 1,
        isPersonal: input.isPersonal ?? false,
        ownerId: input.isPersonal ? userId : null,
        config: this.toConfig(input.view) as never,
        typeConfig: input.view.config as never,
        createdById: userId,
      },
    });

    this.announce(tableId, 'view.updated', row.id);
    return this.present(row);
  }

  async update(tenant: TenantContext, viewId: string, input: { name?: string; view?: View; expectedVersion?: number }) {
    const existing = await this.requireView(tenant, viewId);

    if (existing.lockedAt) {
      throw new AppError('FORBIDDEN', 'This view is locked. Unlock it before changing it.');
    }

    // Optimistic concurrency, same as records: two people rearranging one view at once would
    // otherwise have the later save silently discard the earlier one's filters.
    if (input.expectedVersion !== undefined && input.expectedVersion !== existing.version) {
      throw new AppError('SCHEMA_CONFLICT', 'Someone else changed this view. Reload and try again.', {
        details: { expected: input.expectedVersion, actual: existing.version },
      });
    }

    if (input.view) await this.assertFieldsExist(tenant, existing.tableId, input.view);

    const row = await this.prisma.client.view.update({
      where: { id: viewId },
      data: {
        ...(input.name !== undefined ? { name: input.name } : {}),
        ...(input.view
          ? {
              type: input.view.config.type,
              config: this.toConfig(input.view) as never,
              typeConfig: input.view.config as never,
            }
          : {}),
        version: { increment: 1 },
      },
    });

    this.announce(existing.tableId, 'view.updated', viewId);
    return this.present(row);
  }

  async remove(tenant: TenantContext, viewId: string) {
    const existing = await this.requireView(tenant, viewId);

    const remaining = await this.prisma.read.view.count({
      where: { organizationId: tenant.organizationId, tableId: existing.tableId, deletedAt: null },
    });
    // A table with no views has nothing to render. Refusing here is kinder than silently
    // recreating a default one, which would look like the delete failing.
    if (remaining <= 1) throw new AppError('VALIDATION_FAILED', 'A table needs at least one view.');

    await this.prisma.client.view.update({ where: { id: viewId }, data: { deletedAt: new Date() } });
    this.announce(existing.tableId, 'view.updated', viewId);
    return { deleted: true };
  }

  async setLocked(tenant: TenantContext, viewId: string, locked: boolean) {
    const existing = await this.requireView(tenant, viewId);
    const userId = actingUserId(tenant.principal);

    const row = await this.prisma.client.view.update({
      where: { id: viewId },
      data: {
        lockedAt: locked ? new Date() : null,
        lockedById: locked ? userId : null,
      },
    });

    this.announce(existing.tableId, 'view.updated', viewId);
    return this.present(row);
  }

  /**
   * Rewrites every view in a table after a field is deleted.
   *
   * Called by the field service inside the same transaction as the delete. Without it, a view
   * keeps a filter on a field that no longer exists, and the query compiler fails on read — the
   * table becomes unopenable because of a change made somewhere else.
   */
  async onFieldDeleted(tenant: TenantContext, tableId: string, fieldId: string): Promise<string[]> {
    const rows = await this.prisma.read.view.findMany({
      where: { organizationId: tenant.organizationId, tableId, deletedAt: null },
    });

    const affected: string[] = [];

    for (const row of rows) {
      const view = this.toView(row);
      const { view: pruned, changes } = pruneDeletedField(view, fieldId);
      if (changes.length === 0) continue;

      await this.prisma.client.view.update({
        where: { id: row.id },
        data: {
          type: pruned.config.type,
          config: this.toConfig(pruned) as never,
          typeConfig: pruned.config as never,
          version: { increment: 1 },
        },
      });
      affected.push(row.id);
    }

    if (affected.length > 0) this.announce(tableId, 'view.updated', affected[0] as string);
    return affected;
  }

  // ── Helpers ───────────────────────────────────────────────────────────────

  /**
   * Refuses a view that references a field which does not exist.
   *
   * The schema cannot check this — it knows the shape of an id, not whether the table has one —
   * and letting it through produces a view that fails on every read rather than on the save that
   * caused it.
   */
  private async assertFieldsExist(tenant: TenantContext, tableId: string, view: View): Promise<void> {
    const referenced = new Set([
      ...requiredFieldIds(view.config),
      ...(view.filter ? filterFieldIds(view.filter) : []),
      ...(view.sorts ?? []).map((sort) => sort.fieldId),
      ...(view.groups ?? []).map((group) => group.fieldId),
    ]);

    if (referenced.size === 0) return;

    const found = await this.prisma.read.field.findMany({
      where: {
        organizationId: tenant.organizationId,
        tableId,
        id: { in: [...referenced] },
        deletedAt: null,
      },
      select: { id: true },
    });

    const missing = [...referenced].filter((id) => !found.some((field) => field.id === id));
    if (missing.length > 0) {
      throw new AppError('VALIDATION_FAILED', 'This view refers to fields that are not in the table.', {
        details: { missing },
      });
    }
  }

  private async requireView(tenant: TenantContext, viewId: string) {
    const userId = actingUserId(tenant.principal);
    const row = await this.prisma.read.view.findFirst({
      where: {
        id: viewId,
        organizationId: tenant.organizationId,
        deletedAt: null,
        OR: [{ isPersonal: false }, { ownerId: userId }],
      },
    });
    if (!row) throw new AppError('NOT_FOUND', 'That view no longer exists.');
    return row;
  }

  /** The parts of a view that are not type-specific. */
  private toConfig(view: View): Record<string, unknown> {
    return {
      ...(view.filter ? { filter: view.filter } : {}),
      sorts: view.sorts ?? [],
      groups: view.groups ?? [],
      hiddenFieldIds: view.hiddenFieldIds ?? [],
      fieldOrder: view.fieldOrder ?? [],
      ...(view.fieldWidths ? { fieldWidths: view.fieldWidths } : {}),
    };
  }

  /** Reassembles the stored halves into the object `@tessera/views` validates. */
  private toView(row: { name: string; config: unknown; typeConfig: unknown }): View {
    const parsed = viewSchema.safeParse({
      name: row.name,
      config: row.typeConfig as ViewConfig,
      ...(row.config as Record<string, unknown>),
    });

    // A row that no longer validates is not a reason to fail the request: it predates a schema
    // change or was restored from a backup. It degrades to a grid, which always renders.
    if (!parsed.success) return { name: row.name, config: { type: 'grid' } };
    return parsed.data;
  }

  private present(row: {
    id: string;
    tableId: string;
    name: string;
    type: string;
    description: string | null;
    icon: string | null;
    position: number;
    isPersonal: boolean;
    ownerId: string | null;
    lockedAt: Date | null;
    config: unknown;
    typeConfig: unknown;
    version: number;
    createdAt: Date;
    updatedAt: Date;
  }) {
    return {
      id: row.id,
      tableId: row.tableId,
      name: row.name,
      type: row.type,
      description: row.description,
      icon: row.icon,
      position: row.position,
      isPersonal: row.isPersonal,
      ownerId: row.ownerId,
      locked: row.lockedAt !== null,
      version: row.version,
      config: row.typeConfig,
      ...(row.config as Record<string, unknown>),
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    };
  }

  private announce(tableId: string, kind: 'view.updated', id: string): void {
    try {
      const channel = channelFor('table', tableId);
      this.realtime.publish(channel, { t: 'schema', ch: channel, change: { kind, id } });
    } catch {
      // A delivery problem must not fail a committed write.
    }
  }
}

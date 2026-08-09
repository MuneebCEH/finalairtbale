import { Injectable } from '@nestjs/common';
import {
  AuditWriter,
  BaseRepository,
  FieldRepository,
  OrganizationRepository,
  OutboxWriter,
  TableRepository,
  newId,
} from '@tessera/database';
import {
  AppError,
  PLAN_ENTITLEMENTS,
  actingUserId,
  type Plan,
  type TenantContext,
} from '@tessera/types';
import type { CreateBaseInput, CreateTableInput } from '@tessera/validation';

import { PrismaService } from '../../infrastructure/prisma.service';

/**
 * Bases and tables.
 *
 * A base is the unit users actually think in — "the CRM", "the shipping tracker" — so its
 * lifecycle carries the plan limits, the schema version, and the trash entry. Tables live here
 * too rather than in their own service because creating a table is never a standalone act: it
 * bumps the base's schema version and always creates at least one field.
 */
@Injectable()
export class BasesService {
  private readonly outbox = new OutboxWriter();
  private readonly audit = new AuditWriter();

  constructor(private readonly prisma: PrismaService) {}

  // ── Bases ─────────────────────────────────────────────────────────────────

  async list(tenant: TenantContext, workspaceId: string, page: { limit: number; cursor?: string }) {
    return new BaseRepository(this.prisma.read, tenant).listForWorkspace({
      workspaceId,
      limit: page.limit,
      ...(page.cursor ? { cursor: page.cursor } : {}),
    });
  }

  async get(tenant: TenantContext, baseId: string) {
    return new BaseRepository(this.prisma.read, tenant).findById(baseId);
  }

  async create(tenant: TenantContext, workspaceId: string, input: CreateBaseInput) {
    const actor = requireActor(tenant);
    await this.assertBaseQuota(tenant, workspaceId);

    return this.prisma.transact(tenant, async (tx) => {
      const base = await new BaseRepository(tx, tenant).create({
        workspaceId,
        name: input.name,
        ...(input.description !== undefined ? { description: input.description } : {}),
        ...(input.icon !== undefined ? { icon: input.icon } : {}),
        ...(input.color !== undefined ? { color: input.color } : {}),
        createdById: actor,
      });

      // A base with no tables is a dead end in the UI — there is nothing to click. Every new
      // base gets one table with one primary text field, which is the smallest useful thing.
      const table = await new TableRepository(tx, tenant).create({
        baseId: base.id,
        name: 'Table 1',
        createdById: actor,
      });

      const field = await new FieldRepository(tx, tenant).create({
        tableId: table.id,
        name: 'Name',
        type: 'singleLineText',
        options: {},
        isPrimary: true,
        createdById: actor,
      });

      await new TableRepository(tx, tenant).setPrimaryField(table.id, field.id);

      await this.outbox.append(tx, tenant, 'base.created', {
        baseId: base.id,
        workspaceId,
        name: base.name,
      });
      await this.audit.write(tx, tenant, {
        action: 'base.created',
        resourceType: 'base',
        resourceId: base.id,
        after: { name: base.name, workspaceId },
      });

      return base;
    });
  }

  async update(tenant: TenantContext, baseId: string, patch: Record<string, unknown>) {
    const repo = new BaseRepository(this.prisma.client, tenant);
    const before = await repo.findById(baseId);
    const after = await repo.update(baseId, patch);

    await this.prisma.transact(tenant, async (tx) => {
      const diff = this.audit.diff(before as never, after as never);
      await this.audit.write(tx, tenant, {
        action: 'base.updated',
        resourceType: 'base',
        resourceId: baseId,
        before: diff.before,
        after: diff.after,
      });
    });

    return after;
  }

  async setArchived(tenant: TenantContext, baseId: string, archived: boolean) {
    await new BaseRepository(this.prisma.client, tenant).setArchived(baseId, archived);
    await this.prisma.transact(tenant, async (tx) => {
      await this.audit.write(tx, tenant, {
        action: archived ? 'base.archived' : 'base.restored',
        resourceType: 'base',
        resourceId: baseId,
      });
    });
  }

  /**
   * Soft-deletes a base and files it in the trash.
   *
   * The confirmation must match the base name exactly. A base is a team's entire dataset; a
   * modal with an OK button gets clicked reflexively, and typing the name does not.
   */
  async delete(tenant: TenantContext, baseId: string, confirmation: string) {
    const repo = new BaseRepository(this.prisma.client, tenant);
    const base = await repo.findById(baseId);

    if (confirmation !== base.name) {
      throw new AppError('VALIDATION_FAILED', 'Type the base name exactly to confirm deletion.', {
        details: { expected: base.name },
      });
    }

    const organization = await new OrganizationRepository(this.prisma.read, tenant).findById();
    const retentionDays = PLAN_ENTITLEMENTS[organization.plan as Plan].trashRetentionDays;

    await this.prisma.transact(tenant, async (tx) => {
      await new BaseRepository(tx, tenant).softDelete(baseId);

      await tx.deletedItem.create({
        data: {
          id: newId('event'),
          organizationId: tenant.organizationId,
          resourceType: 'base',
          resourceId: baseId,
          parentType: 'workspace',
          parentId: base.workspaceId,
          name: base.name,
          deletedById: actingUserId(tenant.principal),
          purgeAfter: new Date(Date.now() + retentionDays * 86_400_000),
        },
      });

      await this.outbox.append(tx, tenant, 'base.deleted', { baseId, name: base.name });
      await this.audit.write(tx, tenant, {
        action: 'base.deleted',
        resourceType: 'base',
        resourceId: baseId,
        before: { name: base.name },
      });
    });
  }

  // ── Tables ────────────────────────────────────────────────────────────────

  async listTables(tenant: TenantContext, baseId: string) {
    return new TableRepository(this.prisma.read, tenant).listForBase(baseId);
  }

  async getTable(tenant: TenantContext, tableId: string) {
    return new TableRepository(this.prisma.read, tenant).findById(tableId);
  }

  async createTable(tenant: TenantContext, baseId: string, input: CreateTableInput) {
    const actor = requireActor(tenant);

    return this.prisma.transact(tenant, async (tx) => {
      const tables = new TableRepository(tx, tenant);
      const fields = new FieldRepository(tx, tenant);

      const table = await tables.create({
        baseId,
        name: input.name,
        ...(input.description !== undefined ? { description: input.description } : {}),
        ...(input.icon !== undefined ? { icon: input.icon } : {}),
        ...(input.color !== undefined ? { color: input.color } : {}),
        createdById: actor,
      });

      // Caller-supplied fields, or a single primary text field. Either way the table is usable
      // the moment it exists.
      const requested = input.fields?.length
        ? input.fields
        : [{ name: 'Name', type: 'singleLineText' as const }];

      let primaryFieldId: string | null = null;
      for (const [index, definition] of requested.entries()) {
        const created = await fields.create({
          tableId: table.id,
          name: definition.name,
          type: definition.type,
          options: definition.options ?? {},
          ...(definition.isRequired !== undefined ? { isRequired: definition.isRequired } : {}),
          isPrimary: index === 0,
          position: index,
          createdById: actor,
        });
        if (index === 0) primaryFieldId = created.id;
      }

      if (primaryFieldId) await tables.setPrimaryField(table.id, primaryFieldId);
      await new BaseRepository(tx, tenant).bumpSchemaVersion(baseId);

      await this.outbox.append(tx, tenant, 'table.created', {
        tableId: table.id,
        baseId,
        name: table.name,
      });
      await this.audit.write(tx, tenant, {
        action: 'table.created',
        resourceType: 'table',
        resourceId: table.id,
        after: { name: table.name, baseId },
      });

      return { ...table, primaryFieldId };
    });
  }

  async updateTable(tenant: TenantContext, tableId: string, patch: Record<string, unknown>) {
    const repo = new TableRepository(this.prisma.client, tenant);
    const before = await repo.findById(tableId);
    const after = await repo.update(tableId, patch);

    await this.prisma.transact(tenant, async (tx) => {
      await new BaseRepository(tx, tenant).bumpSchemaVersion(before.baseId);
      const diff = this.audit.diff(before as never, after as never);
      await this.audit.write(tx, tenant, {
        action: 'table.updated',
        resourceType: 'table',
        resourceId: tableId,
        before: diff.before,
        after: diff.after,
      });
    });

    return after;
  }

  async deleteTable(tenant: TenantContext, tableId: string, confirmation: string) {
    const repo = new TableRepository(this.prisma.client, tenant);
    const table = await repo.findById(tableId);

    if (confirmation !== table.name) {
      throw new AppError('VALIDATION_FAILED', 'Type the table name exactly to confirm deletion.', {
        details: { expected: table.name },
      });
    }

    // The last table cannot go: a base with no tables cannot be navigated to or recovered from
    // in the UI, so it would strand the user.
    const remaining = await repo.countForBase(table.baseId);
    if (remaining <= 1) {
      throw new AppError('FORBIDDEN', 'A base must keep at least one table.');
    }

    const organization = await new OrganizationRepository(this.prisma.read, tenant).findById();
    const retentionDays = PLAN_ENTITLEMENTS[organization.plan as Plan].trashRetentionDays;

    await this.prisma.transact(tenant, async (tx) => {
      await new TableRepository(tx, tenant).softDelete(tableId);
      await new BaseRepository(tx, tenant).bumpSchemaVersion(table.baseId);

      await tx.deletedItem.create({
        data: {
          id: newId('event'),
          organizationId: tenant.organizationId,
          resourceType: 'table',
          resourceId: tableId,
          parentType: 'base',
          parentId: table.baseId,
          name: table.name,
          deletedById: actingUserId(tenant.principal),
          purgeAfter: new Date(Date.now() + retentionDays * 86_400_000),
        },
      });

      await this.outbox.append(tx, tenant, 'table.deleted', { tableId, name: table.name });
      await this.audit.write(tx, tenant, {
        action: 'table.deleted',
        resourceType: 'table',
        resourceId: tableId,
        before: { name: table.name },
      });
    });
  }

  // ── Limits ────────────────────────────────────────────────────────────────

  private async assertBaseQuota(tenant: TenantContext, workspaceId: string): Promise<void> {
    const organization = await new OrganizationRepository(this.prisma.read, tenant).findById();
    const limit = PLAN_ENTITLEMENTS[organization.plan as Plan].basesPerWorkspace;
    if (limit === null) return;

    const current = await new BaseRepository(this.prisma.read, tenant).countForWorkspace(workspaceId);
    if (current >= limit) {
      throw new AppError(
        'PLAN_LIMIT_EXCEEDED',
        `The ${organization.plan} plan allows ${limit} base${limit === 1 ? '' : 's'} per workspace.`,
        { details: { limit: 'basesPerWorkspace', allowed: limit, usage: current } },
      );
    }
  }
}

function requireActor(tenant: TenantContext): string {
  const actor = actingUserId(tenant.principal);
  if (!actor) throw new AppError('FORBIDDEN', 'This endpoint requires a user credential.');
  return actor;
}

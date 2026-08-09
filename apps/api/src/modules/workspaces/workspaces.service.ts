import { Injectable } from '@nestjs/common';
import {
  AuditWriter,
  OrganizationRepository,
  OutboxWriter,
  UserRepository,
  WorkspaceRepository,
  newId,
} from '@tessera/database';
import {
  AppError,
  PLAN_ENTITLEMENTS,
  actingUserId,
  type Plan,
  type TenantContext,
  type WorkspaceRole,
} from '@tessera/types';
import type { CreateWorkspaceInput } from '@tessera/validation';

import { MembershipService } from '../../infrastructure/membership.service';
import { PrismaService } from '../../infrastructure/prisma.service';

@Injectable()
export class WorkspacesService {
  private readonly outbox = new OutboxWriter();
  private readonly audit = new AuditWriter();

  constructor(
    private readonly prisma: PrismaService,
    private readonly memberships: MembershipService,
  ) {}

  /**
   * Lists workspaces visible to the caller.
   *
   * Organization owners and admins see every workspace; everybody else sees only those they hold
   * a grant on, directly or through a group. The distinction is resolved here and pushed into
   * the query, never applied to the results afterwards.
   */
  async list(
    tenant: TenantContext,
    page: { limit: number; cursor?: string; includeArchived?: boolean },
  ) {
    const userId = actingUserId(tenant.principal);
    if (!userId) throw new AppError('FORBIDDEN', 'This endpoint requires a user credential.');

    const snapshot = await this.memberships.snapshot(tenant.organizationId, userId);
    const seesAll = snapshot.organizationRole === 'owner' || snapshot.organizationRole === 'admin';
    const groupIds = await new UserRepository(this.prisma.read).listGroupIds(userId);

    return new WorkspaceRepository(this.prisma.read, tenant).listVisible({
      userId,
      seesAll,
      groupIds,
      ...(page.includeArchived !== undefined ? { includeArchived: page.includeArchived } : {}),
      limit: page.limit,
      ...(page.cursor ? { cursor: page.cursor } : {}),
    });
  }

  async get(tenant: TenantContext, workspaceId: string) {
    return new WorkspaceRepository(this.prisma.read, tenant).findById(workspaceId);
  }

  /**
   * Creates a workspace and makes its creator the owner.
   *
   * Creating a workspace one cannot then administer would be a bizarre outcome, so the grant is
   * part of the same transaction as the creation.
   */
  async create(tenant: TenantContext, input: CreateWorkspaceInput) {
    const userId = actingUserId(tenant.principal);
    if (!userId) throw new AppError('FORBIDDEN', 'This endpoint requires a user credential.');

    await this.assertWorkspaceQuota(tenant);

    return this.prisma.transact(tenant, async (tx) => {
      const repo = new WorkspaceRepository(tx, tenant);
      const workspace = await repo.create({
        name: input.name,
        ...(input.description !== undefined ? { description: input.description } : {}),
        ...(input.icon !== undefined ? { icon: input.icon } : {}),
        ...(input.color !== undefined ? { color: input.color } : {}),
        createdById: userId,
      });

      await tx.workspaceMember.create({
        data: {
          id: newId('workspace'),
          organizationId: tenant.organizationId,
          workspaceId: workspace.id,
          userId,
          role: 'owner',
          addedById: userId,
        },
      });

      await this.outbox.append(tx, tenant, 'workspace.created', {
        workspaceId: workspace.id,
        name: workspace.name,
        createdBy: userId,
      });

      await this.audit.write(tx, tenant, {
        action: 'workspace.created',
        resourceType: 'workspace',
        resourceId: workspace.id,
        after: { name: workspace.name },
      });

      // The creator's own snapshot now includes a role it did not a moment ago.
      await this.memberships.invalidate(tenant.organizationId, userId);

      return workspace;
    });
  }

  async update(tenant: TenantContext, workspaceId: string, patch: Record<string, unknown>) {
    const repo = new WorkspaceRepository(this.prisma.client, tenant);
    const before = await repo.findById(workspaceId);
    const after = await repo.update(workspaceId, patch);

    await this.prisma.transact(tenant, async (tx) => {
      const diff = this.audit.diff(before as never, after as never);
      await this.audit.write(tx, tenant, {
        action: 'workspace.updated',
        resourceType: 'workspace',
        resourceId: workspaceId,
        before: diff.before,
        after: diff.after,
      });
    });

    return after;
  }

  async setArchived(tenant: TenantContext, workspaceId: string, archived: boolean) {
    await new WorkspaceRepository(this.prisma.client, tenant).setArchived(workspaceId, archived);
    await this.prisma.transact(tenant, async (tx) => {
      await this.audit.write(tx, tenant, {
        action: archived ? 'workspace.archived' : 'workspace.restored',
        resourceType: 'workspace',
        resourceId: workspaceId,
      });
    });
  }

  /**
   * Soft-deletes a workspace and files it in the trash with a retention clock.
   *
   * The confirmation string must match the workspace name. A typed confirmation is a genuine
   * safety control for an action that takes a team's data away — a modal with an "OK" button is
   * clicked reflexively.
   */
  async delete(tenant: TenantContext, workspaceId: string, confirmation: string) {
    const repo = new WorkspaceRepository(this.prisma.client, tenant);
    const workspace = await repo.findById(workspaceId);

    if (confirmation !== workspace.name) {
      throw new AppError(
        'VALIDATION_FAILED',
        'Type the workspace name exactly to confirm deletion.',
        { details: { expected: workspace.name } },
      );
    }

    const organization = await new OrganizationRepository(this.prisma.read, tenant).findById();
    const retentionDays = PLAN_ENTITLEMENTS[organization.plan as Plan].trashRetentionDays;

    await this.prisma.transact(tenant, async (tx) => {
      await new WorkspaceRepository(tx, tenant).softDelete(workspaceId);

      await tx.deletedItem.create({
        data: {
          id: newId('event'),
          organizationId: tenant.organizationId,
          resourceType: 'workspace',
          resourceId: workspaceId,
          name: workspace.name,
          deletedById: actingUserId(tenant.principal),
          purgeAfter: new Date(Date.now() + retentionDays * 86_400_000),
        },
      });

      await this.audit.write(tx, tenant, {
        action: 'workspace.deleted',
        resourceType: 'workspace',
        resourceId: workspaceId,
        before: { name: workspace.name },
      });
    });
  }

  // ── Membership ─────────────────────────────────────────────────────────────

  async listMembers(tenant: TenantContext, workspaceId: string) {
    return new WorkspaceRepository(this.prisma.read, tenant).listMembers(workspaceId);
  }

  async addMember(
    tenant: TenantContext,
    workspaceId: string,
    input: { userId?: string; groupId?: string; role: WorkspaceRole },
  ) {
    const actor = actingUserId(tenant.principal);
    if (!actor) throw new AppError('FORBIDDEN', 'This endpoint requires a user credential.');

    // A workspace grant is meaningless — and a data-leak risk — if the subject is not in the
    // organization at all.
    if (input.userId) {
      const member = await new OrganizationRepository(this.prisma.read, tenant).findMember(
        input.userId,
      );
      if (!member) {
        throw new AppError(
          'VALIDATION_FAILED',
          'That person must be a member of the organization before they can join a workspace.',
        );
      }
    }

    await new WorkspaceRepository(this.prisma.client, tenant).addMember({
      workspaceId,
      ...(input.userId ? { userId: input.userId } : {}),
      ...(input.groupId ? { groupId: input.groupId } : {}),
      role: input.role,
      addedById: actor,
    });

    await this.prisma.transact(tenant, async (tx) => {
      await this.audit.write(tx, tenant, {
        action: 'workspace.member_added',
        resourceType: 'workspace',
        resourceId: workspaceId,
        after: { userId: input.userId, groupId: input.groupId, role: input.role },
      });
    });

    if (input.userId) await this.memberships.invalidate(tenant.organizationId, input.userId);
    else await this.memberships.invalidateOrganization(tenant.organizationId);
  }

  async updateMemberRole(
    tenant: TenantContext,
    workspaceId: string,
    subject: { userId?: string; groupId?: string },
    role: WorkspaceRole,
  ) {
    await new WorkspaceRepository(this.prisma.client, tenant).updateMemberRole(
      workspaceId,
      subject,
      role,
    );
    if (subject.userId) await this.memberships.invalidate(tenant.organizationId, subject.userId);
    else await this.memberships.invalidateOrganization(tenant.organizationId);
  }

  async removeMember(
    tenant: TenantContext,
    workspaceId: string,
    subject: { userId?: string; groupId?: string },
  ) {
    await new WorkspaceRepository(this.prisma.client, tenant).removeMember(workspaceId, subject);

    await this.prisma.transact(tenant, async (tx) => {
      await this.audit.write(tx, tenant, {
        action: 'workspace.member_removed',
        resourceType: 'workspace',
        resourceId: workspaceId,
        before: subject as Record<string, unknown>,
      });
    });

    if (subject.userId) await this.memberships.invalidate(tenant.organizationId, subject.userId);
    else await this.memberships.invalidateOrganization(tenant.organizationId);
  }

  private async assertWorkspaceQuota(tenant: TenantContext): Promise<void> {
    const organization = await new OrganizationRepository(this.prisma.read, tenant).findById();
    const limit = PLAN_ENTITLEMENTS[organization.plan as Plan].workspaces;
    if (limit === null) return;

    const current = await new WorkspaceRepository(this.prisma.read, tenant).countActive();
    if (current >= limit) {
      throw new AppError(
        'PLAN_LIMIT_EXCEEDED',
        `The ${organization.plan} plan allows ${limit} workspace${limit === 1 ? '' : 's'}.`,
        { details: { limit: 'workspaces', allowed: limit, usage: current } },
      );
    }
  }
}

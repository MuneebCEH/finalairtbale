import {
  type Page,
  type TenantContext,
  type WorkspaceRole,
  decodeCursor,
  encodeCursor,
} from '@tessera/types';

import type { Db, TransactionClient } from '../client';
import { newId } from '../ids';
import { TenantScopedRepository } from '../tenant/tenant-repository';

export interface WorkspaceRecord {
  id: string;
  organizationId: string;
  name: string;
  description: string | null;
  icon: string | null;
  color: string | null;
  position: number;
  archivedAt: Date | null;
  createdById: string;
  createdAt: Date;
  updatedAt: Date;
}

export class WorkspaceRepository extends TenantScopedRepository {
  constructor(db: Db | TransactionClient, ctx: TenantContext) {
    super(db, ctx);
  }

  /**
   * Lists workspaces the given user can see.
   *
   * Visibility is pushed into SQL rather than applied after the fact. Post-filtering a paginated
   * query produces short pages and, worse, a cursor that skips rows — the page boundary is
   * computed before the filter runs. Every list endpoint in the platform follows this rule.
   */
  async listVisible(input: {
    userId: string;
    /** Organization owners and admins see everything; members see only their memberships. */
    seesAll: boolean;
    groupIds: readonly string[];
    includeArchived?: boolean;
    limit: number;
    cursor?: string;
  }): Promise<Page<WorkspaceRecord>> {
    const limit = this.take(input.limit);
    const cursor = input.cursor ? decodeCursor(input.cursor) : null;

    const visibility = input.seesAll
      ? {}
      : {
          members: {
            some: {
              OR: [
                { userId: input.userId },
                ...(input.groupIds.length ? [{ groupId: { in: [...input.groupIds] } }] : []),
              ],
            },
          },
        };

    const rows = await this.db.workspace.findMany({
      where: {
        ...this.scopeLive(),
        ...(input.includeArchived ? {} : { archivedAt: null }),
        ...visibility,
        ...(cursor ? { id: { gt: cursor.i } } : {}),
      },
      orderBy: [{ position: 'asc' }, { id: 'asc' }],
      take: limit + 1,
    });

    const hasMore = rows.length > limit;
    const page = hasMore ? rows.slice(0, limit) : rows;
    const last = page.at(-1);

    return {
      data: page as WorkspaceRecord[],
      meta: {
        hasMore,
        count: page.length,
        nextCursor:
          hasMore && last
            ? encodeCursor({ v: 1, k: [last.position], i: last.id, q: 'workspaces' })
            : null,
      },
    };
  }

  async findById(workspaceId: string): Promise<WorkspaceRecord> {
    const row = await this.db.workspace.findFirst({
      where: this.scopeLive({ id: workspaceId }),
    });
    return this.required(row, 'Workspace', workspaceId) as WorkspaceRecord;
  }

  async create(input: {
    name: string;
    description?: string;
    icon?: string;
    color?: string;
    createdById: string;
  }): Promise<WorkspaceRecord> {
    const maxPosition = await this.db.workspace.aggregate({
      where: this.scopeLive(),
      _max: { position: true },
    });

    const row = await this.db.workspace.create({
      data: {
        id: newId('workspace'),
        organizationId: this.organizationId,
        name: input.name,
        description: input.description ?? null,
        icon: input.icon ?? null,
        color: input.color ?? null,
        position: (maxPosition._max.position ?? 0) + 1,
        createdById: input.createdById,
      },
    });
    return row as WorkspaceRecord;
  }

  async update(
    workspaceId: string,
    data: Partial<Pick<WorkspaceRecord, 'name' | 'description' | 'icon' | 'color' | 'position'>>,
  ): Promise<WorkspaceRecord> {
    // `updateMany` with a tenant-scoped where, then re-read — rather than `update` on the id
    // alone, which would be a cross-tenant write if the id were guessed.
    const result = await this.db.workspace.updateMany({
      where: this.scopeLive({ id: workspaceId }),
      data,
    });
    if (result.count === 0) this.required(null, 'Workspace', workspaceId);
    return this.findById(workspaceId);
  }

  async setArchived(workspaceId: string, archived: boolean): Promise<void> {
    const result = await this.db.workspace.updateMany({
      where: this.scopeLive({ id: workspaceId }),
      data: { archivedAt: archived ? new Date() : null },
    });
    if (result.count === 0) this.required(null, 'Workspace', workspaceId);
  }

  /** Soft delete. The trash row and the retention clock are written by the service layer. */
  async softDelete(workspaceId: string): Promise<void> {
    const result = await this.db.workspace.updateMany({
      where: this.scopeLive({ id: workspaceId }),
      data: { deletedAt: new Date() },
    });
    if (result.count === 0) this.required(null, 'Workspace', workspaceId);
  }

  async countActive(): Promise<number> {
    return this.db.workspace.count({ where: this.scopeLive({ archivedAt: null }) });
  }

  // ── Membership ─────────────────────────────────────────────────────────────

  async addMember(input: {
    workspaceId: string;
    userId?: string;
    groupId?: string;
    role: WorkspaceRole;
    addedById: string;
  }): Promise<void> {
    await this.db.workspaceMember.create({
      data: {
        id: newId('workspace'),
        organizationId: this.organizationId,
        workspaceId: input.workspaceId,
        userId: input.userId ?? null,
        groupId: input.groupId ?? null,
        role: input.role,
        addedById: input.addedById,
      },
    });
  }

  async updateMemberRole(
    workspaceId: string,
    subject: { userId?: string; groupId?: string },
    role: WorkspaceRole,
  ): Promise<void> {
    const result = await this.db.workspaceMember.updateMany({
      where: this.scope({
        workspaceId,
        ...(subject.userId ? { userId: subject.userId } : {}),
        ...(subject.groupId ? { groupId: subject.groupId } : {}),
      }),
      data: { role },
    });
    if (result.count === 0) this.required(null, 'Workspace member');
  }

  async removeMember(
    workspaceId: string,
    subject: { userId?: string; groupId?: string },
  ): Promise<void> {
    const result = await this.db.workspaceMember.deleteMany({
      where: this.scope({
        workspaceId,
        ...(subject.userId ? { userId: subject.userId } : {}),
        ...(subject.groupId ? { groupId: subject.groupId } : {}),
      }),
    });
    if (result.count === 0) this.required(null, 'Workspace member');
  }

  async listMembers(workspaceId: string) {
    return this.db.workspaceMember.findMany({
      where: this.scope({ workspaceId }),
      select: {
        id: true,
        role: true,
        createdAt: true,
        user: { select: { id: true, email: true, name: true, avatarUrl: true } },
        group: { select: { id: true, name: true } },
      },
      orderBy: { createdAt: 'asc' },
      take: 500,
    });
  }
}

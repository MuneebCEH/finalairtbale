import { Injectable } from '@nestjs/common';
import { newId } from '@tessera/database';
import { channelFor } from '@tessera/realtime';
import { AppError, actingUserId, type TenantContext } from '@tessera/types';

import { PrismaService } from '../../infrastructure/prisma.service';
import { RealtimeGateway } from '../realtime/realtime.gateway';

/**
 * In-app notifications.
 *
 * The design point is **grouping**. Ten comments on one record should be one line in the panel
 * saying "10 new comments", not ten lines that bury everything else. `groupKey` is what collapses
 * them, and it is computed rather than supplied so two call sites cannot disagree about what
 * counts as "the same thing".
 */
@Injectable()
export class NotificationsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly realtime: RealtimeGateway,
  ) {}

  async list(
    tenant: TenantContext,
    options: { unreadOnly?: boolean; limit?: number } = {},
  ) {
    const userId = actingUserId(tenant.principal);
    if (!userId) throw new AppError('FORBIDDEN', 'Only a signed-in user has notifications.');

    const rows = await this.prisma.read.notification.findMany({
      where: {
        organizationId: tenant.organizationId,
        userId,
        ...(options.unreadOnly ? { readAt: null } : {}),
      },
      orderBy: { createdAt: 'desc' },
      take: Math.min(options.limit ?? 50, 200),
    });

    return rows.map((row) => ({
      id: row.id,
      type: row.type,
      title: row.title,
      body: row.body,
      targetUrl: row.targetUrl,
      count: row.groupCount,
      readAt: row.readAt?.toISOString() ?? null,
      createdAt: row.createdAt.toISOString(),
    }));
  }

  async unreadCount(tenant: TenantContext): Promise<number> {
    const userId = actingUserId(tenant.principal);
    if (!userId) return 0;
    return this.prisma.read.notification.count({
      where: { organizationId: tenant.organizationId, userId, readAt: null },
    });
  }

  async markRead(tenant: TenantContext, ids: readonly string[] | 'all') {
    const userId = actingUserId(tenant.principal);
    if (!userId) throw new AppError('FORBIDDEN', 'Only a signed-in user has notifications.');

    const result = await this.prisma.client.notification.updateMany({
      // Scoped to the caller's own rows: an id from someone else's list must not be markable,
      // and filtering by userId here is what makes the id non-guessable-in-effect.
      where: {
        organizationId: tenant.organizationId,
        userId,
        readAt: null,
        ...(ids === 'all' ? {} : { id: { in: [...ids] } }),
      },
      data: { readAt: new Date() },
    });

    return { updated: result.count };
  }

  /** Raises a notification per mentioned user, collapsing repeats on the same record. */
  async notifyMentions(
    tenant: TenantContext,
    input: {
      userIds: readonly string[];
      recordId: string;
      tableId: string;
      commentId: string;
      preview: string;
    },
  ): Promise<void> {
    if (input.userIds.length === 0) return;

    const actor = actingUserId(tenant.principal);
    const groupKey = `comment:${input.recordId}`;

    for (const userId of input.userIds) {
      await this.raise(tenant, {
        userId,
        type: 'comment.mention',
        title: 'You were mentioned in a comment',
        body: input.preview,
        targetUrl: `/app/records/${input.recordId}?comment=${input.commentId}`,
        groupKey,
        metadata: { recordId: input.recordId, tableId: input.tableId, actorId: actor },
      });
    }
  }

  /**
   * Creates or collapses a notification, then pushes it live.
   *
   * Collapsing is deliberately limited to rows the recipient has **not read**. Folding a new
   * event into an already-read notification would silently increment a counter the person has
   * dismissed, and they would never learn about the new thing.
   */
  async raise(
    tenant: TenantContext,
    input: {
      userId: string;
      type: string;
      title: string;
      body?: string;
      targetUrl?: string;
      groupKey?: string;
      metadata?: Record<string, unknown>;
    },
  ): Promise<void> {
    const existing = input.groupKey
      ? await this.prisma.read.notification.findFirst({
          where: {
            organizationId: tenant.organizationId,
            userId: input.userId,
            groupKey: input.groupKey,
            readAt: null,
          },
          orderBy: { createdAt: 'desc' },
          select: { id: true, groupCount: true },
        })
      : null;

    const row = existing
      ? await this.prisma.client.notification.update({
          where: { id: existing.id },
          data: {
            groupCount: { increment: 1 },
            title: input.title,
            body: input.body ?? null,
            // Bumped so a collapsed notification rises back to the top of the list rather than
            // staying buried at the position of its first event.
            createdAt: new Date(),
          },
        })
      : await this.prisma.client.notification.create({
          data: {
            id: newId('notification'),
            organizationId: tenant.organizationId,
            userId: input.userId,
            type: input.type,
            title: input.title,
            body: input.body ?? null,
            targetUrl: input.targetUrl ?? null,
            groupKey: input.groupKey ?? null,
            metadata: (input.metadata ?? {}) as never,
          },
        });

    try {
      this.realtime.publishToUser(input.userId, {
        t: 'notification',
        notification: {
          id: row.id,
          type: row.type,
          title: row.title,
          body: row.body,
          targetUrl: row.targetUrl,
          count: row.groupCount,
          createdAt: row.createdAt.toISOString(),
        },
      });
    } catch {
      // The row is saved; the badge updates on next poll. A push failure must not undo it.
    }

    void channelFor;
  }
}

import { Injectable } from '@nestjs/common';
import { newId } from '@tessera/database';
import { channelFor } from '@tessera/realtime';
import { AppError, actingUserId, type TenantContext } from '@tessera/types';
import { mentionedUserIds, toPlainText, type RichTextDocument } from '@tessera/validation';

import { PrismaService } from '../../infrastructure/prisma.service';
import { NotificationsService } from '../notifications/notifications.service';
import { RealtimeGateway } from '../realtime/realtime.gateway';

/**
 * Comments on records.
 *
 * Threading is one level deep on purpose: a reply may hang off a top-level comment, but not off
 * another reply. Arbitrary nesting reads as a tree nobody can follow in a side panel, and every
 * product that allows it ends up rendering it flat anyway.
 */
@Injectable()
export class CommentsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly realtime: RealtimeGateway,
    private readonly notifications: NotificationsService,
  ) {}

  async list(tenant: TenantContext, recordId: string, options: { includeResolved?: boolean } = {}) {
    const record = await this.requireRecord(tenant, recordId);

    const rows = await this.prisma.read.comment.findMany({
      where: {
        organizationId: tenant.organizationId,
        subjectType: 'record',
        subjectId: recordId,
        deletedAt: null,
        ...(options.includeResolved ? {} : { resolvedAt: null }),
      },
      orderBy: { createdAt: 'asc' },
      include: { reactions: true, mentions: true },
    });

    void record;

    /*
     * Author names, resolved in one query for the whole thread.
     *
     * `Comment` holds `authorId` as a plain column with no relation declared, so this cannot be an
     * `include`. Looking each name up per row would be a query per comment; the distinct set is
     * almost always a handful of people even on a long thread.
     *
     * Without this the client has an id and nothing to render, and every comment reads as being
     * from "Someone".
     */
    const authorIds = [...new Set(rows.map((row) => row.authorId))];
    const authors = await this.prisma.read.user.findMany({
      where: { id: { in: authorIds } },
      select: { id: true, name: true },
    });
    const nameOf = new Map(authors.map((author) => [author.id, author.name]));

    return rows.map((row) => ({
      ...this.present(row),
      // Null rather than a placeholder when the account is gone: the caller decides how to show a
      // deleted user, and inventing a name here would put it in the audit trail too.
      authorName: nameOf.get(row.authorId) ?? null,
    }));
  }

  async create(
    tenant: TenantContext,
    recordId: string,
    input: { body: RichTextDocument; parentId?: string; fieldId?: string },
  ) {
    const record = await this.requireRecord(tenant, recordId);
    const authorId = actingUserId(tenant.principal);
    if (!authorId) throw new AppError('FORBIDDEN', 'Only a signed-in user can comment.');

    if (input.parentId) {
      const parent = await this.prisma.read.comment.findFirst({
        where: {
          id: input.parentId,
          organizationId: tenant.organizationId,
          subjectId: recordId,
          deletedAt: null,
        },
        select: { parentId: true },
      });
      if (!parent) throw new AppError('NOT_FOUND', 'That comment no longer exists.');
      // One level: a reply to a reply attaches to the same thread rather than starting a deeper
      // one, so the panel never has to render a tree.
      if (parent.parentId) {
        throw new AppError('VALIDATION_FAILED', 'Replies cannot be nested further.');
      }
    }

    // Mentions are resolved against actual organization membership before anything is stored.
    // Without this, a crafted document could name any user id in the system and cause a
    // notification to be delivered to somebody with no access to the record.
    const mentioned = mentionedUserIds(input.body);
    const members =
      mentioned.length === 0
        ? []
        : await this.prisma.read.organizationMember.findMany({
            where: {
              organizationId: tenant.organizationId,
              userId: { in: mentioned },
              status: 'active',
            },
            select: { userId: true },
          });
    const notifiable = members.map((member) => member.userId).filter((id) => id !== authorId);

    const commentId = newId('comment');
    const created = await this.prisma.client.$transaction(async (tx) => {
      const comment = await tx.comment.create({
        data: {
          id: commentId,
          organizationId: tenant.organizationId,
          baseId: record.baseId,
          subjectType: 'record',
          subjectId: recordId,
          fieldId: input.fieldId ?? null,
          parentId: input.parentId ?? null,
          body: input.body as never,
          // Stored alongside the tree so search and previews never walk it, and so the comment
          // stays searchable if the rich-text format changes later.
          plainText: toPlainText(input.body),
          authorId,
        },
        include: { reactions: true, mentions: true },
      });

      if (notifiable.length > 0) {
        await tx.commentMention.createMany({
          data: notifiable.map((userId) => ({
            commentId,
            userId,
            organizationId: tenant.organizationId,
          })),
        });
      }

      return comment;
    });

    const presented = this.present(created);
    this.announce(record.tableId, recordId, presented);

    // After the commit: a notification about a comment that failed to save is worse than a late
    // one, and the transaction is not held open across the fan-out.
    await this.notifications.notifyMentions(tenant, {
      userIds: notifiable,
      recordId,
      tableId: record.tableId,
      commentId,
      preview: created.plainText.slice(0, 140),
    });

    return presented;
  }

  async update(tenant: TenantContext, commentId: string, body: RichTextDocument) {
    const existing = await this.requireOwnComment(tenant, commentId);

    const updated = await this.prisma.client.comment.update({
      where: { id: existing.id },
      data: { body: body as never, plainText: toPlainText(body), editedAt: new Date() },
      include: { reactions: true, mentions: true },
    });

    const presented = this.present(updated);
    this.announce(existing.tableId, existing.subjectId, presented);
    return presented;
  }

  async remove(tenant: TenantContext, commentId: string) {
    const existing = await this.requireOwnComment(tenant, commentId);

    // Soft delete: a thread with a hole in it is unreadable, and hard-deleting a parent would
    // orphan its replies.
    await this.prisma.client.comment.update({
      where: { id: existing.id },
      data: { deletedAt: new Date() },
    });

    this.announce(existing.tableId, existing.subjectId, { id: commentId, deleted: true });
    return { deleted: true };
  }

  async resolve(tenant: TenantContext, commentId: string, resolved: boolean) {
    const comment = await this.requireComment(tenant, commentId);
    const userId = actingUserId(tenant.principal);

    // Anyone with access may resolve, not only the author: a comment is a request for attention
    // and the person who acts on it is usually not the person who raised it.
    const updated = await this.prisma.client.comment.update({
      where: { id: comment.id },
      data: {
        resolvedAt: resolved ? new Date() : null,
        resolvedById: resolved ? userId : null,
      },
      include: { reactions: true, mentions: true },
    });

    const presented = this.present(updated);
    this.announce(comment.tableId, comment.subjectId, presented);
    return presented;
  }

  async react(tenant: TenantContext, commentId: string, emoji: string, on: boolean) {
    const comment = await this.requireComment(tenant, commentId);
    const userId = actingUserId(tenant.principal);
    if (!userId) throw new AppError('FORBIDDEN', 'Only a signed-in user can react.');

    if (on) {
      // Idempotent: double-clicking a reaction must not fail, and the composite key makes the
      // second attempt a no-op rather than a duplicate row.
      await this.prisma.client.commentReaction.upsert({
        where: { commentId_userId_emoji: { commentId, userId, emoji } },
        create: { commentId, userId, emoji, organizationId: tenant.organizationId },
        update: {},
      });
    } else {
      await this.prisma.client.commentReaction.deleteMany({ where: { commentId, userId, emoji } });
    }

    const updated = await this.prisma.read.comment.findFirstOrThrow({
      where: { id: commentId },
      include: { reactions: true, mentions: true },
    });

    const presented = this.present(updated);
    this.announce(comment.tableId, comment.subjectId, presented);
    return presented;
  }

  // ── Helpers ───────────────────────────────────────────────────────────────

  /** Resolves a record inside the caller's organization, or 404s. */
  private async requireRecord(tenant: TenantContext, recordId: string) {
    const record = await this.prisma.read.record.findFirst({
      where: { id: recordId, organizationId: tenant.organizationId, deletedAt: null },
      select: { id: true, tableId: true },
    });
    if (!record) throw new AppError('NOT_FOUND', 'That record no longer exists.');

    // `records` carries no relation to `tables` — it is denormalised by organization for the
    // row-level security policy — so the base is resolved with a second scoped lookup.
    const table = await this.prisma.read.table.findFirst({
      where: { id: record.tableId, deletedAt: null },
      select: { baseId: true },
    });
    if (!table) throw new AppError('NOT_FOUND', 'That record no longer exists.');

    return { id: record.id, tableId: record.tableId, baseId: table.baseId };
  }

  private async requireComment(tenant: TenantContext, commentId: string) {
    const comment = await this.prisma.read.comment.findFirst({
      where: { id: commentId, organizationId: tenant.organizationId, deletedAt: null },
      select: { id: true, subjectId: true, authorId: true },
    });
    if (!comment) throw new AppError('NOT_FOUND', 'That comment no longer exists.');

    const record = await this.requireRecord(tenant, comment.subjectId);
    return { ...comment, tableId: record.tableId };
  }

  /** Editing and deleting are the author's alone; resolving and reacting are not. */
  private async requireOwnComment(tenant: TenantContext, commentId: string) {
    const comment = await this.requireComment(tenant, commentId);
    if (comment.authorId !== actingUserId(tenant.principal)) {
      throw new AppError('FORBIDDEN', 'Only the author can change a comment.');
    }
    return comment;
  }

  private announce(tableId: string, recordId: string, comment: unknown): void {
    try {
      const channel = channelFor('table', tableId);
      this.realtime.publish(channel, { t: 'comment', ch: channel, comment: { recordId, ...(comment as object) } });
    } catch {
      // A delivery problem must not fail a committed write; the panel refetches on next open.
    }
  }

  private present(row: {
    id: string;
    parentId: string | null;
    fieldId: string | null;
    body: unknown;
    plainText: string;
    authorId: string;
    resolvedAt: Date | null;
    resolvedById: string | null;
    editedAt: Date | null;
    createdAt: Date;
    reactions?: Array<{ userId: string; emoji: string }>;
    mentions?: Array<{ userId: string }>;
  }) {
    // Reactions are grouped for display, with the member list kept so the UI can show who reacted
    // and highlight the viewer's own.
    const grouped = new Map<string, string[]>();
    for (const reaction of row.reactions ?? []) {
      grouped.set(reaction.emoji, [...(grouped.get(reaction.emoji) ?? []), reaction.userId]);
    }

    return {
      id: row.id,
      parentId: row.parentId,
      fieldId: row.fieldId,
      body: row.body,
      plainText: row.plainText,
      authorId: row.authorId,
      resolvedAt: row.resolvedAt?.toISOString() ?? null,
      resolvedById: row.resolvedById,
      editedAt: row.editedAt?.toISOString() ?? null,
      createdAt: row.createdAt.toISOString(),
      mentions: (row.mentions ?? []).map((mention) => mention.userId),
      reactions: [...grouped.entries()].map(([emoji, userIds]) => ({
        emoji,
        count: userIds.length,
        userIds,
      })),
    };
  }
}

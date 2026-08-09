import { Injectable } from '@nestjs/common';
import { parseChannel, type ChannelKind } from '@tessera/realtime';
import { actingUserId, type Principal } from '@tessera/types';

import { PrismaService } from '../../infrastructure/prisma.service';

/**
 * Decides whether a connection may subscribe to a channel.
 *
 * ## Why this is separate from the gateway
 *
 * A WebSocket bypasses every HTTP guard: there is no route, no params, and no `TenantGuard` run.
 * Subscription is therefore the *only* place tenant isolation happens on this transport, which
 * makes it worth its own file and its own tests rather than a branch inside a message handler.
 *
 * The check mirrors what `TenantGuard` does for HTTP: resolve the resource to its organization,
 * then prove the caller is an active member of it. Anything that cannot be resolved is refused —
 * a channel for a deleted or non-existent table is indistinguishable from one for another
 * tenant's table, and both must be denied identically so neither can be probed for.
 */
@Injectable()
export class RealtimeAuthorizer {
  constructor(private readonly prisma: PrismaService) {}

  async maySubscribe(principal: Principal, channel: string): Promise<boolean> {
    const parsed = parseChannel(channel);
    if (!parsed) return false;

    const userId = actingUserId(principal);
    if (!userId) return false;

    // A user channel carries that person's own notifications; nobody else may listen to it.
    if (parsed.kind === 'user') return parsed.id === userId;

    const organizationId = await this.organizationOf(parsed.kind, parsed.id);
    if (!organizationId) return false;

    const membership = await this.prisma.read.organizationMember.findUnique({
      where: { organizationId_userId: { organizationId, userId } },
      select: { status: true },
    });

    return membership?.status === 'active';
  }

  /** Walks a resource up to its organization. Soft-deleted rows resolve to nothing. */
  private async organizationOf(kind: ChannelKind, id: string): Promise<string | null> {
    if (kind === 'table') {
      const row = await this.prisma.read.table.findFirst({
        where: { id, deletedAt: null },
        select: { base: { select: { workspace: { select: { organizationId: true } } } } },
      });
      return row?.base.workspace.organizationId ?? null;
    }

    if (kind === 'base') {
      const row = await this.prisma.read.base.findFirst({
        where: { id, deletedAt: null },
        select: { workspace: { select: { organizationId: true } } },
      });
      return row?.workspace.organizationId ?? null;
    }

    if (kind === 'record') {
      const row = await this.prisma.read.record.findFirst({
        where: { id, deletedAt: null },
        select: { organizationId: true },
      });
      return row?.organizationId ?? null;
    }

    return null;
  }
}

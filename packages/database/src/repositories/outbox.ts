import type { DomainEvent, EventActor, EventType, TenantContext } from '@tessera/types';

import type { TransactionClient } from '../client';
import { newId } from '../ids';

/**
 * The transactional outbox.
 *
 * `append` must be called with the *same* transaction client as the state change it describes.
 * That is the whole point: the event and the change commit or roll back together, so there can
 * be neither a phantom event for a rolled-back write nor a lost event for a committed one.
 * A separate relay process publishes unpublished rows to the bus and marks them published.
 *
 * See docs/01-system-architecture.md §4.
 */
export class OutboxWriter {
  async append<T>(
    tx: TransactionClient,
    ctx: TenantContext,
    type: EventType,
    payload: T,
    options?: { actor?: EventActor; causationId?: string },
  ): Promise<string> {
    const id = newId('event');
    const actor = options?.actor ?? actorFromContext(ctx);

    await tx.domainEventOutbox.create({
      data: {
        id,
        organizationId: ctx.organizationId,
        type,
        version: 1,
        tenant: {
          organizationId: ctx.organizationId,
          ...(ctx.workspaceId ? { workspaceId: ctx.workspaceId } : {}),
          ...(ctx.baseId ? { baseId: ctx.baseId } : {}),
        },
        actor: { type: actor.type, id: actor.id },
        payload: payload as never,
        correlationId: ctx.correlationId,
        causationId: options?.causationId ?? null,
      },
    });

    return id;
  }

  /**
   * Claims a batch of unpublished events for the relay.
   *
   * `FOR UPDATE SKIP LOCKED` lets several relay instances run concurrently without either
   * duplicating work or blocking each other — the standard, and the only correct, way to build a
   * work queue on a relational table.
   */
  async claimUnpublished(
    tx: TransactionClient,
    limit: number,
  ): Promise<Array<DomainEvent<EventType, unknown>>> {
    const rows = await tx.$queryRawUnsafe<
      Array<{
        id: string;
        organization_id: string;
        type: string;
        version: number;
        tenant: unknown;
        actor: unknown;
        payload: unknown;
        correlation_id: string | null;
        causation_id: string | null;
        occurred_at: Date;
      }>
    >(
      `SELECT id, organization_id, type, version, tenant, actor, payload,
              correlation_id, causation_id, occurred_at
         FROM domain_events
        WHERE published_at IS NULL
        ORDER BY occurred_at
        LIMIT $1
          FOR UPDATE SKIP LOCKED`,
      Math.min(limit, 1000),
    );

    return rows.map((row) => ({
      id: row.id as DomainEvent['id'],
      type: row.type as EventType,
      version: 1,
      occurredAt: row.occurred_at.toISOString(),
      tenant: row.tenant as DomainEvent['tenant'],
      actor: row.actor as EventActor,
      correlationId: row.correlation_id ?? 'unknown',
      causationId: row.causation_id,
      payload: row.payload,
    }));
  }

  async markPublished(tx: TransactionClient, ids: readonly string[]): Promise<void> {
    if (ids.length === 0) return;
    await tx.domainEventOutbox.updateMany({
      where: { id: { in: [...ids] } },
      data: { publishedAt: new Date() },
    });
  }
}

function actorFromContext(ctx: TenantContext): EventActor {
  switch (ctx.principal.type) {
    case 'user':
      return { type: 'user', id: ctx.principal.userId };
    case 'api_token':
    case 'oauth':
      return { type: 'api_token', id: ctx.principal.userId };
    case 'service':
      return { type: 'system', id: ctx.principal.service };
    case 'anonymous':
      return { type: 'system', id: null };
  }
}

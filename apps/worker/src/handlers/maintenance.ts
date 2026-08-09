import { SessionRepository, type Db } from '@tessera/database';

import { DEFAULT_RETRY, type JobContext, type JobEnvelope, type JobHandler, type JobResult } from '../runtime/job';

/**
 * Removes expired and long-revoked sessions.
 *
 * Sessions are kept for 30 days after expiry so the "recent activity" view in security settings
 * is useful, then deleted. Retaining them forever would make `user_sessions` one of the largest
 * tables in the database for no product benefit, and would keep IP addresses far longer than any
 * retention policy would justify.
 */
export class PruneSessionsHandler implements JobHandler<Record<string, never>> {
  readonly name = 'session.prune' as const;
  readonly timeoutMs = 120_000;
  readonly retry = DEFAULT_RETRY;
  readonly idempotency = 'natural' as const;

  constructor(private readonly db: Db) {}

  async handle(_job: JobEnvelope<Record<string, never>>, ctx: JobContext): Promise<JobResult> {
    const cutoff = new Date(Date.now() - 30 * 86_400_000);
    const deleted = await new SessionRepository(this.db).prune(cutoff);

    ctx.logger.info('pruned sessions', { deleted, cutoff: cutoff.toISOString() });
    return { ok: true, summary: `${deleted} sessions removed`, metrics: { deleted } };
  }
}

/**
 * Hard-deletes trashed items whose retention window has elapsed.
 *
 * Two safeguards, both deliberate:
 *   • A legal hold on the organization suppresses the purge entirely. Deleting data under hold
 *     is a legal problem, not a housekeeping one.
 *   • Deletion is batched and re-enqueued rather than done in one statement, so a large purge
 *     cannot hold a long transaction or blow out replication lag.
 */
export class PurgeTrashHandler implements JobHandler<{ batchSize?: number }> {
  readonly name = 'trash.purge' as const;
  readonly timeoutMs = 300_000;
  readonly retry = DEFAULT_RETRY;
  readonly idempotency = 'natural' as const;

  constructor(private readonly db: Db) {}

  async handle(job: JobEnvelope<{ batchSize?: number }>, ctx: JobContext): Promise<JobResult> {
    const batchSize = Math.min(job.data.batchSize ?? 500, 2_000);

    const due = await this.db.deletedItem.findMany({
      where: {
        purgeAfter: { lte: new Date() },
        restoredAt: null,
        organization: { legalHold: false },
      },
      select: { id: true, resourceType: true, resourceId: true, organizationId: true },
      take: batchSize,
    });

    if (due.length === 0) {
      return { ok: true, summary: 'nothing due', metrics: { purged: 0 } };
    }

    let purged = 0;
    for (const item of due) {
      if (await ctx.cancelled()) break;

      // Purging is per resource type because the physical deletion differs; the trash row is
      // the index, not the data.
      switch (item.resourceType) {
        case 'workspace':
          await this.db.workspace.deleteMany({ where: { id: item.resourceId } });
          break;
        case 'base':
          await this.db.base.deleteMany({ where: { id: item.resourceId } });
          break;
        case 'table':
          await this.db.table.deleteMany({ where: { id: item.resourceId } });
          break;
        case 'record':
          await this.db.record.deleteMany({ where: { id: item.resourceId } });
          break;
        default:
          ctx.logger.warn('unknown trashed resource type; leaving in place', {
            resourceType: item.resourceType,
            resourceId: item.resourceId,
          });
          continue;
      }

      await this.db.deletedItem.delete({ where: { id: item.id } });
      purged += 1;

      if (purged % 100 === 0) await ctx.progress(Math.round((purged / due.length) * 100));
    }

    ctx.logger.info('purged trashed items', { purged, considered: due.length });
    return { ok: true, summary: `${purged} items purged`, metrics: { purged } };
  }
}

/**
 * Relays the transactional outbox.
 *
 * The claim uses `FOR UPDATE SKIP LOCKED` so several relay instances can run concurrently
 * without duplicating or blocking. Publication is marked in the same transaction as the claim,
 * which means a crash mid-publish re-delivers rather than drops — consumers are idempotent by
 * contract, so at-least-once is the correct trade-off here.
 */
export class RelayOutboxHandler implements JobHandler<{ batchSize?: number }> {
  readonly name = 'outbox.relay' as const;
  readonly timeoutMs = 60_000;
  readonly retry = DEFAULT_RETRY;
  readonly idempotency = 'natural' as const;

  constructor(
    private readonly db: Db,
    private readonly publish: (events: Array<Record<string, unknown>>) => Promise<void>,
  ) {}

  async handle(job: JobEnvelope<{ batchSize?: number }>, ctx: JobContext): Promise<JobResult> {
    const batchSize = Math.min(job.data.batchSize ?? 200, 1_000);

    const published = await this.db.$transaction(async (tx) => {
      const rows = await tx.$queryRawUnsafe<Array<{ id: string; type: string; payload: unknown }>>(
        `SELECT id, type, payload, organization_id, correlation_id, occurred_at
           FROM domain_events
          WHERE published_at IS NULL
          ORDER BY occurred_at
          LIMIT $1
            FOR UPDATE SKIP LOCKED`,
        batchSize,
      );

      if (rows.length === 0) return 0;

      await this.publish(rows as unknown as Array<Record<string, unknown>>);

      await tx.domainEventOutbox.updateMany({
        where: { id: { in: rows.map((row) => row.id) } },
        data: { publishedAt: new Date() },
      });

      return rows.length;
    });

    if (published > 0) ctx.logger.debug('relayed domain events', { published });
    return { ok: true, summary: `${published} events relayed`, metrics: { published } };
  }
}

import type { TenantContext } from '@tessera/types';

import type { TransactionClient } from '../client';
import { newId } from '../ids';

/**
 * Audit logging.
 *
 * Written in the same transaction as the effect it records, for the same reason as the outbox:
 * an audit trail that can disagree with the state it describes is worse than none, because it is
 * trusted.
 *
 * `before`/`after` are field diffs with sensitive values already redacted by the caller. The
 * table is append-only at the database-grant level — the application role holds INSERT and
 * SELECT but not UPDATE or DELETE — so an attacker with application-level access still cannot
 * rewrite history. Retention is enforced by dropping time partitions, and a legal hold blocks
 * the drop.
 */

export interface AuditEntry {
  readonly action: string;
  readonly resourceType: string;
  readonly resourceId?: string;
  readonly before?: Record<string, unknown> | null;
  readonly after?: Record<string, unknown> | null;
  readonly ipAddress?: string | null;
  readonly userAgent?: string | null;
}

export class AuditWriter {
  async write(tx: TransactionClient, ctx: TenantContext, entry: AuditEntry): Promise<void> {
    const { actorType, actorId, impersonatorId } = actorOf(ctx);

    await tx.auditLog.create({
      data: {
        id: newId('event'),
        organizationId: ctx.organizationId,
        actorType,
        actorId,
        impersonatorId,
        action: entry.action,
        resourceType: entry.resourceType,
        resourceId: entry.resourceId ?? null,
        before: (entry.before ?? null) as never,
        after: (entry.after ?? null) as never,
        ipAddress: entry.ipAddress ?? null,
        userAgent: entry.userAgent ?? null,
        correlationId: ctx.correlationId,
      },
    });
  }

  /**
   * Computes a minimal diff between two states.
   *
   * Only changed keys are recorded. Storing full before/after snapshots of every record would
   * multiply the audit table's size by the record width for no analytical gain, and would put
   * copies of sensitive field values in a table with a long retention period.
   */
  diff(
    before: Record<string, unknown>,
    after: Record<string, unknown>,
    options?: { redactKeys?: readonly string[] },
  ): { before: Record<string, unknown>; after: Record<string, unknown> } {
    const redact = new Set((options?.redactKeys ?? []).map((k) => k.toLowerCase()));
    const beforeDiff: Record<string, unknown> = {};
    const afterDiff: Record<string, unknown> = {};

    for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) {
      const b = before[key];
      const a = after[key];
      if (JSON.stringify(b) === JSON.stringify(a)) continue;
      if (redact.has(key.toLowerCase())) {
        beforeDiff[key] = '[redacted]';
        afterDiff[key] = '[redacted]';
      } else {
        beforeDiff[key] = b ?? null;
        afterDiff[key] = a ?? null;
      }
    }

    return { before: beforeDiff, after: afterDiff };
  }
}

function actorOf(ctx: TenantContext): {
  actorType: string;
  actorId: string | null;
  impersonatorId: string | null;
} {
  switch (ctx.principal.type) {
    case 'user':
      return {
        actorType: 'user',
        actorId: ctx.principal.userId,
        impersonatorId: ctx.principal.impersonatorId ?? null,
      };
    case 'api_token':
      return { actorType: 'api_token', actorId: ctx.principal.userId, impersonatorId: null };
    case 'oauth':
      return { actorType: 'oauth', actorId: ctx.principal.userId, impersonatorId: null };
    case 'service':
      return { actorType: 'system', actorId: null, impersonatorId: null };
    case 'anonymous':
      return { actorType: 'anonymous', actorId: null, impersonatorId: null };
  }
}

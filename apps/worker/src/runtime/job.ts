import type { Logger } from '@tessera/logger';
import type { Principal, TenantContext } from '@tessera/types';

/**
 * The job contract.
 *
 * Every handler declares its timeout, retry policy, and idempotency mode as data rather than
 * implementing them ad hoc. That means the runtime — not each handler's author — is responsible
 * for enforcing them, so a handler cannot accidentally ship without a timeout or without a
 * bounded retry.
 *
 * See docs/05-background-jobs.md §2.
 */

export const JOB_NAMES = [
  'email.send',
  'notification.fanout',
  'session.prune',
  'usage.aggregate',
  'trash.purge',
  'outbox.relay',
] as const;

export type JobName = (typeof JOB_NAMES)[number];

export interface JobTenant {
  readonly organizationId: string;
  readonly workspaceId?: string;
  readonly baseId?: string;
}

export interface JobEnvelope<TData = unknown> {
  /** Deterministic, derived from the cause. BullMQ dedupes on it. */
  readonly jobId: string;
  readonly name: JobName;
  /** Absent only for platform-wide maintenance jobs, which is why it is optional and explicit. */
  readonly tenant?: JobTenant;
  readonly actor: { type: 'user' | 'system' | 'automation'; id: string | null };
  readonly correlationId: string;
  readonly causationEventId?: string;
  readonly enqueuedAt: string;
  readonly data: TData;
}

export interface RetryPolicy {
  readonly attempts: number;
  readonly backoffMs: number;
  readonly maxBackoffMs: number;
}

export interface JobContext {
  readonly logger: Logger;
  /** Aborted when the handler exceeds its declared timeout, or when the worker is shutting down. */
  readonly signal: AbortSignal;
  readonly attempt: number;
  progress(percent: number, message?: string): Promise<void>;
  /** True once a cancellation has been requested; long loops should check between batches. */
  cancelled(): Promise<boolean>;
}

export interface JobResult {
  readonly ok: boolean;
  readonly summary?: string;
  readonly metrics?: Record<string, number>;
}

export interface JobHandler<TData = unknown> {
  readonly name: JobName;
  readonly timeoutMs: number;
  readonly retry: RetryPolicy;
  /**
   * `natural`  — re-running the handler produces the same state (an UPSERT, a delete).
   * `guarded`  — the handler has an external side effect (email, webhook, payment) and must take
   *              a Redis guard before acting, because "at least once" delivery would otherwise
   *              mean a user gets the same email five times.
   */
  readonly idempotency: 'natural' | 'guarded';
  handle(job: JobEnvelope<TData>, ctx: JobContext): Promise<JobResult>;
  onFailed?(job: JobEnvelope<TData>, error: Error): Promise<void>;
}

export const DEFAULT_RETRY: RetryPolicy = {
  attempts: 5,
  backoffMs: 1_000,
  maxBackoffMs: 900_000,
};

/**
 * Reconstructs a tenant context inside a worker.
 *
 * Workers act on behalf of the system, not a user, so the principal is a service principal. The
 * organization id still comes from the envelope, which is what keeps every repository the job
 * constructs correctly scoped — a worker has exactly the same isolation guarantees as a request.
 */
export function tenantContextFor(envelope: JobEnvelope, service: string): TenantContext | null {
  if (!envelope.tenant) return null;

  const principal: Principal = { type: 'service', service };
  return {
    organizationId: envelope.tenant.organizationId as never,
    ...(envelope.tenant.workspaceId ? { workspaceId: envelope.tenant.workspaceId as never } : {}),
    ...(envelope.tenant.baseId ? { baseId: envelope.tenant.baseId as never } : {}),
    principal,
    correlationId: envelope.correlationId,
    needsPrimary: true,
  };
}

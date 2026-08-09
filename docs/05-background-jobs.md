# Tessera — Background Job Architecture

BullMQ on Redis. One worker binary (`apps/worker`) that starts a configurable subset of queues, so
the same image can be deployed as differently-scaled fleets.

## 1. Queue topology

| Queue | Concurrency/pod | Fleet | Jobs |
|---|---|---|---|
| `compute` | 8 | CPU-tuned | `formula.recalc`, `rollup.recalc`, `lookup.propagate`, `field.backfill`, `field.promote` |
| `io` | 4 | memory-tuned | `import.parse`, `import.apply`, `export.build`, `base.duplicate`, `base.backup`, `attachment.process` |
| `automation` | 16 | IO-tuned | `automation.dispatch`, `automation.step`, `automation.resume` |
| `delivery` | 32 | IO-tuned | `webhook.deliver`, `email.send`, `notification.fanout`, `push.send` |
| `index` | 8 | IO-tuned | `search.index`, `search.reindex`, `search.delete` |
| `maintenance` | 2 | small | `usage.aggregate`, `retention.sweep`, `trash.purge`, `session.prune`, `analytics.rollup`, `backup.verify` |
| `dlq:*` | — | — | one dead-letter queue per source queue |

Priority within a queue: interactive work (a recalc the user is waiting on) is enqueued with
priority 1; bulk work (a 1M-row backfill) with priority 10.

## 2. The job contract

Every job payload extends a base envelope. There is no way to enqueue a job without tenant
context — the `JobDispatcher` in `packages/events` takes `TenantContext` as its first argument.

```ts
interface JobEnvelope<TName extends JobName> {
  jobId: string;            // deterministic → dedupe
  name: TName;
  tenant: { organizationId: string; workspaceId?: string; baseId?: string };
  actor: { type: 'user' | 'system' | 'automation'; id: string | null };
  correlationId: string;
  causationEventId?: string;
  attempt: number;
  enqueuedAt: string;
  data: JobDataMap[TName];
}
```

Every handler implements:

```ts
interface JobHandler<TName extends JobName> {
  readonly name: TName;
  readonly timeoutMs: number;                 // hard cap, enforced by AbortSignal
  readonly retry: RetryPolicy;                // attempts, backoff, jitter
  readonly idempotency: 'natural' | 'guarded'; // 'guarded' → Redis SETNX before side effects
  handle(job: JobEnvelope<TName>, ctx: JobContext): Promise<JobResult>;
  onFailed?(job: JobEnvelope<TName>, error: Error): Promise<void>;
}
```

`JobContext` provides `signal` (AbortSignal), `logger` (pre-bound with tenant + correlation id),
`progress(pct, message)`, `db` (tenant-scoped), `heartbeat()`, and `cancelled()`.

## 3. Guarantees, per requirement

| Requirement | Implementation |
|---|---|
| **Idempotency** | `jobId = hash(eventId, handlerName)`. BullMQ rejects a duplicate id while the job is in the queue or the recent-completed set. Handlers marked `guarded` additionally take `SETNX job:done:{jobId}` (TTL 7 d) before performing external side effects (email, webhook, Stripe) |
| **Retry policy** | Exponential backoff `min(2^attempt × 1s, 15 min)` with ±20% jitter. Default 5 attempts. Non-retryable errors (`ValidationError`, `PermissionError`, 4xx from a remote) fail immediately |
| **Failure logging** | Every failure logs at `error` with the full envelope (redacted), the attempt number, and the error chain; also emitted to the error tracker with tenant + correlation tags |
| **Dead-letter handling** | Terminal failure moves the envelope to `dlq:{queue}` with the failure history. The admin console lists, inspects, edits, and replays DLQ items. DLQ depth is alerted |
| **Tenant context** | Carried in the envelope; the worker opens its DB transaction with `SET LOCAL app.current_org`, exactly like the API |
| **Correlation id** | Propagated from the originating request through the event to the job and into every log line and span |
| **Timeout** | `timeoutMs` per handler; the `AbortSignal` is passed to DB queries and HTTP calls. A job that ignores its signal is killed by the stalled-job watchdog |
| **Cancellation** | `job.cancel` sets a Redis flag; long jobs check `ctx.cancelled()` between batches and exit cleanly, reverting partial work where the job declares itself transactional |
| **Progress tracking** | `ctx.progress()` writes to the BullMQ progress channel and to a `job_progress` Redis hash the UI polls/subscribes to |

## 4. Notable job designs

### 4.1 `formula.recalc` / `rollup.recalc`

Triggered by `record.updated` / `record.created` / `field.updated`.

```
1. Load the base dependency graph from Redis (rebuild from field_dependencies on miss)
2. BFS from the changed field ids → dependent field set
3. Topologically sort; group by (fieldId, dependency depth)
4. For each level, process records in batches of 500:
     SELECT the record slice + linked values needed
     evaluate the AST for each record (pure, no I/O in the loop)
     UPDATE ... FROM (VALUES …) bulk statement, bumping version
     emit record.updated deltas to the realtime channel (coalesced per 100 ms)
5. Re-enqueue with a cursor if the affected set exceeds the batch budget
```

Coalescing: recalcs for the same `(tableId, fieldId)` arriving within 200 ms are merged into one
job by a debounce key, so a 500-cell paste triggers one recalc pass, not 500.

### 4.2 `import.parse` → `import.apply`

Two stages so the user can review before committing.

```
parse:  stream the upload from S3 (never fully in memory)
        sniff delimiter/encoding, detect header row
        sample 1,000 rows → infer a field type per column with confidence
        write an import_plan row; emit progress
apply:  stream again, chunk 1,000 rows
        per chunk: validate → coerce → dedupe against the merge key → COPY into a temp table
                   → INSERT … ON CONFLICT from temp → collect row errors
        errors accumulate in an errors CSV in S3 (capped at 50k rows)
        final: emit import.completed with counts + error report URL
```

Restartable: the plan stores the last committed chunk index, so a retry resumes rather than
duplicating.

### 4.3 `webhook.deliver`

```
attempt with 10 s timeout → 2xx = success
non-2xx / timeout → retry at 1m, 5m, 30m, 2h, 6h, 24h (6 attempts)
consecutive failures ≥ 15 → endpoint marked unhealthy, deliveries paused, owner notified
every attempt appends a webhook_deliveries row: status, code, latency, response head (2 KB max)
replay is a new delivery with the same event id and a fresh signature timestamp
```

SSRF guard runs on **every** attempt (DNS can be re-pointed between attempts), not only at
registration.

### 4.4 `retention.sweep` and `trash.purge`

Runs nightly. Reads the org's retention policy, skips anything under legal hold, drops expired
partitions where possible and batch-deletes otherwise (10k rows per statement, throttled by
replication lag). Every purge writes an audit row with the counts.

## 5. Scheduling

Repeatable jobs use BullMQ's cron support with a Redis lock so exactly one scheduler instance owns
each schedule. Automation time triggers are *not* cron entries — with millions of automations that
would be unmanageable. Instead, a single `automation.tick` job runs each minute, queries
`automation_schedules WHERE next_run_at <= now()` (indexed), enqueues dispatch jobs, and advances
`next_run_at`. This scales to millions of schedules with one index scan per minute.

## 6. Backpressure & fairness

- **Per-tenant concurrency caps** via BullMQ groups: one tenant's 2M-row import cannot starve
  every other tenant's recalcs. Cap is a plan entitlement.
- **Queue depth alerting** at p95 wait time > 60 s (interactive) / 15 min (bulk).
- **Shed load** on `maintenance` first when Redis memory or DB CPU crosses thresholds.

## 7. Worker lifecycle

```
SIGTERM → stop accepting new jobs
        → let in-flight jobs finish, up to terminationGracePeriodSeconds - 5
        → checkpoint resumable jobs (write cursor), return them to the queue
        → close DB pool, Redis, tracer flush
        → exit 0
```

Kubernetes `preStop` sleeps 5 s before SIGTERM so the endpoint is removed from service first.

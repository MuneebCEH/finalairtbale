import { newCorrelationId, runWithContext, type Logger } from '@tessera/logger';
import { Worker, type Job } from 'bullmq';
import type { Redis } from 'ioredis';

import type { JobContext, JobEnvelope, JobHandler, JobResult } from './job';

/**
 * The worker runtime.
 *
 * Handlers describe *what* to do. Everything about *how* it is executed safely — timeout
 * enforcement, correlation propagation, idempotency guards, progress, structured failure — lives
 * here, once. A handler cannot forget to apply a timeout because the handler never applies one.
 */
export class WorkerRuntime {
  private readonly workers: Worker[] = [];
  private readonly handlers = new Map<string, JobHandler<never>>();
  private shuttingDown = false;

  constructor(
    private readonly connection: Redis,
    private readonly logger: Logger,
  ) {}

  register<TData>(handler: JobHandler<TData>): void {
    this.handlers.set(handler.name, handler as JobHandler<never>);
  }

  start(queueName: string, concurrency: number): void {
    const worker = new Worker(
      queueName,
      async (job: Job) => this.execute(job),
      {
        connection: this.connection,
        concurrency,
        // BullMQ's own stalled-job watchdog. A process killed mid-job releases the lock after
        // this window and another worker picks the job up, rather than it being lost.
        stalledInterval: 30_000,
        maxStalledCount: 2,
      },
    );

    worker.on('failed', (job, error) => {
      this.logger.error('job failed', {
        queue: queueName,
        jobName: job?.name,
        jobId: job?.id,
        attempt: job?.attemptsMade,
        error,
      });
    });

    worker.on('error', (error) => {
      this.logger.error('worker error', { queue: queueName, error });
    });

    this.workers.push(worker);
    this.logger.info('worker started', { queue: queueName, concurrency });
  }

  private async execute(job: Job): Promise<JobResult> {
    const envelope = job.data as JobEnvelope;
    const handler = this.handlers.get(envelope.name);

    if (!handler) {
      // An unknown job name is a deployment mismatch, not a transient failure. Retrying it
      // forever would fill the queue; failing it immediately surfaces the problem.
      throw new UnrecoverableJobError(`No handler registered for "${envelope.name}".`);
    }

    const correlationId = envelope.correlationId || newCorrelationId();
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), handler.timeoutMs);

    const logger = this.logger.child({
      jobName: envelope.name,
      jobId: job.id ?? envelope.jobId,
      ...(envelope.tenant ? { organizationId: envelope.tenant.organizationId } : {}),
    });

    const ctx: JobContext = {
      logger,
      signal: controller.signal,
      attempt: job.attemptsMade + 1,
      progress: async (percent, message) => {
        await job.updateProgress({ percent, message });
      },
      cancelled: async () => {
        const flag = await this.connection.get(`job:cancel:${envelope.jobId}`);
        return flag !== null || this.shuttingDown;
      },
    };

    return runWithContext(
      {
        correlationId,
        jobName: envelope.name,
        ...(envelope.tenant ? { organizationId: envelope.tenant.organizationId } : {}),
      },
      async () => {
        const started = Date.now();
        try {
          // External side effects take a guard first, so an at-least-once delivery does not
          // become an at-least-once *email*.
          if (handler.idempotency === 'guarded') {
            const claimed = await this.connection.set(
              `job:done:${envelope.jobId}`,
              '1',
              'EX',
              604_800, // 7 days
              'NX',
            );
            if (claimed === null) {
              logger.info('job skipped: already performed', { jobId: envelope.jobId });
              return { ok: true, summary: 'duplicate suppressed' };
            }
          }

          const result = await handler.handle(envelope as never, ctx);
          logger.info('job completed', {
            durationMs: Date.now() - started,
            summary: result.summary,
            ...result.metrics,
          });
          return result;
        } catch (error) {
          // A guard is released on failure so a retry can actually run. Without this, the first
          // failed attempt at a guarded job would permanently suppress every retry.
          if (handler.idempotency === 'guarded') {
            await this.connection.del(`job:done:${envelope.jobId}`).catch(() => undefined);
          }
          await handler.onFailed?.(envelope as never, error as Error).catch(() => undefined);
          throw error;
        } finally {
          clearTimeout(timeout);
        }
      },
    );
  }

  /**
   * Graceful shutdown.
   *
   * Stops accepting new jobs, lets in-flight work finish within the grace period, then closes.
   * Killing a worker mid-job is survivable — the stalled-job watchdog re-queues it — but it
   * turns every deploy into a burst of duplicate work, which is avoidable.
   */
  async shutdown(graceMs = 25_000): Promise<void> {
    this.shuttingDown = true;
    this.logger.info('worker shutting down', { workers: this.workers.length, graceMs });

    await Promise.race([
      Promise.all(this.workers.map((worker) => worker.close())),
      new Promise((resolve) => setTimeout(resolve, graceMs)),
    ]);

    this.logger.info('worker stopped');
  }
}

/** Signals a failure that retrying cannot fix. The runtime fails it immediately. */
export class UnrecoverableJobError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UnrecoverableJobError';
  }
}

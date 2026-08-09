import { loadEnv } from '@tessera/config';
import { createDatabaseClients } from '@tessera/database';
import { createLogger } from '@tessera/logger';
import { Queue } from 'bullmq';
import Redis from 'ioredis';

import {
  PruneSessionsHandler,
  PurgeTrashHandler,
  RelayOutboxHandler,
} from './handlers/maintenance';
import { WorkerRuntime } from './runtime/worker-runtime';

/**
 * The worker entry point.
 *
 * One binary, configurable queue subset. `WORKER_QUEUES=compute,io` runs a CPU-tuned fleet;
 * `WORKER_QUEUES=delivery` runs an IO-tuned one — from the same image. Building separate images
 * per queue multiplies the build matrix and the ways a deployment can drift.
 */
async function main(): Promise<void> {
  const env = loadEnv();
  const logger = createLogger({
    name: 'tessera-worker',
    level: env.LOG_LEVEL,
    pretty: env.NODE_ENV === 'development',
  });

  const connection = new Redis(env.REDIS_QUEUE_URL, {
    // BullMQ requires this: a blocking command that gives up mid-wait would drop the job.
    maxRetriesPerRequest: null,
    retryStrategy: (times) => Math.min(times * 200, 5_000),
  });
  connection.on('error', (error) => logger.warn('redis error', { error: error.message }));

  const clients = createDatabaseClients({ env, logger });
  const runtime = new WorkerRuntime(connection, logger);

  runtime.register(new PruneSessionsHandler(clients.primary));
  runtime.register(new PurgeTrashHandler(clients.primary));
  runtime.register(
    new RelayOutboxHandler(clients.primary, async (events) => {
      // Phase 1 publishes to a Redis stream. The `RealtimeBus` port (packages/events) is where a
      // dedicated broker slots in later without touching this call site.
      const pipeline = connection.pipeline();
      for (const event of events) {
        pipeline.xadd('events:global', '*', 'payload', JSON.stringify(event));
      }
      await pipeline.exec();
    }),
  );

  const queues = (process.env['WORKER_QUEUES'] ?? 'maintenance')
    .split(',')
    .map((name) => name.trim())
    .filter(Boolean);

  const concurrency = Number(process.env['WORKER_CONCURRENCY'] ?? 4);
  for (const queue of queues) runtime.start(queue, concurrency);

  await scheduleRepeatables(connection, logger.child({ component: 'scheduler' }));

  const shutdown = async (signal: string): Promise<void> => {
    logger.info('shutdown signal received', { signal });
    await runtime.shutdown();
    await clients.disconnect();
    await connection.quit();
    process.exit(0);
  };

  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));

  // An unhandled rejection leaves the process in an unknown state. Logging it and continuing is
  // how a worker ends up silently doing nothing; crashing lets the orchestrator restart it.
  process.on('unhandledRejection', (reason) => {
    logger.fatal('unhandled rejection in worker', { error: reason });
    process.exit(1);
  });

  logger.info('worker ready', { queues, concurrency, env: env.NODE_ENV });
}

/**
 * Registers repeating jobs.
 *
 * A fixed `jobId` per schedule means several worker replicas registering the same repeatable
 * converge on one entry instead of each adding their own — otherwise a three-replica deployment
 * runs every cron three times.
 */
async function scheduleRepeatables(
  connection: Redis,
  logger: ReturnType<typeof createLogger>,
): Promise<void> {
  const queue = new Queue('maintenance', { connection });

  const schedules = [
    { name: 'outbox.relay', pattern: '*/1 * * * * *', data: { batchSize: 200 } },
    { name: 'session.prune', pattern: '0 30 3 * * *', data: {} },
    { name: 'trash.purge', pattern: '0 0 4 * * *', data: { batchSize: 500 } },
  ] as const;

  for (const schedule of schedules) {
    await queue.add(
      schedule.name,
      {
        jobId: `repeat:${schedule.name}`,
        name: schedule.name,
        actor: { type: 'system', id: null },
        correlationId: `cron:${schedule.name}`,
        enqueuedAt: new Date().toISOString(),
        data: schedule.data,
      },
      {
        repeat: { pattern: schedule.pattern },
        jobId: `repeat:${schedule.name}`,
        removeOnComplete: 100,
        removeOnFail: 500,
      },
    );
  }

  logger.info('repeatable jobs registered', { count: schedules.length });
  await queue.close();
}

main().catch((error: unknown) => {
  // eslint-disable-next-line no-console
  console.error('Failed to start the worker:', error);
  process.exit(1);
});

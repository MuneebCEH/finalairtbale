import { join } from 'node:path';

import { Global, Module, type OnApplicationShutdown } from '@nestjs/common';
import { loadEnv, type Env } from '@tessera/config';
import { createLogger, type Logger } from '@tessera/logger';
import { LocalFilesystemStorage, type StoragePort } from '@tessera/storage';
import Redis from 'ioredis';

import { MailerService } from './mailer.service';
import { MembershipService } from './membership.service';
import { PrismaService } from './prisma.service';
import { RateLimiter } from './rate-limiter';
import { ENV, LOGGER, REDIS, STORAGE } from './tokens';

/**
 * Wires the process's shared infrastructure.
 *
 * Global, because environment, logger, database, and cache are needed by nearly every module and
 * threading them through imports adds noise without adding safety. Everything else — services,
 * repositories, policies — is explicitly imported, so the dependency graph of the *domain*
 * remains visible.
 */
@Global()
@Module({
  providers: [
    {
      provide: ENV,
      // Validation happens here, at construction. A malformed environment fails the boot rather
      // than surfacing as a confusing runtime error an hour later.
      useFactory: (): Env => loadEnv(),
    },
    {
      provide: LOGGER,
      inject: [ENV],
      useFactory: (env: Env): Logger =>
        createLogger({
          name: 'tessera-api',
          level: env.LOG_LEVEL,
          pretty: env.NODE_ENV === 'development',
        }),
    },
    {
      provide: REDIS,
      inject: [ENV, LOGGER],
      useFactory: (env: Env, logger: Logger): Redis => {
        const redis = new Redis(env.REDIS_URL, {
          maxRetriesPerRequest: 1,
          enableReadyCheck: true,
          lazyConnect: false,

          // The setting that makes graceful degradation actually work.
          //
          // ioredis defaults to queueing commands while disconnected and replaying them once
          // the connection returns. With Redis genuinely down that queue never drains, so every
          // `redis.get()` returns a promise that neither resolves nor rejects — and a
          // `.catch()` fallback never runs. The request simply hangs until the client gives up.
          //
          // Disabling the offline queue turns "Redis is down" into an immediate rejection,
          // which is what every call site is already written to handle: the cache falls through
          // to Postgres and the rate limiter fails open. Degradation you have not tested with
          // the dependency actually stopped is degradation you do not have.
          enableOfflineQueue: false,

          // A hung command is worse than a failed one. Nothing this application asks of Redis
          // legitimately takes a second.
          commandTimeout: 1_000,

          // Bounded, jittered reconnection. An unbounded retry loop against a dead Redis is a
          // reliable way to saturate the event loop during an incident.
          retryStrategy: (times) => Math.min(times * 200, 5_000),
        });

        // Throttled: a dead Redis emits a connection error every retry, and an unthrottled
        // handler turns one outage into gigabytes of identical log lines.
        let lastLoggedAt = 0;
        redis.on('error', (error) => {
          const now = Date.now();
          if (now - lastLoggedAt < 30_000) return;
          lastLoggedAt = now;
          logger.warn('redis unavailable; serving in degraded mode', { error: error.message });
        });

        return redis;
      },
    },
    {
      provide: STORAGE,
      inject: [ENV, LOGGER],
      useFactory: (env: Env, logger: Logger): StoragePort => {
        // The local adapter is chosen explicitly by configuration, never as a silent fallback:
        // a production deployment that quietly wrote attachments to a pod's ephemeral disk would
        // lose them on the next restart, and nobody would notice until somebody asked for a file.
        if (env.STORAGE_DRIVER === 'memory' || env.NODE_ENV !== 'production') {
          const root = join(process.cwd(), '.local', 'attachments');
          logger.info('attachment storage: local filesystem', { root });
          return new LocalFilesystemStorage(
            root,
            env.SESSION_SECRET,
            `${env.API_URL}/files`,
          );
        }
        throw new Error(
          `Storage driver "${env.STORAGE_DRIVER}" is configured but its adapter is not wired up yet.`,
        );
      },
    },
    PrismaService,
    RateLimiter,
    MembershipService,
    MailerService,
  ],
  exports: [ENV, LOGGER, REDIS, STORAGE, PrismaService, RateLimiter, MembershipService, MailerService],
})
export class InfrastructureModule implements OnApplicationShutdown {
  constructor(private readonly prisma: PrismaService) {}

  async onApplicationShutdown(): Promise<void> {
    // Nest calls the module's own destroy hooks; this exists so shutdown ordering is explicit
    // and a future addition (flushing traces, draining sockets) has an obvious home.
    await this.prisma.healthy().catch(() => false);
  }
}

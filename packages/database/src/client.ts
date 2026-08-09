import { PrismaClient } from '@prisma/client';
import type { Env } from '@tessera/config';
import type { Logger } from '@tessera/logger';
import type { TenantContext } from '@tessera/types';

/**
 * Database client construction and routing.
 *
 * Three seams are built in now because retrofitting them later is a rewrite rather than a change:
 *
 *  1. **Primary vs replica.** Reads go to a replica unless the request has already written, in
 *     which case `needsPrimary` pins it — read-your-writes without making every read expensive.
 *  2. **Shard routing.** `clientFor(tenant)` resolves a client from the tenant's shard. Today
 *     every organization resolves to shard 0. When sharding is needed, this function changes and
 *     nothing else does.
 *  3. **Tenant session variable.** Every transaction sets `app.current_org`, which arms the
 *     row-level security policies. This is the backstop behind application-level scoping.
 */

export type Db = PrismaClient;

export interface DatabaseClients {
  readonly primary: Db;
  readonly replica: Db;
  disconnect(): Promise<void>;
}

export interface CreateClientsOptions {
  readonly env: Pick<
    Env,
    'DATABASE_URL' | 'DATABASE_REPLICA_URL' | 'DATABASE_STATEMENT_TIMEOUT_MS' | 'NODE_ENV'
  >;
  readonly logger: Logger;
}

export function createDatabaseClients(options: CreateClientsOptions): DatabaseClients {
  const { env, logger } = options;

  const primary = instrument(
    new PrismaClient({
      datasources: { db: { url: env.DATABASE_URL } },
      log: [
        { emit: 'event', level: 'warn' },
        { emit: 'event', level: 'error' },
        ...(env.NODE_ENV === 'development' ? ([{ emit: 'event', level: 'query' }] as const) : []),
      ],
    }),
    logger.child({ pool: 'primary' }),
  );

  // Falls back to the primary when no replica is configured, so development and single-node
  // deployments need no special casing anywhere else in the codebase.
  const replica = env.DATABASE_REPLICA_URL
    ? instrument(
        new PrismaClient({
          datasources: { db: { url: env.DATABASE_REPLICA_URL } },
          log: [
            { emit: 'event', level: 'warn' },
            { emit: 'event', level: 'error' },
          ],
        }),
        logger.child({ pool: 'replica' }),
      )
    : primary;

  return {
    primary,
    replica,
    async disconnect(): Promise<void> {
      await primary.$disconnect();
      if (replica !== primary) await replica.$disconnect();
    },
  };
}

/* eslint-disable @typescript-eslint/no-explicit-any -- Prisma's event emitter types are loose. */
function instrument(client: PrismaClient, logger: Logger): PrismaClient {
  (client as any).$on('warn', (event: { message: string }) => {
    logger.warn('database warning', { message: event.message });
  });
  (client as any).$on('error', (event: { message: string }) => {
    logger.error('database error', { message: event.message });
  });
  (client as any).$on('query', (event: { query: string; duration: number }) => {
    // Slow-query surfacing in development. In production this is handled by pg_stat_statements
    // and tracing, not by logging every statement.
    if (event.duration > 200) {
      logger.debug('slow query', { durationMs: event.duration, query: event.query.slice(0, 500) });
    }
  });
  return client;
}
/* eslint-enable @typescript-eslint/no-explicit-any */

/** Chooses primary or replica for a unit of work. */
export function clientFor(clients: DatabaseClients, tenant: TenantContext, write: boolean): Db {
  if (write || tenant.needsPrimary) return clients.primary;
  return clients.replica;
}

/**
 * Runs `fn` inside a transaction with the tenant session variable set.
 *
 * `SET LOCAL` is scoped to the transaction, so a pooled connection cannot leak one tenant's
 * setting into another tenant's next query — which is precisely the failure mode that makes
 * naive RLS-with-pooling unsafe.
 */
export async function withTenantTransaction<T>(
  db: Db,
  tenant: TenantContext,
  fn: (tx: TransactionClient) => Promise<T>,
  options?: { timeoutMs?: number; isolation?: 'ReadCommitted' | 'RepeatableRead' | 'Serializable' },
): Promise<T> {
  return db.$transaction(
    async (tx) => {
      await tx.$executeRawUnsafe(`SET LOCAL app.current_org = '${sanitiseOrgId(tenant.organizationId)}'`);
      return fn(tx as TransactionClient);
    },
    {
      timeout: options?.timeoutMs ?? 15_000,
      isolationLevel: options?.isolation ?? 'ReadCommitted',
    },
  );
}

export type TransactionClient = Omit<
  PrismaClient,
  '$connect' | '$disconnect' | '$on' | '$transaction' | '$use' | '$extends'
>;

/**
 * The organization id is interpolated into `SET LOCAL` because Postgres does not accept a bind
 * parameter there. It is therefore validated to the exact id grammar first — a value that is not
 * 30 characters of `[A-Za-z0-9_]` never reaches the statement.
 */
function sanitiseOrgId(organizationId: string): string {
  if (!/^org_[0-9A-HJKMNP-TV-Z]{26}$/.test(organizationId)) {
    throw new Error(`Refusing to set tenant context: malformed organization id`);
  }
  return organizationId;
}

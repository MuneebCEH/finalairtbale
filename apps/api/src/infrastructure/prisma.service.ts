import { Inject, Injectable, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import type { Env } from '@tessera/config';
import {
  createDatabaseClients,
  withTenantTransaction,
  type DatabaseClients,
  type Db,
  type TransactionClient,
} from '@tessera/database';
import type { Logger } from '@tessera/logger';
import type { TenantContext } from '@tessera/types';

import { ENV, LOGGER } from './tokens';

/**
 * Owns the database connections for the process.
 *
 * Exposes three access paths and no others:
 *   • `client`   — the primary, for writes and read-your-writes
 *   • `read`     — a replica, for queries that tolerate a few milliseconds of lag
 *   • `transact` — a tenant-scoped transaction with `app.current_org` set, which is the only way
 *                  business code should write
 */
@Injectable()
export class PrismaService implements OnModuleInit, OnModuleDestroy {
  private clients!: DatabaseClients;

  constructor(
    @Inject(ENV) private readonly env: Env,
    @Inject(LOGGER) private readonly logger: Logger,
  ) {}

  onModuleInit(): void {
    this.clients = createDatabaseClients({ env: this.env, logger: this.logger });
  }

  async onModuleDestroy(): Promise<void> {
    await this.clients?.disconnect();
  }

  get client(): Db {
    return this.clients.primary;
  }

  get read(): Db {
    return this.clients.replica;
  }

  /**
   * Runs work in a transaction with the tenant session variable set, which arms row-level
   * security. Every write path in the application goes through here.
   */
  async transact<T>(
    tenant: TenantContext,
    fn: (tx: TransactionClient) => Promise<T>,
    options?: { timeoutMs?: number },
  ): Promise<T> {
    return withTenantTransaction(this.clients.primary, tenant, fn, options);
  }

  /** Readiness probe: a real round-trip, not a connection-pool boolean. */
  async healthy(): Promise<boolean> {
    try {
      await this.clients.primary.$queryRawUnsafe('SELECT 1');
      return true;
    } catch {
      return false;
    }
  }
}

import { Inject, Injectable } from '@nestjs/common';
import { CACHE_TTL_SECONDS } from '@tessera/config';
import { CacheKeys, MembershipLoader } from '@tessera/database';
import type { MembershipSnapshot } from '@tessera/permissions';
import type { Redis } from 'ioredis';

import { PrismaService } from './prisma.service';
import { REDIS } from './tokens';

/**
 * Loads and caches the membership snapshot the policy engine evaluates.
 *
 * Authorization runs on every request, so this lookup is the hot path. It is cached for 60
 * seconds, which is the deliberate trade-off: a permission change takes effect within a minute
 * rather than instantly, in exchange for not issuing three queries per request. Changes that
 * *reduce* access — removing a member, suspending an account, revoking a grant — bust the cache
 * explicitly, so the one-minute window only ever applies to grants, never to revocations.
 */
@Injectable()
export class MembershipService {
  private cachedLoader: MembershipLoader | null = null;

  constructor(
    private readonly prisma: PrismaService,
    @Inject(REDIS) private readonly redis: Redis,
  ) {}

  /**
   * Resolved on first use rather than in the constructor.
   *
   * Nest instantiates every provider before running any `onModuleInit`, so `PrismaService` has
   * not yet opened its connections while this class is being constructed. Reading
   * `prisma.read` here would capture `undefined` — the ordering trap that makes constructor-time
   * dependency *access* (as opposed to injection) unsafe in any DI container with a separate
   * initialisation phase.
   */
  private get loader(): MembershipLoader {
    this.cachedLoader ??= new MembershipLoader(this.prisma.read);
    return this.cachedLoader;
  }

  async snapshot(organizationId: string, userId: string | null): Promise<MembershipSnapshot> {
    const keys = new CacheKeys({ organizationId });
    const cacheKey = keys.membership(userId ?? 'anonymous');

    const cached = await this.redis.get(cacheKey).catch(() => null);
    if (cached) {
      try {
        return JSON.parse(cached) as MembershipSnapshot;
      } catch {
        // A malformed cache entry is a bug, not a reason to fail the request.
      }
    }

    const snapshot = await this.loader.load({ organizationId, userId });

    await this.redis
      .set(cacheKey, JSON.stringify(snapshot), 'EX', CACHE_TTL_SECONDS.authorization)
      .catch(() => undefined);

    return snapshot;
  }

  /** Called immediately by any operation that reduces somebody's access. */
  async invalidate(organizationId: string, userId: string): Promise<void> {
    const keys = new CacheKeys({ organizationId });
    await this.redis.del(keys.membership(userId)).catch(() => undefined);
  }

  /** Used when a change affects everybody: settings, plan, group membership rewrites. */
  async invalidateOrganization(organizationId: string): Promise<void> {
    const keys = new CacheKeys({ organizationId });
    const pattern = keys.membership('*');
    const stream = this.redis.scanStream({ match: pattern, count: 200 });
    const batch: string[] = [];

    for await (const found of stream) {
      batch.push(...(found as string[]));
      if (batch.length >= 500) {
        await this.redis.del(...batch.splice(0, batch.length)).catch(() => undefined);
      }
    }
    if (batch.length > 0) await this.redis.del(...batch).catch(() => undefined);
  }
}

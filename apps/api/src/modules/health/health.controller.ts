import { Controller, Get, Inject, VERSION_NEUTRAL } from '@nestjs/common';
import type { Redis } from 'ioredis';

import { Public, SkipTenantScope } from '../../bootstrap/decorators';
import { PrismaService } from '../../infrastructure/prisma.service';
import { REDIS } from '../../infrastructure/tokens';

/**
 * Health endpoints, with deliberately different semantics (docs/11-deployment.md §3):
 *
 *   /health/live   — "is this process wedged?"  A failure means restart me.
 *   /health/ready  — "should traffic come here?" A failure means remove me from the pool.
 *
 * Readiness checks only the dependencies without which the service is *useless* — the database
 * and Redis. It deliberately does **not** check search or payments: making readiness depend on
 * every downstream service means one degraded optional dependency empties the entire pool and
 * converts a partial outage into a total one. Those are reported in the body for observability
 * without affecting the verdict.
 */
// Version-neutral: an orchestrator's liveness probe must not be coupled to the API's public
// version. `/v1/health` would break the moment `/v2` shipped, and the Kubernetes manifests and
// container HEALTHCHECKs would all need editing for a change that has nothing to do with them.
@Controller({ path: 'health', version: VERSION_NEUTRAL })
@Public()
@SkipTenantScope()
export class HealthController {
  private readonly startedAt = Date.now();

  constructor(
    private readonly prisma: PrismaService,
    @Inject(REDIS) private readonly redis: Redis,
  ) {}

  @Get('live')
  live() {
    return {
      status: 'ok',
      uptimeSeconds: Math.floor((Date.now() - this.startedAt) / 1000),
    };
  }

  @Get('ready')
  async ready() {
    const [database, cache] = await Promise.all([
      this.prisma.healthy(),
      this.redis
        .ping()
        .then(() => true)
        .catch(() => false),
    ]);

    const ready = database && cache;
    return {
      status: ready ? 'ok' : 'degraded',
      checks: { database, cache },
    };
  }
}

import { Inject, Injectable } from '@nestjs/common';
import type { Env } from '@tessera/config';
import type { Redis } from 'ioredis';

import { ENV, REDIS } from './tokens';

export interface RateLimitResult {
  readonly allowed: boolean;
  readonly remaining: number;
  /** Unix seconds at which the window resets. */
  readonly resetAt: number;
  readonly retryAfterSeconds: number;
}

/**
 * Sliding-window rate limiter.
 *
 * Implemented as a single Lua script so the read, the expiry decision, and the increment are one
 * atomic operation. A read-then-write implementation in application code has a race that lets a
 * burst of concurrent requests all observe the same pre-increment count and sail through — which
 * is precisely the traffic shape a rate limiter exists to stop.
 *
 * The window is a fixed window with a smoothed carry-over from the previous one, which
 * approximates a true sliding window at a fraction of the memory (two counters per key rather
 * than a timestamp per request).
 */
@Injectable()
export class RateLimiter {
  private static readonly SCRIPT = `
    local key        = KEYS[1]
    local limit      = tonumber(ARGV[1])
    local window     = tonumber(ARGV[2])
    local now        = tonumber(ARGV[3])

    local currentWindow  = math.floor(now / window)
    local currentKey     = key .. ':' .. currentWindow
    local previousKey    = key .. ':' .. (currentWindow - 1)

    local previous = tonumber(redis.call('GET', previousKey) or '0')
    local current  = tonumber(redis.call('GET', currentKey) or '0')

    -- Weight the previous window by how much of it still overlaps the sliding view.
    local elapsed  = (now % window) / window
    local estimate = previous * (1 - elapsed) + current

    if estimate >= limit then
      local resetAt = (currentWindow + 1) * window
      return { 0, 0, resetAt }
    end

    current = redis.call('INCR', currentKey)
    if current == 1 then
      redis.call('EXPIRE', currentKey, window * 2)
    end

    local resetAt = (currentWindow + 1) * window
    return { 1, math.floor(limit - estimate - 1), resetAt }
  `;

  constructor(
    @Inject(REDIS) private readonly redis: Redis,
    @Inject(ENV) private readonly env: Env,
  ) {}

  async consume(key: string, limit: number, windowSeconds: number): Promise<RateLimitResult> {
    if (!this.env.RATE_LIMIT_ENABLED) {
      return { allowed: true, remaining: limit, resetAt: 0, retryAfterSeconds: 0 };
    }

    const now = Math.floor(Date.now() / 1000);

    try {
      const [allowed, remaining, resetAt] = (await this.redis.eval(
        RateLimiter.SCRIPT,
        1,
        key,
        String(limit),
        String(windowSeconds),
        String(now),
      )) as [number, number, number];

      return {
        allowed: allowed === 1,
        remaining,
        resetAt,
        retryAfterSeconds: Math.max(1, resetAt - now),
      };
    } catch {
      // Fail *open*. A Redis outage must not lock every user out of the product; the outage is
      // alerted on, and the exposure window is bounded. Failing closed here would convert a
      // cache incident into a total outage.
      return { allowed: true, remaining: limit, resetAt: 0, retryAfterSeconds: 0 };
    }
  }

  /** Clears a counter — used after a successful login so one typo does not cost 15 minutes. */
  async reset(key: string, windowSeconds: number): Promise<void> {
    const window = Math.floor(Date.now() / 1000 / windowSeconds);
    await this.redis.del(`${key}:${window}`, `${key}:${window - 1}`).catch(() => undefined);
  }
}

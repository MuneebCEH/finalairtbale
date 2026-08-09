import { Injectable, type CanActivate, type ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { RATE_LIMITS, type RateLimitClass } from '@tessera/config';
import { rateLimitKey } from '@tessera/database';
import { AppError, principalKey } from '@tessera/types';
import type { Request, Response } from 'express';

import { RateLimiter } from '../infrastructure/rate-limiter';

import type { AuthenticatedRequest } from './auth.guard';
import { RATE_LIMIT_KEY } from './decorators';

/**
 * Sliding-window rate limiting.
 *
 * Limits are keyed on the **principal** first and the IP only as a fallback for unauthenticated
 * routes. Keying primarily on IP is the common mistake: it punishes everybody behind one office
 * NAT while doing nothing against an attacker with a few hundred addresses.
 *
 * Headers are always emitted, including on success, so a well-behaved client can pace itself
 * instead of discovering the limit by hitting it.
 */
@Injectable()
export class RateLimitGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly limiter: RateLimiter,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const routeClass = this.reflector.getAllAndOverride<RateLimitClass | undefined>(
      RATE_LIMIT_KEY,
      [context.getHandler(), context.getClass()],
    );
    if (!routeClass) return true;

    const request = context.switchToHttp().getRequest<Request & Partial<AuthenticatedRequest>>();
    const response = context.switchToHttp().getResponse<Response>();

    const subject = request.principal
      ? principalKey(request.principal)
      : `ip:${clientIp(request)}`;

    const config = RATE_LIMITS[routeClass];
    const result = await this.limiter.consume(
      rateLimitKey(routeClass, subject),
      config.points,
      config.windowSeconds,
    );

    response.setHeader('X-RateLimit-Limit', String(config.points));
    response.setHeader('X-RateLimit-Remaining', String(Math.max(0, result.remaining)));
    response.setHeader('X-RateLimit-Reset', String(result.resetAt));

    if (!result.allowed) {
      throw new AppError('RATE_LIMITED', 'Too many requests. Please slow down.', {
        details: { retryAfterSeconds: result.retryAfterSeconds, limit: config.points },
      });
    }

    return true;
  }
}

/**
 * Resolves the client address.
 *
 * `X-Forwarded-For` is only consulted when the deployment is explicitly behind a trusted proxy —
 * otherwise a client could set the header itself and reset its own counter, which turns the
 * rate limiter into decoration.
 */
export function clientIp(request: Request): string {
  return request.ip ?? request.socket.remoteAddress ?? 'unknown';
}

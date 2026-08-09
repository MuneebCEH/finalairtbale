import { SetMetadata, createParamDecorator, type ExecutionContext } from '@nestjs/common';
import type { RateLimitClass } from '@tessera/config';
import type { Action } from '@tessera/permissions';
import type { Principal, TenantContext } from '@tessera/types';

import type { AuthenticatedRequest } from './auth.guard';

export const PUBLIC_KEY = 'tessera:public';
export const RATE_LIMIT_KEY = 'tessera:rateLimit';
export const REQUIRED_ACTION_KEY = 'tessera:requiredAction';
export const SKIP_TENANT_KEY = 'tessera:skipTenant';

/**
 * Marks a route as reachable without authentication.
 *
 * Authentication is on by default and must be opted *out* of. The inverse — requiring a decorator
 * to protect a route — means every forgotten decorator is an open endpoint. This way every
 * forgotten decorator is a 401, which is noticed in about four seconds.
 *
 * Each use is greppable and is reviewed by CODEOWNERS.
 */
export const Public = (): MethodDecorator & ClassDecorator => SetMetadata(PUBLIC_KEY, true);

/**
 * Exempts a route from tenant resolution. Only legitimate for routes that genuinely have no
 * tenant: authentication, the user's own profile, and the organization list.
 */
export const SkipTenantScope = (): MethodDecorator & ClassDecorator =>
  SetMetadata(SKIP_TENANT_KEY, true);

export const RateLimit = (routeClass: RateLimitClass): MethodDecorator & ClassDecorator =>
  SetMetadata(RATE_LIMIT_KEY, routeClass);

/**
 * Declares the permission a route requires. The policy guard reads it, resolves the target
 * resource, and denies before the handler runs.
 */
export const RequiresAction = (action: Action): MethodDecorator & ClassDecorator =>
  SetMetadata(REQUIRED_ACTION_KEY, action);

export const CurrentPrincipal = createParamDecorator(
  (_data: unknown, context: ExecutionContext): Principal => {
    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    if (!request.principal) {
      // Unreachable when the auth guard is registered globally; kept as an assertion so a
      // misconfiguration surfaces as a loud 500 rather than a silent `undefined`.
      throw new Error('CurrentPrincipal used on a route without authentication.');
    }
    return request.principal;
  },
);

export const CurrentTenant = createParamDecorator(
  (_data: unknown, context: ExecutionContext): TenantContext => {
    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    if (!request.tenant) {
      throw new Error('CurrentTenant used on a route without tenant resolution.');
    }
    return request.tenant;
  },
);

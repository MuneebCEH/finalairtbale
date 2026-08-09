import { Injectable, type CanActivate, type ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { assertAllowed, type Action, type Resource } from '@tessera/permissions';
import { actingUserId } from '@tessera/types';

import { MembershipService } from '../infrastructure/membership.service';

import type { AuthenticatedRequest } from './auth.guard';
import { REQUIRED_ACTION_KEY } from './decorators';

/**
 * Enforces the declared permission for a route.
 *
 * Authorization happens *before* the handler, on every route that declares an action — the UI
 * hiding a button is an ergonomic nicety, this is the actual control. The resource is derived
 * from route parameters that the tenant guard has already validated, so the policy engine is
 * never asked about a resource from another tenant.
 *
 * Row- and field-level rules that depend on the record's own contents cannot be decided here and
 * are applied inside the repository query instead (see docs/03 §5.3) — post-filtering results
 * would break pagination.
 */
@Injectable()
export class PolicyGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly memberships: MembershipService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const action = this.reflector.getAllAndOverride<Action | undefined>(REQUIRED_ACTION_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (!action) return true;

    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    const tenant = request.tenant;
    const principal = request.principal;
    if (!tenant || !principal) return true;

    // Scope enforcement is *not* done here. The policy engine already applies it inside
    // `assertAllowed`, and it reports better — naming the missing scope and how to fix it.
    // A second check in this guard existed briefly and was removed: two implementations of the
    // same rule drift, and the copy here disagreed with the engine about whether `data:write`
    // implies `data:read`. One rule, one place.
    const snapshot = await this.memberships.snapshot(
      tenant.organizationId,
      actingUserId(principal),
    );

    assertAllowed({
      principal,
      action,
      resource: resourceFrom(request, tenant.organizationId),
      snapshot,
      mfaRequiredButUnsatisfied:
        snapshot.organizationSettings['requireTwoFactor'] === true &&
        principal.type === 'user' &&
        !principal.mfaSatisfied,
    });

    return true;
  }
}

/**
 * Builds the resource the action targets from the route.
 *
 * The most specific parameter wins, and the ancestry is carried alongside so the policy engine
 * can walk from base grant to workspace role to organization role without another query.
 */
function resourceFrom(request: AuthenticatedRequest, organizationId: string): Resource {
  const params = request.params as Record<string, string | undefined>;

  // The ancestry the tenant guard resolved, not just what the path happens to name. A route like
  // `/tables/:tableId/records` carries no base id, but a user whose only access is a base-level
  // grant must still be able to use it — and the policy engine can only match that grant if it
  // is told which base the table belongs to.
  const ancestry = request.ancestry;
  const baseId = ancestry?.baseId ?? params['baseId'];
  const workspaceId = ancestry?.workspaceId ?? params['workspaceId'];

  const lineage = {
    organizationId,
    ...(baseId ? { baseId } : {}),
    ...(workspaceId ? { workspaceId } : {}),
  };

  if (params['recordId']) {
    return { type: 'record', id: params['recordId'], ...lineage };
  }
  if (params['fieldId']) {
    return { type: 'field', id: params['fieldId'], ...lineage };
  }
  if (params['tableId']) {
    return { type: 'table', id: params['tableId'], ...lineage };
  }
  if (baseId) {
    return { type: 'base', id: baseId, ...lineage };
  }
  if (workspaceId) {
    return { type: 'workspace', id: workspaceId, ...lineage };
  }
  return { type: 'organization', id: organizationId, organizationId };
}

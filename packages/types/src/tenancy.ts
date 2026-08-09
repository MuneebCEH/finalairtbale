import type { BaseId, OrganizationId, SessionId, UserId, WorkspaceId } from './ids';

/**
 * Who is making a request.
 *
 * Every code path that can read or write tenant data receives a `Principal`. There is no
 * "current user" global and no implicit ambient identity — an operation without a principal
 * cannot be expressed.
 */
export type Principal =
  | {
      readonly type: 'user';
      readonly userId: UserId;
      readonly sessionId: SessionId;
      /** True once a second factor has been satisfied for this session (or none is required). */
      readonly mfaSatisfied: boolean;
      readonly isPlatformAdmin: boolean;
      /** Set only when a platform admin is acting as this user through the audited flow. */
      readonly impersonatorId?: UserId;
    }
  | {
      readonly type: 'api_token';
      readonly tokenId: string;
      readonly userId: UserId;
      readonly scopes: readonly Scope[];
    }
  | {
      readonly type: 'oauth';
      readonly appId: string;
      readonly userId: UserId;
      readonly scopes: readonly Scope[];
    }
  | {
      /** Internal service-to-service calls. Never constructible from a network request. */
      readonly type: 'service';
      readonly service: string;
    }
  | {
      /** Public share links and public form submissions. */
      readonly type: 'anonymous';
      readonly shareId?: string;
    };

export const SCOPES = [
  'data:read',
  'data:write',
  'schema:read',
  'schema:write',
  'webhook:manage',
  'automation:read',
  'automation:run',
  'user:read',
  'org:admin',
] as const;

export type Scope = (typeof SCOPES)[number];

/**
 * The tenant a unit of work belongs to.
 *
 * Repositories cannot be constructed without one — see packages/database. This is the mechanism
 * that makes tenant scoping structural rather than a matter of developer discipline.
 */
export interface TenantContext {
  readonly organizationId: OrganizationId;
  readonly workspaceId?: WorkspaceId;
  readonly baseId?: BaseId;
  readonly principal: Principal;
  readonly correlationId: string;
  /** Set after a write so subsequent reads in the same request avoid a lagging replica. */
  readonly needsPrimary?: boolean;
}

export function principalKey(principal: Principal): string {
  switch (principal.type) {
    case 'user':
      return `user:${principal.userId}`;
    case 'api_token':
      return `token:${principal.tokenId}`;
    case 'oauth':
      return `oauth:${principal.appId}:${principal.userId}`;
    case 'service':
      return `service:${principal.service}`;
    case 'anonymous':
      return `anon:${principal.shareId ?? 'none'}`;
  }
}

/** The acting user, when there is one. Service and anonymous principals have no user. */
export function actingUserId(principal: Principal): UserId | null {
  switch (principal.type) {
    case 'user':
    case 'api_token':
    case 'oauth':
      return principal.userId;
    case 'service':
    case 'anonymous':
      return null;
  }
}

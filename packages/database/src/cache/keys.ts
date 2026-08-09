/**
 * Cache key construction.
 *
 * Every key is prefixed with the organization id. This is not a convention that reviewers must
 * remember — the builder takes the tenant context as its first argument, so a key without a
 * tenant prefix cannot be produced through the sanctioned API. Direct string concatenation of
 * cache keys is banned by lint.
 *
 * Keys are also *version-keyed* rather than time-keyed wherever a version exists. A write bumps
 * the version, which makes every dependent entry unreachable instantly: no invalidation fan-out,
 * no stale read, no thundering herd at expiry. See docs/09-scaling-strategy.md §5.
 */

export class CacheKeys {
  private readonly prefix: string;

  /**
   * Takes a plain `{ organizationId }` rather than a full `TenantContext` so that callers which
   * legitimately hold only an id (cache invalidation, maintenance jobs) do not have to
   * manufacture a fake principal. The tenant prefix is still mandatory — that is the property
   * this class exists to guarantee.
   */
  constructor(ctx: { organizationId: string }) {
    this.prefix = `t:${ctx.organizationId}`;
  }

  /** Resolved permission decision for a principal against a resource. */
  authorization(principalKey: string, resourceId: string): string {
    return `${this.prefix}:authz:${principalKey}:${resourceId}`;
  }

  /** The membership snapshot the policy engine reads. */
  membership(principalKey: string): string {
    return `${this.prefix}:membership:${principalKey}`;
  }

  /** Table + field definitions for a base, keyed by its schema version. */
  schema(baseId: string, schemaVersion: number): string {
    return `${this.prefix}:schema:${baseId}:v${schemaVersion}`;
  }

  /** A page of view results, keyed by the query shape and the table's data version. */
  viewQuery(viewId: string, queryHash: string, dataVersion: bigint | number): string {
    return `${this.prefix}:view:${viewId}:${queryHash}:v${dataVersion}`;
  }

  /** A cached computed-field result, keyed by the hash of its dependency values. */
  computed(fieldId: string, recordId: string, depsHash: string): string {
    return `${this.prefix}:calc:${fieldId}:${recordId}:${depsHash}`;
  }

  /** The field dependency graph for a base. */
  dependencyGraph(baseId: string): string {
    return `${this.prefix}:depgraph:${baseId}`;
  }

  /** Plan entitlements and current usage. */
  entitlements(): string {
    return `${this.prefix}:entitlements`;
  }

  /** Presence roster for a base. */
  presence(baseId: string): string {
    return `${this.prefix}:presence:base:${baseId}`;
  }

  /** Advisory lock protecting concurrent schema changes on one base. */
  schemaLock(baseId: string): string {
    return `${this.prefix}:lock:schema:${baseId}`;
  }

  /** Idempotency record for a public API write. */
  idempotency(principalKey: string, key: string): string {
    return `${this.prefix}:idem:${principalKey}:${key}`;
  }

  /** Everything belonging to this tenant, for a full flush on plan or permission upheaval. */
  tenantPattern(): string {
    return `${this.prefix}:*`;
  }
}

/**
 * Rate-limit keys are deliberately *not* tenant-scoped by organization alone: an unauthenticated
 * login attempt has no tenant. They are keyed by principal or IP, with the route class, and live
 * in a separate namespace so a tenant cache flush cannot reset somebody's brute-force counter.
 */
export function rateLimitKey(routeClass: string, subject: string): string {
  return `rl:${routeClass}:${subject}`;
}

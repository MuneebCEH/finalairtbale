import { NotFoundError, type TenantContext } from '@tessera/types';

import type { Db, TransactionClient } from '../client';

/**
 * The base class every tenant-scoped repository extends.
 *
 * This is the mechanism that makes tenant isolation *structural*. A repository cannot be
 * constructed without a `TenantContext`, and the only sanctioned way to build a `where` clause is
 * `this.scope()`, which stamps the organization id onto it. A developer who forgets is not
 * relying on discipline to save them: there is no ergonomic path that omits the scope, the custom
 * `tessera/require-tenant-scope` lint rule flags any Prisma call inside a repository that does not
 * go through `scope()`, and Postgres row-level security turns any statement that still slips
 * through into an empty result rather than a breach.
 *
 * See docs/03-security-and-permissions.md §2.
 */
export abstract class TenantScopedRepository {
  protected constructor(
    protected readonly db: Db | TransactionClient,
    protected readonly ctx: TenantContext,
  ) {}

  /** The tenant this repository is bound to. */
  protected get organizationId(): string {
    return this.ctx.organizationId;
  }

  /**
   * Stamps the tenant predicate onto a `where` clause.
   *
   * Note the return type: the caller cannot spread additional properties over the top and
   * accidentally overwrite `organizationId`, because the stamp is applied last.
   */
  protected scope<T extends Record<string, unknown>>(
    where: T = {} as T,
  ): T & { organizationId: string } {
    return { ...where, organizationId: this.ctx.organizationId };
  }

  /** Adds the soft-delete predicate as well; the common case for reads. */
  protected scopeLive<T extends Record<string, unknown>>(
    where: T = {} as T,
  ): T & { organizationId: string; deletedAt: null } {
    return { ...where, organizationId: this.ctx.organizationId, deletedAt: null };
  }

  /**
   * Enforces a bounded result set. Every list query in the platform goes through this, so an
   * unbounded `findMany` is not expressible.
   */
  protected take(limit: number, max = 200): number {
    if (!Number.isFinite(limit) || limit <= 0) return 1;
    return Math.min(Math.floor(limit), max);
  }

  /**
   * Converts "not found" into the platform error, deliberately using the same 404 whether the
   * row is missing or merely belongs to another tenant. A distinct 403 would confirm that the id
   * exists — an information leak that turns id enumeration into reconnaissance.
   */
  protected required<T>(value: T | null | undefined, resource: string, id?: string): T {
    if (value === null || value === undefined) throw new NotFoundError(resource, id);
    return value;
  }
}

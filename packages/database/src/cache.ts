/**
 * Cache keys and invalidation.
 *
 * The hard part of caching is never the storing — it is knowing what to throw away. Two failures
 * shape everything here:
 *
 *  1. **Stale reads across tenants.** A key that does not carry the organization can serve one
 *    customer's data to another. Every key is built through `cacheKey`, which requires it.
 *  2. **Invalidation that misses.** A field rename must drop every cached page of that table, not
 *    just the ones somebody remembered to list. Keys are therefore *hierarchical* and dropped by
 *    prefix, so a new cached thing under a table is covered the day it is added rather than the
 *    day someone notices it is stale.
 *
 * A cached page that outlives its data is worse than no cache: it is wrong, it is fast, and
 * nothing about it looks broken.
 */

export type CacheScope = 'org' | 'workspace' | 'base' | 'table' | 'view' | 'record';

const ID = /^[a-z]{3}_[0-9A-HJKMNP-TV-Z]{26}$/;

/**
 * The organization is checked against its own prefix, not merely the id shape.
 *
 * Every key's tenant isolation rests on this one argument. A shape-only check accepts a table id
 * in the organization position — which a caller that transposes two arguments will produce, and
 * which yields a key that looks perfectly valid while scoping to the wrong thing entirely.
 */
const ORGANIZATION_ID = /^org_[0-9A-HJKMNP-TV-Z]{26}$/;

/**
 * Builds a hierarchical cache key.
 *
 * The organization comes first so that dropping a tenant's entire cache — on a plan change, a
 * restore, or a security event — is one prefix delete.
 */
export function cacheKey(
  organizationId: string,
  parts: ReadonlyArray<{ scope: CacheScope; id: string }>,
  suffix?: string,
): string {
  if (!ORGANIZATION_ID.test(organizationId)) {
    throw new Error('Refusing to build a cache key without a valid organization id.');
  }

  for (const part of parts) {
    if (!ID.test(part.id)) {
      throw new Error(`Refusing to build a cache key from a malformed ${part.scope} id.`);
    }
  }

  const path = parts.map((part) => `${part.scope}:${part.id}`).join('/');
  const base = path ? `org:${organizationId}/${path}` : `org:${organizationId}`;

  // The suffix is the only free-form segment, so it is the only place a separator could be
  // smuggled in to make one key look like another's prefix.
  if (suffix !== undefined) {
    if (suffix.includes('/') || suffix.includes('*')) {
      throw new Error('A cache key suffix cannot contain "/" or "*".');
    }
    return `${base}#${suffix}`;
  }

  return base;
}

/**
 * The prefixes to drop when something changes.
 *
 * Returns prefixes rather than exact keys because the caller cannot know every key that exists
 * under a table — and any list it maintains will be missing whichever one was added last.
 */
export function invalidationPrefixes(
  organizationId: string,
  change: {
    scope: CacheScope;
    id: string;
    /** Ancestors, outermost first, so a table's own key can be built. */
    ancestry?: ReadonlyArray<{ scope: CacheScope; id: string }>;
  },
): string[] {
  const path = [...(change.ancestry ?? []), { scope: change.scope, id: change.id }];
  const own = cacheKey(organizationId, path);

  // The thing itself, and everything beneath it. A base's cache must go when the base changes,
  // and so must every table's and view's under it.
  const prefixes = [own];

  // A schema change invalidates its parent's listings too: renaming a table changes the base's
  // table list, which is cached under the base.
  if (path.length > 1) {
    prefixes.push(cacheKey(organizationId, path.slice(0, -1)));
  }

  return prefixes;
}

/** True when `key` falls under `prefix`, without a shorter id matching a longer one. */
export function matchesPrefix(key: string, prefix: string): boolean {
  if (key === prefix) return true;
  // The separator is required, so `org:X/table:AB` does not match the prefix `org:X/table:A`.
  return key.startsWith(`${prefix}/`) || key.startsWith(`${prefix}#`);
}

/**
 * An in-process cache with prefix invalidation and a bounded size.
 *
 * Bounded because an unbounded cache is a memory leak with a friendly name: a long-lived process
 * caching one entry per table ever read will eventually be restarted by the platform, and the
 * cause will be attributed to whatever ran last.
 */
export class PrefixCache<T> {
  private readonly entries = new Map<string, { value: T; expiresAt: number }>();

  constructor(
    private readonly maxEntries = 10_000,
    private readonly clock: () => number = Date.now,
  ) {}

  get(key: string): T | undefined {
    const entry = this.entries.get(key);
    if (!entry) return undefined;

    if (entry.expiresAt <= this.clock()) {
      this.entries.delete(key);
      return undefined;
    }

    // Re-inserted so Map iteration order approximates recency, which is what the eviction below
    // relies on.
    this.entries.delete(key);
    this.entries.set(key, entry);
    return entry.value;
  }

  set(key: string, value: T, ttlMs: number): void {
    this.entries.delete(key);
    this.entries.set(key, { value, expiresAt: this.clock() + ttlMs });

    while (this.entries.size > this.maxEntries) {
      const oldest = this.entries.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      this.entries.delete(oldest);
    }
  }

  /** Drops everything under the given prefixes. Returns how many entries went. */
  invalidate(prefixes: readonly string[]): number {
    let removed = 0;
    for (const key of [...this.entries.keys()]) {
      if (prefixes.some((prefix) => matchesPrefix(key, prefix))) {
        this.entries.delete(key);
        removed += 1;
      }
    }
    return removed;
  }

  get size(): number {
    return this.entries.size;
  }
}

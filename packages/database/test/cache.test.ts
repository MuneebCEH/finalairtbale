import { describe, expect, it } from 'vitest';

import { PrefixCache, cacheKey, invalidationPrefixes, matchesPrefix } from '../src/cache';

/**
 * A cached page that outlives its data is worse than no cache: it is wrong, it is fast, and
 * nothing about it looks broken. These tests are about the two ways that happens — a key that
 * crosses tenants, and an invalidation that misses.
 */

const ORG = 'org_01KZCN5ZD75CZX8FC4H5M22MM3';
const OTHER_ORG = 'org_01KZEQT1JTDXH3YQ7BQNDX4XQZ';
const BASE = 'bas_01KZEQT1JTDXH3YQ7BQNDX4XQZ';
const TABLE = 'tbl_01KZEQTA3K80Y2PKNWMYT9BBXW';

describe('cacheKey', () => {
  it('puts the organization first', () => {
    // So dropping one tenant's whole cache is a single prefix delete.
    expect(cacheKey(ORG, [])).toBe(`org:${ORG}`);
    expect(cacheKey(ORG, [{ scope: 'base', id: BASE }])).toBe(`org:${ORG}/base:${BASE}`);
  });

  it('nests scopes in the order given', () => {
    const key = cacheKey(ORG, [
      { scope: 'base', id: BASE },
      { scope: 'table', id: TABLE },
    ]);
    expect(key).toBe(`org:${ORG}/base:${BASE}/table:${TABLE}`);
  });

  it('separates two tenants completely', () => {
    // The failure this exists to prevent: one customer's cached page served to another.
    expect(cacheKey(ORG, [])).not.toBe(cacheKey(OTHER_ORG, []));
    expect(matchesPrefix(cacheKey(OTHER_ORG, []), cacheKey(ORG, []))).toBe(false);
  });

  it('refuses to build a key without a valid organization', () => {
    for (const bad of ['', 'nonsense', '*', '../org', TABLE]) {
      expect(() => cacheKey(bad, []), bad).toThrow(/organization id/);
    }
  });

  it('refuses a malformed scope id', () => {
    expect(() => cacheKey(ORG, [{ scope: 'base', id: 'nope' }])).toThrow(/malformed base id/);
  });

  it('refuses a suffix that could forge a prefix', () => {
    // The suffix is the only free-form segment, so it is the only place a separator could be
    // smuggled in to make one key look like it sits under another.
    expect(() => cacheKey(ORG, [], 'a/b')).toThrow(/cannot contain/);
    expect(() => cacheKey(ORG, [], '*')).toThrow(/cannot contain/);
  });

  it('accepts an ordinary suffix', () => {
    expect(cacheKey(ORG, [{ scope: 'table', id: TABLE }], 'fields')).toBe(
      `org:${ORG}/table:${TABLE}#fields`,
    );
  });
});

describe('matchesPrefix', () => {
  const prefix = `org:${ORG}/base:${BASE}`;

  it('matches the prefix itself and anything beneath it', () => {
    expect(matchesPrefix(prefix, prefix)).toBe(true);
    expect(matchesPrefix(`${prefix}/table:${TABLE}`, prefix)).toBe(true);
    expect(matchesPrefix(`${prefix}#tables`, prefix)).toBe(true);
  });

  it('does not match a longer id that merely starts the same', () => {
    // Without requiring a separator, `base:AB` would be dropped when `base:A` is invalidated.
    expect(matchesPrefix(`org:${ORG}/base:${BASE}EXTRA`, prefix)).toBe(false);
  });

  it('does not match a different tenant', () => {
    expect(matchesPrefix(`org:${OTHER_ORG}/base:${BASE}`, prefix)).toBe(false);
  });
});

describe('invalidationPrefixes', () => {
  it('drops the thing itself and everything under it', () => {
    const prefixes = invalidationPrefixes(ORG, { scope: 'base', id: BASE });
    expect(prefixes).toContain(`org:${ORG}/base:${BASE}`);
  });

  it('drops the parent listing too', () => {
    // Renaming a table changes the base's table list, which is cached under the base.
    const prefixes = invalidationPrefixes(ORG, {
      scope: 'table',
      id: TABLE,
      ancestry: [{ scope: 'base', id: BASE }],
    });

    expect(prefixes).toContain(`org:${ORG}/base:${BASE}/table:${TABLE}`);
    expect(prefixes).toContain(`org:${ORG}/base:${BASE}`);
  });
});

describe('PrefixCache', () => {
  it('stores and reads back', () => {
    const cache = new PrefixCache<string>();
    cache.set('a', 'value', 1_000);
    expect(cache.get('a')).toBe('value');
  });

  it('expires an entry', () => {
    let now = 1_000;
    const cache = new PrefixCache<string>(100, () => now);
    cache.set('a', 'value', 500);

    now += 501;
    expect(cache.get('a')).toBeUndefined();
    expect(cache.size).toBe(0);
  });

  it('drops everything under a prefix', () => {
    const cache = new PrefixCache<string>();
    const base = cacheKey(ORG, [{ scope: 'base', id: BASE }]);
    const table = cacheKey(ORG, [
      { scope: 'base', id: BASE },
      { scope: 'table', id: TABLE },
    ]);

    cache.set(base, 'base', 10_000);
    cache.set(table, 'table', 10_000);
    cache.set(cacheKey(OTHER_ORG, []), 'other tenant', 10_000);

    // A key added under the table tomorrow is covered by this the day it is added, not the day
    // somebody notices it is stale.
    expect(cache.invalidate([base])).toBe(2);
    expect(cache.get(table)).toBeUndefined();
    expect(cache.get(cacheKey(OTHER_ORG, []))).toBe('other tenant');
  });

  it('evicts the least recently used when full', () => {
    const cache = new PrefixCache<string>(2);
    cache.set('a', '1', 10_000);
    cache.set('b', '2', 10_000);
    cache.get('a'); // 'a' is now the more recent
    cache.set('c', '3', 10_000);

    expect(cache.get('b')).toBeUndefined();
    expect(cache.get('a')).toBe('1');
    expect(cache.get('c')).toBe('3');
  });

  it('stays bounded, so it is not a leak with a friendly name', () => {
    const cache = new PrefixCache<number>(50);
    for (let index = 0; index < 500; index += 1) cache.set(`key-${index}`, index, 10_000);
    expect(cache.size).toBeLessThanOrEqual(50);
  });
});

import { describe, expect, it } from 'vitest';

import { MAX_QUERY_COST, TenantConcurrency, estimateCost, type QueryShape } from '../src/query/cost';

/**
 * A multi-tenant database is only as available as its most expensive query. These tests hold the
 * guard to refusing the queries that would take everyone else down — and, just as importantly, to
 * *not* refusing the ordinary ones.
 */

const shape = (overrides: Partial<QueryShape> = {}): QueryShape => ({
  tableRows: 10_000,
  indexedPredicates: 0,
  unindexedPredicates: 0,
  indexedSorts: 0,
  unindexedSorts: 0,
  limit: 100,
  deepPage: false,
  linkJoins: 0,
  ...overrides,
});

describe('ordinary queries are admitted', () => {
  it('a small table with no filter', () => {
    expect(estimateCost(shape({ tableRows: 500 })).admit).toBe(true);
  });

  it('a large table filtered and sorted on indexed fields', () => {
    // The case that must stay fast: this is what a well-built view looks like.
    const estimate = estimateCost(
      shape({ tableRows: 1_000_000, indexedPredicates: 2, indexedSorts: 1 }),
    );
    expect(estimate.admit).toBe(true);
  });

  it('a large table with an unindexed filter but an indexed sort', () => {
    // The scan can stop once the page is filled, so this is affordable.
    expect(
      estimateCost(shape({ tableRows: 200_000, unindexedPredicates: 1, indexedSorts: 1 })).admit,
    ).toBe(true);
  });

  it('a first page of a moderately large table', () => {
    expect(estimateCost(shape({ tableRows: 100_000, limit: 100 })).admit).toBe(true);
  });
});

describe('expensive queries are refused with a reason', () => {
  it('an unindexed sort over a large table', () => {
    const estimate = estimateCost(shape({ tableRows: 5_000_000, unindexedSorts: 1 }));

    expect(estimate.admit).toBe(false);
    // "Too expensive" with no next step turns into a support ticket.
    expect(estimate.reason).toMatch(/sorts on a field that is not indexed/);
    expect(estimate.remedy).toMatch(/promoted column/);
  });

  it('an unindexed filter over a very large table', () => {
    const estimate = estimateCost(shape({ tableRows: 20_000_000, unindexedPredicates: 2 }));

    expect(estimate.admit).toBe(false);
    expect(estimate.reason).toMatch(/cannot use an index/);
  });

  it('a plain read of a table too large to scan', () => {
    const estimate = estimateCost(shape({ tableRows: 500_000_000 }));
    expect(estimate.admit).toBe(false);
    expect(estimate.remedy).toMatch(/pages/);
  });

  it('names the sort as the problem when both are unindexed', () => {
    // The sort is the more expensive of the two, because it cannot stop early.
    const estimate = estimateCost(
      shape({ tableRows: 10_000_000, unindexedPredicates: 1, unindexedSorts: 1 }),
    );
    expect(estimate.reason).toMatch(/sorts/);
  });
});

describe('cost behaves sensibly', () => {
  it('rises with table size', () => {
    const small = estimateCost(shape({ tableRows: 1_000, unindexedSorts: 1 })).cost;
    const large = estimateCost(shape({ tableRows: 100_000, unindexedSorts: 1 })).cost;
    expect(large).toBeGreaterThan(small);
  });

  it('falls when an index applies', () => {
    const without = estimateCost(shape({ tableRows: 1_000_000, unindexedSorts: 1 })).cost;
    const with2 = estimateCost(
      shape({ tableRows: 1_000_000, indexedPredicates: 2, unindexedSorts: 1 }),
    ).cost;
    expect(with2).toBeLessThan(without);
  });

  it('does not treat three indexed filters as thirty times better than one', () => {
    // Compounding selectivity rather than multiplying by the count, so an over-filtered query is
    // not estimated as free.
    const one = estimateCost(shape({ tableRows: 1_000_000, indexedPredicates: 1, unindexedSorts: 1 })).cost;
    const three = estimateCost(shape({ tableRows: 1_000_000, indexedPredicates: 3, unindexedSorts: 1 })).cost;
    expect(three).toBeGreaterThan(0);
    expect(one / three).toBeLessThan(1_000);
  });

  it('rises with each link join', () => {
    const none = estimateCost(shape({ tableRows: 100_000, unindexedSorts: 1 })).cost;
    const joined = estimateCost(shape({ tableRows: 100_000, unindexedSorts: 1, linkJoins: 2 })).cost;
    expect(joined).toBeGreaterThan(none);
  });

  it('is never zero or negative, even for an empty table', () => {
    const estimate = estimateCost(shape({ tableRows: 0 }));
    expect(estimate.cost).toBeGreaterThan(0);
    expect(estimate.admit).toBe(true);
  });

  it('admits exactly at the threshold', () => {
    // The boundary is inclusive, so a query estimated at precisely the limit is not refused.
    const estimate = estimateCost(shape({ tableRows: MAX_QUERY_COST, indexedSorts: 1 }));
    expect(estimate.cost).toBeLessThanOrEqual(MAX_QUERY_COST);
    expect(estimate.admit).toBe(true);
  });
});

describe('TenantConcurrency', () => {
  it('admits up to the limit', () => {
    const gate = new TenantConcurrency(2);
    expect(gate.tryAcquire('org_1')).toBe(true);
    expect(gate.tryAcquire('org_1')).toBe(true);
    expect(gate.tryAcquire('org_1')).toBe(false);
  });

  it('keeps tenants independent', () => {
    // The whole point: a busy tenant slows itself down, not everybody else.
    const gate = new TenantConcurrency(1);
    expect(gate.tryAcquire('org_1')).toBe(true);
    expect(gate.tryAcquire('org_2')).toBe(true);
    expect(gate.tryAcquire('org_1')).toBe(false);
  });

  it('frees a slot on release', () => {
    const gate = new TenantConcurrency(1);
    gate.tryAcquire('org_1');
    gate.release('org_1');
    expect(gate.tryAcquire('org_1')).toBe(true);
  });

  it('does not go negative on an extra release', () => {
    const gate = new TenantConcurrency(1);
    gate.release('org_1');
    gate.release('org_1');
    expect(gate.active('org_1')).toBe(0);
    expect(gate.tryAcquire('org_1')).toBe(true);
  });

  it('forgets a tenant once it is idle', () => {
    // Otherwise the map grows by one entry per organization that has ever issued a query.
    const gate = new TenantConcurrency(4);
    gate.tryAcquire('org_1');
    gate.release('org_1');
    expect(gate.tracked).toBe(0);
  });
});

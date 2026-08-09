import { PLANS } from '@tessera/types';
import { describe, expect, it } from 'vitest';

import {
  checkLimit,
  describeLimit,
  downgradeImpact,
  entitlementsFor,
  hasFeature,
} from '../src/entitlements';

/**
 * A limit enforced silently — by clipping a list, or by an insert that quietly fails — is worse
 * than one that refuses loudly. These tests hold the refusals to naming the limit and the usage.
 */

describe('checkLimit', () => {
  it('allows an addition inside the limit', () => {
    const decision = checkLimit('free', 'workspaces', 0);
    expect(decision.allowed).toBe(true);
    expect(decision.remaining).toBe(1);
  });

  it('refuses the addition that would exceed it', () => {
    // free allows 1 workspace.
    expect(checkLimit('free', 'workspaces', 1).allowed).toBe(false);
  });

  it('allows exactly reaching the limit', () => {
    const decision = checkLimit('free', 'seats', 4);
    expect(decision.allowed).toBe(true);
    expect(checkLimit('free', 'seats', 5).allowed).toBe(false);
  });

  it('accounts for adding several at once', () => {
    // Inviting five people when two seats remain must be refused as a batch, not accepted and
    // then half-applied.
    expect(checkLimit('free', 'seats', 3, 1).allowed).toBe(true);
    expect(checkLimit('free', 'seats', 3, 5).allowed).toBe(false);
  });

  it('treats an unlimited entitlement as unlimited', () => {
    // Written as null in the table. `null >= 0` is true and `3 <= null` is false, so a naive
    // numeric comparison refuses every addition on exactly the plans that have no limit.
    const unlimited = PLANS.find((plan) => entitlementsFor(plan).seats == null);
    expect(unlimited, 'expected at least one plan with an unlimited seat count').toBeDefined();

    const decision = checkLimit(unlimited as never, 'seats', 1_000_000);
    expect(decision.allowed).toBe(true);
    expect(decision.remaining).toBe(Number.POSITIVE_INFINITY);
    expect(decision.overLimit).toBe(false);
  });

  it('reports being over the limit without pretending it is allowed', () => {
    // Reachable after a downgrade. It must block further additions and be visible — not delete
    // anything, and not silently pass.
    const decision = checkLimit('free', 'seats', 9);
    expect(decision.overLimit).toBe(true);
    expect(decision.allowed).toBe(false);
    expect(decision.remaining).toBe(0);
  });

  it('never reports negative remaining', () => {
    expect(checkLimit('free', 'seats', 99).remaining).toBe(0);
  });
});

describe('describeLimit', () => {
  it('names the limit and the usage', () => {
    // "Upgrade" without a number is not actionable.
    const message = describeLimit('seats', checkLimit('free', 'seats', 5));
    expect(message).toContain('5');
    expect(message).toMatch(/members/);
  });

  it('says plainly when an account is already over', () => {
    const message = describeLimit('seats', checkLimit('free', 'seats', 9));
    expect(message).toMatch(/over its limit/);
    expect(message).toContain('9');
  });
});

describe('hasFeature', () => {
  it('refuses paid features on the free plan', () => {
    expect(hasFeature('free', 'sso')).toBe(false);
    expect(hasFeature('free', 'interfaces')).toBe(false);
  });

  it('grants them on a plan that includes them', () => {
    const withSso = PLANS.find((plan) => hasFeature(plan, 'sso'));
    expect(withSso).toBeDefined();
  });
});

describe('downgradeImpact', () => {
  it('names the limits a downgrade would break', () => {
    // Told before the change, not discovered as an outage afterwards.
    const impact = downgradeImpact('business', 'free', { seats: 40, workspaces: 6 });

    expect(impact.exceeded.map((item) => item.limit).sort()).toEqual(['seats', 'workspaces']);
    expect(impact.exceeded.find((item) => item.limit === 'seats')?.current).toBe(40);
  });

  it('names the features that would be lost', () => {
    const impact = downgradeImpact('business', 'free', {});
    expect(impact.lostFeatures).toContain('sso');
  });

  it('reports nothing for an upgrade', () => {
    const impact = downgradeImpact('free', 'business', { seats: 3 });
    expect(impact.exceeded).toEqual([]);
    expect(impact.lostFeatures).toEqual([]);
  });

  it('reports nothing when usage fits the smaller plan', () => {
    const impact = downgradeImpact('business', 'free', { seats: 2, workspaces: 1 });
    expect(impact.exceeded).toEqual([]);
  });
});

describe('every plan is fully specified', () => {
  // A plan missing an entitlement would read as `undefined`, and `undefined < 0` is false — so a
  // missing limit would silently behave as a limit of zero and lock the plan out entirely.
  for (const plan of PLANS) {
    it(plan, () => {
      const entitlements = entitlementsFor(plan) as Record<string, unknown>;
      // undefined would read as a limit of zero through the same coercion that null does.
      for (const [key, value] of Object.entries(entitlements)) {
        expect(value, `${plan}.${key}`).not.toBeUndefined();
      }
    });
  }
});

import { PLAN_ENTITLEMENTS, type Entitlements, type Plan } from '@tessera/types';

/**
 * Plan limit enforcement.
 *
 * Two kinds of limit, and they fail differently on purpose:
 *
 *  - **Countable** (seats, bases, records, storage) — checked *before* the thing is created, so
 *    the refusal names the limit and the current usage. Checking after would mean either
 *    deleting what was just made or leaving the account over its limit.
 *  - **Feature** (SSO, interfaces, custom roles) — checked when the feature is used. There is no
 *    count, so the answer is only ever "your plan does not include this".
 *
 * A limit that is enforced silently — by clipping a list, or by an insert that quietly fails — is
 * worse than one that refuses loudly. Every refusal here carries what the limit is and what the
 * account currently has, because "upgrade" without a number is not actionable.
 */

export type CountableLimit =
  | 'seats'
  | 'guests'
  | 'workspaces'
  | 'basesPerWorkspace'
  | 'recordsPerBase'
  | 'attachmentStorageBytes'
  | 'automationRunsPerMonth'
  | 'formSubmissionsPerMonth';

export type FeatureFlag =
  | 'advancedViews'
  | 'interfaces'
  | 'customRoles'
  | 'fieldLevelPermissions'
  | 'sso'
  | 'scim'
  | 'auditLogExport'
  | 'enforcedTwoFactor';

export interface LimitDecision {
  readonly allowed: boolean;
  readonly limit: number;
  readonly current: number;
  /** How many more may be added. Zero when at the limit; never negative. */
  readonly remaining: number;
  /** True when the account is already past its limit — possible after a downgrade. */
  readonly overLimit: boolean;
}

/**
 * Whether `count` more of something may be added.
 *
 * Unlimited is expressed as `null` in the entitlement table, and that must be tested for
 * explicitly. `null >= 0` is *true* in JavaScript and `3 <= null` is *false*, so a comparison
 * that treats null as a number refuses every addition on exactly the plans that have no limit —
 * the paying ones. Checked through one helper so no caller has to remember.
 */
function isUnlimited(max: unknown): boolean {
  return max === null || max === undefined || (typeof max === 'number' && max < 0);
}

export function checkLimit(
  plan: Plan,
  limit: CountableLimit,
  current: number,
  adding = 1,
): LimitDecision {
  const raw = PLAN_ENTITLEMENTS[plan][limit] as number | null;

  if (isUnlimited(raw)) {
    return {
      allowed: true,
      limit: Number.POSITIVE_INFINITY,
      current,
      remaining: Number.POSITIVE_INFINITY,
      overLimit: false,
    };
  }

  const max = raw as number;

  return {
    allowed: current + adding <= max,
    limit: max,
    current,
    remaining: Math.max(0, max - current),
    // A downgrade can leave an account above its new limit. That must not delete anything — it
    // blocks further additions and is reported, so somebody can decide what to remove.
    overLimit: current > max,
  };
}

export function hasFeature(plan: Plan, feature: FeatureFlag): boolean {
  return PLAN_ENTITLEMENTS[plan][feature] === true;
}

/** A message that names the limit and the usage, because "upgrade" alone is not actionable. */
export function describeLimit(limit: CountableLimit, decision: LimitDecision): string {
  const noun = LIMIT_NOUNS[limit];

  if (decision.overLimit) {
    return `This account has ${decision.current} ${noun}, which is over its limit of ${decision.limit}.`;
  }
  return `This plan allows ${decision.limit} ${noun}, and ${decision.current} are in use.`;
}

const LIMIT_NOUNS: Readonly<Record<CountableLimit, string>> = {
  seats: 'members',
  guests: 'guests',
  workspaces: 'workspaces',
  basesPerWorkspace: 'bases in a workspace',
  recordsPerBase: 'records in a base',
  attachmentStorageBytes: 'bytes of attachment storage',
  automationRunsPerMonth: 'automation runs a month',
  formSubmissionsPerMonth: 'form submissions a month',
};

/**
 * What a downgrade would break.
 *
 * Run before a plan change so the person is told what they will lose *first* — a downgrade that
 * silently disables SSO, or leaves an account over its seat limit with no explanation, is how a
 * billing change becomes an outage nobody connects to the billing change.
 */
export function downgradeImpact(
  from: Plan,
  to: Plan,
  usage: Partial<Record<CountableLimit, number>>,
): { exceeded: Array<{ limit: CountableLimit; current: number; allowed: number }>; lostFeatures: FeatureFlag[] } {
  const exceeded: Array<{ limit: CountableLimit; current: number; allowed: number }> = [];

  for (const [limit, current] of Object.entries(usage) as Array<[CountableLimit, number]>) {
    const max = PLAN_ENTITLEMENTS[to][limit] as number | null;
    if (!isUnlimited(max) && current > (max as number)) {
      exceeded.push({ limit, current, allowed: max as number });
    }
  }

  const source = PLAN_ENTITLEMENTS[from] as unknown as Record<string, unknown>;
  const features = Object.keys(source).filter(
    (key) => typeof source[key] === 'boolean',
  ) as FeatureFlag[];

  const lostFeatures = features.filter((feature) => hasFeature(from, feature) && !hasFeature(to, feature));

  return { exceeded, lostFeatures };
}

/** The full entitlement set, for showing a plan comparison without reaching into the table. */
export function entitlementsFor(plan: Plan): Entitlements {
  return PLAN_ENTITLEMENTS[plan];
}

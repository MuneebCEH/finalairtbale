import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * Outbound webhook signing and delivery semantics.
 *
 * A webhook is a message this platform sends to somebody else's server claiming "this happened in
 * your base". The receiver has no other way to know it came from us, so the signature is the
 * whole security model — and the three mistakes that make one useless are all closed here:
 *
 *  1. **Signing the body alone** lets an attacker replay a captured request forever. The timestamp
 *     is inside the signed material, and stale timestamps are refused.
 *  2. **Comparing signatures with `===`** leaks the correct prefix through timing.
 *  3. **Retrying forever** turns one unreachable endpoint into an ever-growing queue.
 */

/** How far a delivery's timestamp may drift before a receiver should refuse it. */
export const SIGNATURE_TOLERANCE_SECONDS = 300;

export interface SignedDelivery {
  readonly body: string;
  readonly timestamp: number;
  readonly signature: string;
  readonly headers: Readonly<Record<string, string>>;
}

/**
 * Signs a delivery.
 *
 * The signed material is `timestamp.body`, not `body` — this is what makes a captured request
 * expire. The scheme is stated in the header (`v1=`) so a future algorithm can be introduced
 * without every receiver breaking on the day it changes.
 */
export function signDelivery(
  secret: string,
  body: string,
  timestamp: number = Math.floor(Date.now() / 1000),
): SignedDelivery {
  const signature = createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex');

  return {
    body,
    timestamp,
    signature,
    headers: {
      'Content-Type': 'application/json',
      'X-Tessera-Timestamp': String(timestamp),
      'X-Tessera-Signature': `v1=${signature}`,
    },
  };
}

/**
 * Verifies a delivery, as a receiver would.
 *
 * Shipped as part of the platform rather than left to each integrator: the failure modes above are
 * subtle, everyone implements them slightly differently, and a receiver that verifies incorrectly
 * is a hole in the customer's system that looks like our fault.
 */
export function verifyDelivery(input: {
  secret: string;
  body: string;
  timestamp: string | number;
  signature: string;
  now?: number;
  toleranceSeconds?: number;
}): { ok: true } | { ok: false; reason: 'malformed' | 'stale' | 'mismatch' } {
  const timestamp = Number(input.timestamp);
  if (!Number.isFinite(timestamp)) return { ok: false, reason: 'malformed' };

  const now = input.now ?? Math.floor(Date.now() / 1000);
  const tolerance = input.toleranceSeconds ?? SIGNATURE_TOLERANCE_SECONDS;
  // Absolute difference, so a timestamp from the future is refused too — otherwise an attacker
  // can mint a request that stays valid indefinitely by dating it forward.
  if (Math.abs(now - timestamp) > tolerance) return { ok: false, reason: 'stale' };

  const provided = input.signature.startsWith('v1=') ? input.signature.slice(3) : input.signature;
  const expected = createHmac('sha256', input.secret).update(`${timestamp}.${input.body}`).digest('hex');

  const a = Buffer.from(expected, 'hex');
  const b = Buffer.from(provided, 'hex');
  // Length is checked first: timingSafeEqual throws on a mismatch rather than returning false.
  if (a.length !== b.length) return { ok: false, reason: 'mismatch' };
  if (!timingSafeEqual(a, b)) return { ok: false, reason: 'mismatch' };

  return { ok: true };
}

/** A webhook secret. Shown once, stored hashed like every other credential. */
export function generateWebhookSecret(): string {
  return `whsec_${randomBytes(32).toString('base64url')}`;
}

/**
 * Delivery retry schedule, in seconds.
 *
 * Spread over roughly a day: long enough that a receiver's deploy or brief outage does not lose
 * the event, short enough that a permanently dead endpoint stops consuming the queue. After the
 * last attempt the endpoint is disabled and its owner is told, rather than the platform retrying
 * into a void forever.
 */
export const DELIVERY_BACKOFF_SECONDS = [10, 60, 300, 1_800, 7_200, 21_600, 43_200] as const;

export const MAX_DELIVERY_ATTEMPTS = DELIVERY_BACKOFF_SECONDS.length;

export function deliveryDelay(attempt: number): number | null {
  return DELIVERY_BACKOFF_SECONDS[attempt - 1] ?? null;
}

/**
 * What to do after a delivery attempt.
 *
 * 2xx succeeds. 410 Gone is honoured immediately — the receiver is explicitly saying the endpoint
 * is retired, and retrying for a day after being told that is rude and pointless. Other 4xx are
 * not retried for the same reason they are not retried anywhere else: the request will be just as
 * wrong next time.
 */
export function classifyDelivery(
  attempt: number,
  result: { status?: number; networkError?: boolean },
): { outcome: 'delivered' } | { outcome: 'retry'; afterSeconds: number } | { outcome: 'failed'; disable: boolean } {
  const status = result.status;

  if (!result.networkError && typeof status === 'number' && status >= 200 && status < 300) {
    return { outcome: 'delivered' };
  }

  if (status === 410) return { outcome: 'failed', disable: true };

  const worthRetrying =
    result.networkError === true ||
    status === undefined ||
    status === 408 ||
    status === 429 ||
    (status >= 500 && status < 600);

  if (!worthRetrying) return { outcome: 'failed', disable: false };

  const delay = deliveryDelay(attempt);
  if (delay === null) {
    // Attempts exhausted against a receiver that never recovered. Disabling stops an endpoint
    // that has been dead for a day from consuming the queue indefinitely.
    return { outcome: 'failed', disable: true };
  }

  return { outcome: 'retry', afterSeconds: delay };
}

/**
 * Whether an event should be sent to a subscription.
 *
 * Patterns are `resource.action` with `*` allowed in either position — `record.*` and `*.deleted`
 * are both useful, and a full glob grammar buys nothing here while being much easier to get wrong.
 */
export function matchesEventPattern(pattern: string, event: string): boolean {
  if (pattern === '*') return true;

  const [patternResource, patternAction] = pattern.split('.');
  const [eventResource, eventAction] = event.split('.');

  if (!patternResource || !patternAction || !eventResource || !eventAction) return false;

  const resourceOk = patternResource === '*' || patternResource === eventResource;
  const actionOk = patternAction === '*' || patternAction === eventAction;

  return resourceOk && actionOk;
}

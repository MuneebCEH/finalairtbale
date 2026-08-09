import { describe, expect, it } from 'vitest';

import {
  MAX_DELIVERY_ATTEMPTS,
  SIGNATURE_TOLERANCE_SECONDS,
  classifyDelivery,
  deliveryDelay,
  generateWebhookSecret,
  matchesEventPattern,
  signDelivery,
  verifyDelivery,
} from '../src/webhooks';

/**
 * A webhook signature is the receiver's only evidence that a message came from us. These tests
 * are the three ways a signing scheme is usually broken.
 */

const SECRET = 'whsec_test_secret_value';
const BODY = JSON.stringify({ event: 'record.created', recordId: 'rec_1' });
const NOW = 1_800_000_000;

describe('signing', () => {
  it('produces a versioned signature and a timestamp header', () => {
    const signed = signDelivery(SECRET, BODY, NOW);

    expect(signed.headers['X-Tessera-Signature']).toMatch(/^v1=[0-9a-f]{64}$/);
    expect(signed.headers['X-Tessera-Timestamp']).toBe(String(NOW));
  });

  it('verifies its own delivery', () => {
    const signed = signDelivery(SECRET, BODY, NOW);
    expect(
      verifyDelivery({
        secret: SECRET,
        body: signed.body,
        timestamp: signed.timestamp,
        signature: signed.headers['X-Tessera-Signature'] as string,
        now: NOW,
      }),
    ).toEqual({ ok: true });
  });

  it('accepts a bare signature as well as a versioned one', () => {
    const signed = signDelivery(SECRET, BODY, NOW);
    expect(
      verifyDelivery({ secret: SECRET, body: BODY, timestamp: NOW, signature: signed.signature, now: NOW }),
    ).toEqual({ ok: true });
  });

  it('signs the timestamp along with the body', () => {
    // Signing the body alone lets a captured request be replayed forever.
    const a = signDelivery(SECRET, BODY, NOW);
    const b = signDelivery(SECRET, BODY, NOW + 1);
    expect(a.signature).not.toBe(b.signature);
  });
});

describe('verification refuses', () => {
  const signed = signDelivery(SECRET, BODY, NOW);
  const verify = (overrides: Record<string, unknown> = {}) =>
    verifyDelivery({
      secret: SECRET,
      body: BODY,
      timestamp: NOW,
      signature: signed.signature,
      now: NOW,
      ...overrides,
    });

  it('a tampered body', () => {
    expect(verify({ body: JSON.stringify({ event: 'record.deleted' }) })).toMatchObject({
      reason: 'mismatch',
    });
  });

  it('a wrong secret', () => {
    expect(verify({ secret: 'whsec_someone_elses' })).toMatchObject({ reason: 'mismatch' });
  });

  it('a signature with any byte changed', () => {
    const flipped = (signed.signature[0] === '0' ? '1' : '0') + signed.signature.slice(1);
    expect(verify({ signature: flipped })).toMatchObject({ reason: 'mismatch' });
  });

  it('a truncated signature, without throwing', () => {
    // timingSafeEqual throws on a length mismatch; the length check has to come first.
    expect(() => verify({ signature: signed.signature.slice(0, 20) })).not.toThrow();
    expect(verify({ signature: signed.signature.slice(0, 20) })).toMatchObject({ reason: 'mismatch' });
    expect(verify({ signature: '' })).toMatchObject({ reason: 'mismatch' });
  });

  it('a stale timestamp', () => {
    expect(verify({ now: NOW + SIGNATURE_TOLERANCE_SECONDS + 1 })).toMatchObject({ reason: 'stale' });
  });

  it('a timestamp from the future', () => {
    // Otherwise a forward-dated request stays valid indefinitely.
    expect(verify({ now: NOW - SIGNATURE_TOLERANCE_SECONDS - 1 })).toMatchObject({ reason: 'stale' });
  });

  it('a malformed timestamp', () => {
    expect(verify({ timestamp: 'yesterday' })).toMatchObject({ reason: 'malformed' });
  });

  it('but accepts drift inside the tolerance', () => {
    expect(verify({ now: NOW + SIGNATURE_TOLERANCE_SECONDS - 1 })).toEqual({ ok: true });
  });
});

describe('secrets', () => {
  it('are prefixed so a leaked one is greppable', () => {
    expect(generateWebhookSecret().startsWith('whsec_')).toBe(true);
  });

  it('do not repeat', () => {
    const seen = new Set(Array.from({ length: 500 }, () => generateWebhookSecret()));
    expect(seen.size).toBe(500);
  });
});

describe('delivery classification', () => {
  it('treats 2xx as delivered', () => {
    for (const status of [200, 201, 202, 204]) {
      expect(classifyDelivery(1, { status }), String(status)).toEqual({ outcome: 'delivered' });
    }
  });

  it('retries server errors and network failures', () => {
    expect(classifyDelivery(1, { status: 500 })).toMatchObject({ outcome: 'retry' });
    expect(classifyDelivery(1, { status: 503 })).toMatchObject({ outcome: 'retry' });
    expect(classifyDelivery(1, { networkError: true })).toMatchObject({ outcome: 'retry' });
    expect(classifyDelivery(1, { status: 429 })).toMatchObject({ outcome: 'retry' });
  });

  it('does not retry a request that was simply wrong', () => {
    for (const status of [400, 401, 403, 404, 422]) {
      expect(classifyDelivery(1, { status }), String(status)).toEqual({
        outcome: 'failed',
        disable: false,
      });
    }
  });

  it('honours 410 Gone immediately', () => {
    // The receiver is explicitly saying the endpoint is retired; retrying for a day after being
    // told that is rude and pointless.
    expect(classifyDelivery(1, { status: 410 })).toEqual({ outcome: 'failed', disable: true });
  });

  it('backs off further with each attempt', () => {
    const first = classifyDelivery(1, { status: 500 });
    const later = classifyDelivery(4, { status: 500 });
    expect(first).toMatchObject({ outcome: 'retry' });
    expect(later).toMatchObject({ outcome: 'retry' });
    expect((later as { afterSeconds: number }).afterSeconds).toBeGreaterThan(
      (first as { afterSeconds: number }).afterSeconds,
    );
  });

  it('disables an endpoint that never recovered', () => {
    // A day of failures is enough; retrying into a void forever grows the queue without bound.
    expect(classifyDelivery(MAX_DELIVERY_ATTEMPTS + 1, { status: 500 })).toEqual({
      outcome: 'failed',
      disable: true,
    });
  });

  it('spreads its attempts over roughly a day', () => {
    const total = Array.from({ length: MAX_DELIVERY_ATTEMPTS }, (_, i) => deliveryDelay(i + 1) ?? 0)
      .reduce((a, b) => a + b, 0);
    expect(total).toBeGreaterThan(12 * 3_600);
    expect(total).toBeLessThan(36 * 3_600);
  });
});

describe('event patterns', () => {
  it('matches an exact event', () => {
    expect(matchesEventPattern('record.created', 'record.created')).toBe(true);
    expect(matchesEventPattern('record.created', 'record.deleted')).toBe(false);
  });

  it('matches a wildcard action', () => {
    expect(matchesEventPattern('record.*', 'record.deleted')).toBe(true);
    expect(matchesEventPattern('record.*', 'field.deleted')).toBe(false);
  });

  it('matches a wildcard resource', () => {
    expect(matchesEventPattern('*.deleted', 'record.deleted')).toBe(true);
    expect(matchesEventPattern('*.deleted', 'record.created')).toBe(false);
  });

  it('matches everything with a bare star', () => {
    expect(matchesEventPattern('*', 'anything.at.all')).toBe(true);
  });

  it('refuses a malformed pattern rather than matching loosely', () => {
    // A pattern that fails to parse must subscribe to nothing, not to everything.
    expect(matchesEventPattern('record', 'record.created')).toBe(false);
    expect(matchesEventPattern('', 'record.created')).toBe(false);
  });
});

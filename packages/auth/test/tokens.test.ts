import { createHash } from 'node:crypto';

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  expiresIn,
  generateRecoveryCodes,
  generateSlug,
  hashToken,
  isExpired,
  issueApiToken,
  issueOAuthAccessToken,
  issueToken,
} from '../src/tokens';

/**
 * The property that matters for every credential here: the plaintext is unguessable and is never
 * what gets stored. A regression in either direction is a full authentication bypass, so both are
 * asserted directly rather than inferred from the code.
 */

afterEach(() => {
  vi.useRealTimers();
});

describe('issueToken', () => {
  it('stores a hash, never the plaintext', () => {
    const token = issueToken();

    expect(token.hash).not.toBe(token.plaintext);
    expect(token.hash).toBe(createHash('sha256').update(token.plaintext, 'utf8').digest('hex'));
    expect(token.hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('carries at least 256 bits of entropy', () => {
    // 32 random bytes base64url-encoded is 43 characters with no padding.
    const token = issueToken();
    expect(token.plaintext).toHaveLength(43);
    expect(token.plaintext).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it('is URL-safe, so it survives being placed in a link', () => {
    for (let i = 0; i < 200; i += 1) {
      const { plaintext } = issueToken();
      expect(encodeURIComponent(plaintext)).toBe(plaintext);
    }
  });

  it('never repeats', () => {
    const seen = new Set<string>();
    for (let i = 0; i < 2_000; i += 1) seen.add(issueToken().plaintext);
    expect(seen.size).toBe(2_000);
  });

  it('applies a prefix without shortening the random part', () => {
    const token = issueToken('inv');

    expect(token.plaintext.startsWith('inv_')).toBe(true);
    expect(token.plaintext.slice(4)).toHaveLength(43);
  });

  it('exposes a non-secret prefix short enough to be useless on its own', () => {
    const token = issueToken('inv');

    expect(token.prefix).toHaveLength(12);
    expect(token.plaintext.startsWith(token.prefix)).toBe(true);
    // The displayed prefix must not be enough to reconstruct the token.
    expect(token.prefix.length).toBeLessThan(token.plaintext.length / 2);
  });

  it('tags API tokens so secret scanners can find them in a leak', () => {
    expect(issueApiToken().plaintext.startsWith('tsk_')).toBe(true);
    expect(issueOAuthAccessToken().plaintext.startsWith('tsa_')).toBe(true);
  });
});

describe('hashToken', () => {
  it('is deterministic, so a presented token can be looked up', () => {
    expect(hashToken('abc')).toBe(hashToken('abc'));
  });

  it('separates tokens that differ by a single character', () => {
    expect(hashToken('abc')).not.toBe(hashToken('abd'));
  });
});

describe('generateRecoveryCodes', () => {
  it('produces the requested shape', () => {
    const codes = generateRecoveryCodes(10, 10);

    expect(codes).toHaveLength(10);
    for (const code of codes) expect(code).toHaveLength(10);
  });

  it('omits characters a person would misread off paper', () => {
    // These are read aloud or typed from a printout after losing a phone.
    const codes = generateRecoveryCodes(200, 12).join('');
    for (const ambiguous of ['0', 'o', '1', 'l', 'i']) {
      expect(codes, `contains ${ambiguous}`).not.toContain(ambiguous);
    }
  });

  it('does not repeat within a batch', () => {
    const codes = generateRecoveryCodes(50, 10);
    expect(new Set(codes).size).toBe(50);
  });
});

describe('generateSlug', () => {
  it('defaults to a length that resists enumeration', () => {
    expect(generateSlug()).toHaveLength(16);
  });

  it('stays within a URL-safe alphabet', () => {
    for (let i = 0; i < 200; i += 1) expect(generateSlug()).toMatch(/^[a-z2-7]{16}$/);
  });

  it('does not collide across a large sample', () => {
    const seen = new Set<string>();
    for (let i = 0; i < 5_000; i += 1) seen.add(generateSlug());
    expect(seen.size).toBe(5_000);
  });
});

describe('expiry', () => {
  it('computes future instants from the current time', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));

    expect(expiresIn.minutes(15).toISOString()).toBe('2026-01-01T00:15:00.000Z');
    expect(expiresIn.hours(2).toISOString()).toBe('2026-01-01T02:00:00.000Z');
    expect(expiresIn.days(7).toISOString()).toBe('2026-01-08T00:00:00.000Z');
  });

  it('treats a missing expiry as expired, never as eternal', () => {
    // Fail closed: an absent value must not read as "never expires".
    expect(isExpired(null)).toBe(true);
    expect(isExpired(undefined)).toBe(true);
  });

  it('treats the exact expiry instant as expired', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));

    expect(isExpired(new Date('2026-01-01T00:00:00.000Z'))).toBe(true);
    expect(isExpired(new Date('2026-01-01T00:00:00.001Z'))).toBe(false);
    expect(isExpired(new Date('2025-12-31T23:59:59.999Z'))).toBe(true);
  });
});

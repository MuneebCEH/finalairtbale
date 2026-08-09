import { createHash } from 'node:crypto';

import { describe, expect, it, vi } from 'vitest';

import {
  hashPassword,
  isBreachedPassword,
  safeEqual,
  verifyPassword,
} from '../src/password';

/**
 * Argon2 is deliberately slow, so these tests are slower than the rest of the suite. That cost is
 * accepted: the alternative is having no direct evidence that the login path rejects wrong
 * passwords, which is not a property to take on trust.
 */

describe('hashPassword', () => {
  it('produces an argon2id hash, not a plaintext or a fast digest', async () => {
    const hash = await hashPassword('correct horse battery staple');

    expect(hash.startsWith('$argon2id$')).toBe(true);
    expect(hash).not.toContain('correct horse');
  });

  it('salts, so the same password hashes differently every time', async () => {
    const [a, b] = await Promise.all([hashPassword('same-password'), hashPassword('same-password')]);
    expect(a).not.toBe(b);
  });

  it('does not truncate long passwords the way bcrypt does', async () => {
    // bcrypt ignores everything past 72 bytes; two passwords differing only after that point
    // would verify against each other. Argon2 must not.
    const base = 'x'.repeat(72);
    const hash = await hashPassword(`${base}AAAA`);

    expect(await verifyPassword(hash, `${base}BBBB`)).toBe(false);
    expect(await verifyPassword(hash, `${base}AAAA`)).toBe(true);
  });
});

describe('verifyPassword', () => {
  it('accepts the right password', async () => {
    const hash = await hashPassword('s3cret-passphrase');
    expect(await verifyPassword(hash, 's3cret-passphrase')).toBe(true);
  });

  it('rejects a wrong password', async () => {
    const hash = await hashPassword('s3cret-passphrase');

    expect(await verifyPassword(hash, 's3cret-passphras')).toBe(false);
    expect(await verifyPassword(hash, 'S3cret-passphrase')).toBe(false);
    expect(await verifyPassword(hash, '')).toBe(false);
  });

  it('returns false for a malformed hash instead of throwing', async () => {
    // A corrupted row must look exactly like a wrong password to the caller — not like a 500.
    for (const hash of ['', 'not-a-hash', '$argon2id$broken', '$2b$10$bcryptstylehash']) {
      await expect(verifyPassword(hash, 'anything')).resolves.toBe(false);
    }
  });
});

describe('safeEqual', () => {
  it('compares equal strings as equal', () => {
    expect(safeEqual('abc123', 'abc123')).toBe(true);
    expect(safeEqual('', '')).toBe(true);
  });

  it('rejects differing strings', () => {
    expect(safeEqual('abc123', 'abc124')).toBe(false);
    expect(safeEqual('abc', 'abcd')).toBe(false);
    expect(safeEqual('abcd', 'abc')).toBe(false);
  });

  it('does not throw on a length mismatch', () => {
    // timingSafeEqual throws when lengths differ; the wrapper must absorb that.
    expect(() => safeEqual('a', 'a'.repeat(1_000))).not.toThrow();
  });

  it('handles multi-byte characters by their bytes, not their code points', () => {
    expect(safeEqual('é', 'é')).toBe(true);
    expect(safeEqual('é', 'e')).toBe(false);
  });
});

describe('isBreachedPassword', () => {
  const sha1 = (value: string): string =>
    createHash('sha1').update(value, 'utf8').digest('hex').toUpperCase();

  it('sends only the first five hash characters, never the password or the full hash', async () => {
    const full = sha1('hunter2');
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: true,
      text: () => Promise.resolve(''),
    });

    await isBreachedPassword('hunter2', fetchImpl as unknown as typeof fetch);

    const url = String(fetchImpl.mock.calls[0]?.[0]);
    expect(url).toContain(full.slice(0, 5));
    expect(url).not.toContain('hunter2');
    expect(url).not.toContain(full);
    expect(url).not.toContain(full.slice(5));
  });

  it('reports a match when the suffix is in the range response', async () => {
    const suffix = sha1('hunter2').slice(5);
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: true,
      text: () => Promise.resolve(`0000000000000000000000000000000000:1\r\n${suffix}:37359\r\n`),
    });

    expect(await isBreachedPassword('hunter2', fetchImpl as unknown as typeof fetch)).toBe(true);
  });

  it('reports no match when the suffix is absent', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: true,
      text: () => Promise.resolve('AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA:1\r\n'),
    });

    expect(await isBreachedPassword('a-unique-passphrase', fetchImpl as unknown as typeof fetch)).toBe(
      false,
    );
  });

  it('fails open, because an advisory check must not block a password change', async () => {
    const rejecting = vi.fn().mockRejectedValue(new Error('network down'));
    expect(await isBreachedPassword('x', rejecting as unknown as typeof fetch)).toBe(false);

    const erroring = vi.fn().mockResolvedValue({ ok: false, text: () => Promise.resolve('') });
    expect(await isBreachedPassword('x', erroring as unknown as typeof fetch)).toBe(false);
  });

  it('requests padding so the response size does not reveal the prefix', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({ ok: true, text: () => Promise.resolve('') });

    await isBreachedPassword('x', fetchImpl as unknown as typeof fetch);

    const init = fetchImpl.mock.calls[0]?.[1] as RequestInit;
    expect((init.headers as Record<string, string>)['Add-Padding']).toBe('true');
  });
});

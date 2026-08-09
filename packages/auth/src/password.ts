import { createHash, timingSafeEqual } from 'node:crypto';

import { hash as argonHash, verify as argonVerify } from '@node-rs/argon2';
import { AUTH_POLICY } from '@tessera/config';

/**
 * Password hashing.
 *
 * Argon2id, not bcrypt: bcrypt's 72-byte input truncation and its lack of a memory-hardness
 * parameter make it the weaker choice against modern GPU and ASIC attacks. Parameters follow
 * the OWASP recommendation (19 MiB, t=2, p=1) and live in `@tessera/config` so they can be
 * raised as hardware improves without hunting through the codebase.
 */

export async function hashPassword(plaintext: string): Promise<string> {
  return argonHash(plaintext, {
    memoryCost: AUTH_POLICY.argon2.memoryCost,
    timeCost: AUTH_POLICY.argon2.timeCost,
    parallelism: AUTH_POLICY.argon2.parallelism,
  });
}

/**
 * Verifies a password.
 *
 * Returns `false` rather than throwing on a malformed hash, so a corrupted row cannot be
 * distinguished from a wrong password by timing or by error type.
 */
export async function verifyPassword(hash: string, plaintext: string): Promise<boolean> {
  try {
    return await argonVerify(hash, plaintext);
  } catch {
    return false;
  }
}

/**
 * Performs a dummy hash so that a login attempt against a non-existent account costs
 * approximately the same as one against a real account.
 *
 * Without this, response time is a user-enumeration oracle: "no such user" returns in
 * microseconds while a real user costs the full Argon2 work factor.
 */
const DUMMY_HASH =
  '$argon2id$v=19$m=19456,t=2,p=1$c29tZS1zdGF0aWMtc2FsdA$3Vw8Q1Yl0z3Bx1kZ0aTf3xX1cQ0uZ4E9mQvJ5x0nQ1s';

export async function equalizeTiming(plaintext: string): Promise<void> {
  await verifyPassword(DUMMY_HASH, plaintext);
}

/**
 * Checks a password against Have I Been Pwned's k-anonymity range API.
 *
 * Only the first five characters of the SHA-1 hash leave the process; the full hash never does.
 * A network failure returns `false` (not breached) — availability of an advisory check must not
 * prevent a user from setting a password.
 */
export async function isBreachedPassword(
  plaintext: string,
  fetchImpl: typeof fetch = fetch,
): Promise<boolean> {
  const sha1 = createHash('sha1').update(plaintext, 'utf8').digest('hex').toUpperCase();
  const prefix = sha1.slice(0, 5);
  const suffix = sha1.slice(5);

  try {
    const response = await fetchImpl(`https://api.pwnedpasswords.com/range/${prefix}`, {
      headers: { 'Add-Padding': 'true' },
      signal: AbortSignal.timeout(3_000),
    });
    if (!response.ok) return false;
    const body = await response.text();
    return body
      .split('\n')
      .some((line) => line.split(':')[0]?.trim().toUpperCase() === suffix);
  } catch {
    return false;
  }
}

/** Constant-time comparison for tokens and codes handled as strings. */
export function safeEqual(a: string, b: string): boolean {
  const bufferA = Buffer.from(a, 'utf8');
  const bufferB = Buffer.from(b, 'utf8');
  if (bufferA.length !== bufferB.length) {
    // Compare against itself so the timing does not reveal the length mismatch.
    timingSafeEqual(bufferA, bufferA);
    return false;
  }
  return timingSafeEqual(bufferA, bufferB);
}

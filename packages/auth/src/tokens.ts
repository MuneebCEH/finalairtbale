import { createHash, randomBytes } from 'node:crypto';

/**
 * Opaque token generation and storage.
 *
 * Every credential the platform issues — session refresh tokens, email verification links,
 * password reset links, magic links, invitations, API tokens — follows the same shape:
 *
 *   • 32 bytes from the CSPRNG, base64url encoded (256 bits of entropy)
 *   • the plaintext is returned to the caller exactly once
 *   • only the SHA-256 is persisted
 *
 * SHA-256 rather than Argon2 here is deliberate and is *not* the same trade-off as passwords: a
 * 256-bit random token has no brute-forceable structure, so a slow hash buys nothing and would
 * cost a full Argon2 computation on every request that presents one.
 */

export interface IssuedToken {
  /** Give this to the user. It is never stored. */
  readonly plaintext: string;
  /** Store this. */
  readonly hash: string;
  /** Non-secret leading characters, for display in a token list and for log correlation. */
  readonly prefix: string;
}

export function issueToken(prefix?: string): IssuedToken {
  const random = randomBytes(32).toString('base64url');
  const plaintext = prefix ? `${prefix}_${random}` : random;
  return {
    plaintext,
    hash: hashToken(plaintext),
    prefix: plaintext.slice(0, 12),
  };
}

export function hashToken(plaintext: string): string {
  return createHash('sha256').update(plaintext, 'utf8').digest('hex');
}

/** Personal access token. The `tsk_` prefix makes leaked tokens greppable by secret scanners. */
export function issueApiToken(): IssuedToken {
  return issueToken('tsk');
}

export function issueOAuthAccessToken(): IssuedToken {
  return issueToken('tsa');
}

/**
 * Recovery codes for two-factor authentication.
 *
 * Lowercase alphanumeric with the visually ambiguous characters removed, because these are read
 * off paper by a person who has just lost their phone and is not in a mood to distinguish `0`
 * from `O`.
 */
const RECOVERY_ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789';

export function generateRecoveryCodes(count: number, length: number): string[] {
  const codes: string[] = [];
  for (let i = 0; i < count; i += 1) {
    const bytes = randomBytes(length);
    let code = '';
    for (let j = 0; j < length; j += 1) {
      code += RECOVERY_ALPHABET[(bytes[j] as number) % RECOVERY_ALPHABET.length];
    }
    codes.push(code);
  }
  return codes;
}

/**
 * A short, unguessable, URL-safe slug for public share links and form URLs.
 *
 * 16 characters of base32 ≈ 80 bits — enough that enumeration is infeasible, short enough to
 * survive being pasted into a chat message.
 */
export function generateSlug(length = 16): string {
  const alphabet = 'abcdefghijklmnopqrstuvwxyz234567';
  const bytes = randomBytes(length);
  let out = '';
  for (let i = 0; i < length; i += 1) {
    out += alphabet[(bytes[i] as number) % alphabet.length];
  }
  return out;
}

/** Expiry helpers, so TTL arithmetic is not repeated (and mis-typed) at every call site. */
export const expiresIn = {
  minutes: (n: number): Date => new Date(Date.now() + n * 60_000),
  hours: (n: number): Date => new Date(Date.now() + n * 3_600_000),
  days: (n: number): Date => new Date(Date.now() + n * 86_400_000),
};

export function isExpired(at: Date | null | undefined): boolean {
  return !at || at.getTime() <= Date.now();
}

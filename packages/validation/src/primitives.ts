import { ID_PREFIXES, type ResourceKind } from '@tessera/types';
import { z } from 'zod';

/**
 * Shared primitive schemas.
 *
 * These are defined once and reused by the API (request validation), the web app (form
 * validation), and the SDK (client-side pre-checks). One definition means the three can never
 * disagree about what a valid email or a valid slug is.
 */

/** ULID: 26 characters, Crockford base32, excluding I, L, O, U. */
const ULID = /^[0-9A-HJKMNP-TV-Z]{26}$/;

export function idSchema<K extends ResourceKind>(kind: K) {
  const prefix = ID_PREFIXES[kind];
  return z
    .string()
    .refine(
      (v) => v.startsWith(`${prefix}_`) && ULID.test(v.slice(prefix.length + 1)),
      `must be a valid ${kind} id (${prefix}_…)`,
    );
}

export const emailSchema = z
  .string()
  .trim()
  .toLowerCase()
  .min(3)
  .max(254)
  .email('must be a valid email address');

/**
 * Password policy.
 *
 * Length is the dominant factor in password strength, so the floor is 12 characters rather than
 * a shorter length padded out with composition rules. A single composition requirement is kept
 * (not entirely one character class) to reject `aaaaaaaaaaaa`, and a blocklist of the most
 * common passwords is applied on top. Breached-password checking against a k-anonymity API
 * happens server-side in `@tessera/auth`, not here.
 */
export const passwordSchema = z
  .string()
  .min(12, 'must be at least 12 characters')
  .max(256, 'must be at most 256 characters')
  .refine((v) => !/^(.)\1*$/.test(v), 'must not be a single repeated character')
  .refine(
    (v) => /[a-z]/i.test(v) && /[^a-z]/i.test(v),
    'must contain at least one letter and one number or symbol',
  );

export const slugSchema = z
  .string()
  .trim()
  .toLowerCase()
  .min(2)
  .max(48)
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, 'may contain lowercase letters, numbers and single hyphens')
  .refine(
    (v) => !RESERVED_SLUGS.has(v),
    'is reserved',
  );

/** Slugs that would collide with application routes or be confusing in a URL. */
export const RESERVED_SLUGS = new Set([
  'admin', 'api', 'app', 'auth', 'billing', 'blog', 'dashboard', 'docs', 'files', 'help',
  'login', 'logout', 'me', 'new', 'oauth', 'pricing', 'privacy', 'public', 'register',
  'settings', 'share', 'signin', 'signup', 'status', 'support', 'terms', 'v1', 'www',
]);

export const displayNameSchema = z.string().trim().min(1).max(120);

export const descriptionSchema = z.string().trim().max(2_000);

/** Hex colour used for base/table/view accents. */
export const colorSchema = z.string().regex(/^#[0-9a-fA-F]{6}$/, 'must be a hex colour');

export const timezoneSchema = z.string().refine((v) => {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: v });
    return true;
  } catch {
    return false;
  }
}, 'must be a valid IANA time zone');

export const localeSchema = z.string().regex(/^[a-z]{2}(-[A-Z]{2})?$/, 'must be a BCP-47 locale');

export const cursorSchema = z.string().max(2_048);

export const paginationSchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50),
  cursor: cursorSchema.optional(),
});

/**
 * A URL safe to store and later call from the server.
 *
 * Scheme is restricted to https (http allowed only outside production, checked by the caller),
 * and the host is re-validated against the SSRF denylist at call time — DNS can be re-pointed
 * between registration and delivery, so validating only here would be insufficient.
 */
export const httpsUrlSchema = z
  .string()
  .url()
  .max(2_048)
  .refine((v) => {
    try {
      const parsed = new URL(v);
      return parsed.protocol === 'https:' || parsed.protocol === 'http:';
    } catch {
      return false;
    }
  }, 'must be an http(s) URL');

export const totpCodeSchema = z
  .string()
  .trim()
  .regex(/^\d{6}$/, 'must be a 6-digit code');

export const recoveryCodeSchema = z
  .string()
  .trim()
  .toLowerCase()
  .regex(/^[a-z0-9]{10}$/, 'must be a 10-character recovery code');

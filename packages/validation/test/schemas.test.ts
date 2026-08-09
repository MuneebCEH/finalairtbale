import { describe, expect, it } from 'vitest';

import { changePasswordSchema, loginSchema, passwordSchema, registerSchema, slugSchema } from '../src';

/**
 * These tests exist because validation is the mass-assignment boundary. If `.strict()` is ever
 * dropped from one of these schemas, a client can inject fields the handler will happily persist.
 */
describe('registration', () => {
  const valid = {
    email: 'Person@Example.COM',
    password: 'correct horse battery',
    name: 'Person Example',
    acceptedTerms: true as const,
  };

  it('normalises the email to lowercase', () => {
    const parsed = registerSchema.parse(valid);
    expect(parsed.email).toBe('person@example.com');
  });

  it('rejects unknown properties rather than ignoring them', () => {
    // The attack this blocks: `{ …, role: 'owner', isPlatformAdmin: true }`.
    const result = registerSchema.safeParse({ ...valid, role: 'owner', isPlatformAdmin: true });
    expect(result.success).toBe(false);
  });

  it('requires the terms to be accepted', () => {
    expect(registerSchema.safeParse({ ...valid, acceptedTerms: false }).success).toBe(false);
  });
});

describe('password policy', () => {
  it('accepts a long passphrase of ordinary words', () => {
    // Length beats composition. A policy that rejects this and accepts "P@ssw0rd!" is worse
    // than no policy.
    expect(passwordSchema.safeParse('correct horse battery staple').success).toBe(true);
  });

  it('rejects anything under twelve characters', () => {
    expect(passwordSchema.safeParse('Sh0rt!pass').success).toBe(false);
  });

  it('rejects a single repeated character', () => {
    expect(passwordSchema.safeParse('aaaaaaaaaaaaaaaa').success).toBe(false);
  });

  it('requires the new password to differ from the current one', () => {
    const result = changePasswordSchema.safeParse({
      currentPassword: 'correct horse battery',
      newPassword: 'correct horse battery',
    });
    expect(result.success).toBe(false);
  });
});

describe('slugs', () => {
  it('accepts hyphenated lowercase', () => {
    expect(slugSchema.safeParse('northwind-operations').success).toBe(true);
  });

  it.each(['admin', 'api', 'settings', 'v1'])('rejects the reserved slug %s', (slug) => {
    expect(slugSchema.safeParse(slug).success).toBe(false);
  });

  it.each(['Has Spaces', 'trailing-', '-leading', 'double--hyphen'])(
    'rejects the malformed slug %s',
    (slug) => {
      expect(slugSchema.safeParse(slug).success).toBe(false);
    },
  );

  it('normalises case rather than rejecting it', () => {
    // Casing is not a mistake the user should be scolded for; it is one the schema can simply
    // fix. Rejection is reserved for input that has no unambiguous correct interpretation.
    expect(slugSchema.parse('Northwind-Operations')).toBe('northwind-operations');
  });
});

describe('login', () => {
  it('does not apply the password policy to sign-in', () => {
    // An existing account may hold a password created under an older policy. Enforcing the
    // current policy at sign-in would lock those users out of their own accounts.
    expect(loginSchema.safeParse({ email: 'a@b.test', password: 'old' }).success).toBe(true);
  });
});

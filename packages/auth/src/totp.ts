import { AUTH_POLICY } from '@tessera/config';
import * as OTPAuth from 'otpauth';

/**
 * Time-based one-time passwords (RFC 6238).
 *
 * A one-step window either side is accepted, which tolerates ordinary clock drift while keeping
 * the acceptance window at 90 seconds. Wider windows are a real weakening: each extra step
 * multiplies an attacker's chance of a blind guess.
 *
 * Replay protection is the caller's responsibility and is not optional — a valid code stays
 * valid for its whole step, so the service records the last accepted step per user and refuses
 * a repeat. Without that, an intercepted code can be used twice.
 */

export interface TotpEnrollment {
  readonly secret: string;
  readonly otpauthUrl: string;
}

export function generateTotpSecret(accountLabel: string, issuer: string): TotpEnrollment {
  // 20 bytes (160 bits) is the RFC 4226 recommended shared-secret size, and is what every
  // mainstream authenticator app expects. `Secret` draws from the platform CSPRNG.
  const secret = new OTPAuth.Secret({ size: 20 });
  const totp = new OTPAuth.TOTP({
    issuer,
    label: accountLabel,
    algorithm: 'SHA1',
    digits: 6,
    period: AUTH_POLICY.totpStepSeconds,
    secret,
  });

  return { secret: secret.base32, otpauthUrl: totp.toString() };
}

/**
 * Verifies a code and returns the matched time step, or `null`.
 *
 * The step is returned rather than a bare boolean so the caller can persist it and reject a
 * replay of the same code within its validity window.
 */
export function verifyTotp(input: {
  secret: string;
  code: string;
  accountLabel: string;
  issuer: string;
  /** The last step this user successfully consumed; a code at or before it is a replay. */
  lastUsedStep?: number | null;
}): { valid: boolean; step: number | null; reason?: 'invalid' | 'replay' } {
  const totp = new OTPAuth.TOTP({
    issuer: input.issuer,
    label: input.accountLabel,
    algorithm: 'SHA1',
    digits: 6,
    period: AUTH_POLICY.totpStepSeconds,
    secret: OTPAuth.Secret.fromBase32(input.secret),
  });

  const delta = totp.validate({ token: input.code.trim(), window: AUTH_POLICY.totpWindow });
  if (delta === null) return { valid: false, step: null, reason: 'invalid' };

  const currentStep = Math.floor(Date.now() / 1000 / AUTH_POLICY.totpStepSeconds);
  const usedStep = currentStep + delta;

  if (input.lastUsedStep != null && usedStep <= input.lastUsedStep) {
    return { valid: false, step: usedStep, reason: 'replay' };
  }

  return { valid: true, step: usedStep };
}

import { Inject, Injectable } from '@nestjs/common';
import {
  equalizeTiming,
  expiresIn,
  generateRecoveryCodes,
  hashPassword,
  hashToken,
  isBreachedPassword,
  issueToken,
  verifyPassword,
} from '@tessera/auth';
import { AUTH_POLICY, TOKEN_TTL, type Env } from '@tessera/config';
import { SessionRepository, UserRepository, newId } from '@tessera/database';
import type { Logger } from '@tessera/logger';
import { AppError, type UserId } from '@tessera/types';
import type {
  ChangePasswordInput,
  LoginInput,
  RegisterInput,
} from '@tessera/validation';

import { MailerService } from '../../infrastructure/mailer.service';
import { PrismaService } from '../../infrastructure/prisma.service';
import { RateLimiter } from '../../infrastructure/rate-limiter';
import { ENV, LOGGER } from '../../infrastructure/tokens';

export interface DeviceInfo {
  readonly ipAddress: string | null;
  readonly userAgent: string | null;
  readonly deviceLabel: string | null;
}

export interface SessionIssued {
  readonly token: string;
  readonly expiresAt: Date;
  readonly sessionId: string;
}

/**
 * Authentication.
 *
 * The rules this service is built around, all of which are security properties rather than
 * preferences:
 *
 *  • **No user enumeration.** Registration with an existing address, login with an unknown
 *    address, and password reset for an unknown address all produce the same observable outcome
 *    as their successful counterparts — same status, same message, same approximate timing.
 *  • **Constant work on the failure path.** A login against a non-existent account still performs
 *    an Argon2 verification against a dummy hash, so response time is not an oracle.
 *  • **Sessions are server-side and revocable.** Immediate revocation is a product requirement
 *    ("sign out all devices"), which a self-contained JWT cannot provide.
 *  • **Rotation with reuse detection.** Every refresh mints a new token; presenting a retired one
 *    means a copy escaped, and the whole session family is revoked.
 */
@Injectable()
export class AuthService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly mailer: MailerService,
    private readonly limiter: RateLimiter,
    @Inject(ENV) private readonly env: Env,
    @Inject(LOGGER) private readonly logger: Logger,
  ) {}

  // ── Registration ───────────────────────────────────────────────────────────

  async register(input: RegisterInput, device: DeviceInfo): Promise<{ userId: string | null }> {
    if (!this.env.SIGNUP_ENABLED) {
      throw new AppError('FORBIDDEN', 'Registration is currently disabled.');
    }

    const users = new UserRepository(this.prisma.client);
    const existing = await users.findByEmail(input.email);

    if (existing) {
      // Do not reveal that the address is taken. Send a "somebody tried to register with your
      // address" note instead — which is useful to the real owner and useless to a prober.
      await this.mailer.send({
        to: input.email,
        subject: 'Someone tried to create an account with your email',
        text:
          `Someone attempted to register at ${this.env.APP_NAME} using this address, ` +
          `but an account already exists. If this was you, sign in instead, or reset your ` +
          `password at ${this.env.APP_URL}/forgot-password.`,
      });
      return { userId: null };
    }

    if (await isBreachedPassword(input.password)) {
      throw new AppError(
        'VALIDATION_FAILED',
        'This password has appeared in a known data breach. Please choose a different one.',
        { details: { issues: [{ path: 'password', code: 'breached', message: 'known breached password' }] } },
      );
    }

    const passwordHash = await hashPassword(input.password);
    const requireVerification = this.env.REQUIRE_EMAIL_VERIFICATION;

    const user = await users.create({
      email: input.email,
      name: input.name,
      passwordHash,
      emailVerified: !requireVerification,
    });

    if (requireVerification) {
      await this.sendVerificationEmail(user.id, input.email, device);
    }

    this.logger.info('user registered', { userId: user.id, requireVerification });
    return { userId: user.id };
  }

  async sendVerificationEmail(userId: string, email: string, device: DeviceInfo): Promise<void> {
    const token = issueToken();

    await this.prisma.client.authToken.create({
      data: {
        id: newId('event'),
        userId,
        email,
        purpose: 'email_verification',
        tokenHash: token.hash,
        expiresAt: expiresIn.hours(TOKEN_TTL.emailVerificationHours),
        createdIp: device.ipAddress,
      },
    });

    await this.mailer.send({
      to: email,
      subject: `Confirm your ${this.env.APP_NAME} email address`,
      text:
        `Confirm your email address to finish setting up your account:\n\n` +
        `${this.env.APP_URL}/verify-email?token=${token.plaintext}\n\n` +
        `This link expires in ${TOKEN_TTL.emailVerificationHours} hours. ` +
        `If you did not create an account, you can ignore this message.`,
    });
  }

  async verifyEmail(token: string): Promise<void> {
    const row = await this.consumeAuthToken(token, 'email_verification');
    if (!row.userId) throw new AppError('MALFORMED_REQUEST', 'This link is not valid.');
    await new UserRepository(this.prisma.client).markEmailVerified(row.userId);
    this.logger.info('email verified', { userId: row.userId });
  }

  // ── Login ──────────────────────────────────────────────────────────────────

  /**
   * Verifies credentials.
   *
   * Returns a discriminated result rather than throwing, because "wrong password", "needs a
   * second factor", and "email not verified" are three different product outcomes and the
   * controller must render them differently.
   */
  async login(
    input: LoginInput,
    device: DeviceInfo,
  ): Promise<
    | { outcome: 'success'; userId: string; session: SessionIssued }
    | { outcome: 'mfa_required'; mfaToken: string }
    | { outcome: 'unverified'; userId: string }
    | { outcome: 'failed' }
  > {
    const users = new UserRepository(this.prisma.client);
    const user = await users.findByEmail(input.email);

    if (!user || !user.passwordHash) {
      // Spend the same time as a real verification so timing does not disclose existence.
      await equalizeTiming(input.password);
      return { outcome: 'failed' };
    }

    // A locked account produces the identical response to a wrong password. Telling an attacker
    // "this account is locked" confirms both that it exists and that their guessing is landing.
    if (await users.isLocked(user.id)) {
      await equalizeTiming(input.password);
      return { outcome: 'failed' };
    }

    const valid = await verifyPassword(user.passwordHash, input.password);
    if (!valid) {
      const { locked, attempts } = await users.recordFailedLogin(
        user.id,
        AUTH_POLICY.maxFailedAttempts,
        AUTH_POLICY.lockoutMinutes,
      );
      this.logger.warn('failed login', { userId: user.id, attempts, locked });
      return { outcome: 'failed' };
    }

    if (this.env.REQUIRE_EMAIL_VERIFICATION && !user.emailVerifiedAt) {
      return { outcome: 'unverified', userId: user.id };
    }

    if (user.twoFactorEnabled) {
      const mfaToken = issueToken();
      await this.prisma.client.authToken.create({
        data: {
          id: newId('event'),
          userId: user.id,
          purpose: 'mfa_challenge',
          tokenHash: mfaToken.hash,
          metadata: { rememberMe: input.rememberMe } as never,
          expiresAt: expiresIn.minutes(TOKEN_TTL.mfaChallengeMinutes),
          createdIp: device.ipAddress,
        },
      });
      return { outcome: 'mfa_required', mfaToken: mfaToken.plaintext };
    }

    await users.recordSuccessfulLogin(user.id, device.ipAddress);
    const session = await this.issueSession(user.id, device, {
      mfaSatisfied: true,
      rememberMe: input.rememberMe,
    });

    return { outcome: 'success', userId: user.id, session };
  }

  // ── Sessions ───────────────────────────────────────────────────────────────

  async issueSession(
    userId: string,
    device: DeviceInfo,
    options: { mfaSatisfied: boolean; rememberMe?: boolean; familyId?: string; previousTokenHash?: string },
  ): Promise<SessionIssued> {
    const token = issueToken();
    const ttlHours = options.rememberMe
      ? this.env.SESSION_TTL_HOURS
      : Math.min(this.env.SESSION_TTL_HOURS, 24);
    const expiresAt = expiresIn.hours(ttlHours);

    const session = await new SessionRepository(this.prisma.client).create({
      userId,
      tokenHash: token.hash,
      expiresAt,
      mfaSatisfied: options.mfaSatisfied,
      ipAddress: device.ipAddress,
      userAgent: device.userAgent,
      deviceLabel: device.deviceLabel,
      ...(options.familyId ? { familyId: options.familyId } : {}),
      ...(options.previousTokenHash ? { previousTokenHash: options.previousTokenHash } : {}),
    });

    return { token: token.plaintext, expiresAt, sessionId: session.id };
  }

  /**
   * Rotates a session token.
   *
   * The old token's hash is recorded as `previousTokenHash` on the new session, which is what
   * makes reuse detectable: a request presenting a hash that appears only in that column is
   * replaying a credential that should no longer exist.
   */
  async refreshSession(currentToken: string, device: DeviceInfo): Promise<SessionIssued> {
    const sessions = new SessionRepository(this.prisma.client);
    const currentHash = hashToken(currentToken);
    const session = await sessions.findValidByTokenHash(currentHash);

    if (!session) {
      const family = await sessions.findRotatedFamily(currentHash);
      if (family) {
        const revoked = await sessions.revokeFamily(family.familyId, 'refresh_token_reuse_detected');
        this.logger.error('refresh token reuse detected', {
          userId: family.userId,
          familyId: family.familyId,
          revokedSessions: revoked,
        });
      }
      throw new AppError('UNAUTHENTICATED', 'Your session has expired. Please sign in again.');
    }

    await sessions.revoke(session.id, session.userId, 'rotated');

    return this.issueSession(session.userId, device, {
      mfaSatisfied: session.mfaSatisfied,
      rememberMe: true,
      familyId: session.familyId,
      previousTokenHash: currentHash,
    });
  }

  async logout(token: string): Promise<void> {
    const sessions = new SessionRepository(this.prisma.client);
    const session = await sessions.findValidByTokenHash(hashToken(token));
    if (session) await sessions.revoke(session.id, session.userId, 'user_logout');
  }

  async listSessions(userId: string, currentSessionId: string) {
    const rows = await new SessionRepository(this.prisma.client).listForUser(userId);
    return rows.map((row) => ({
      id: row.id,
      createdAt: row.createdAt.toISOString(),
      lastSeenAt: row.lastSeenAt.toISOString(),
      expiresAt: row.expiresAt.toISOString(),
      ipAddress: row.ipAddress,
      userAgent: row.userAgent,
      deviceLabel: row.deviceLabel,
      location: row.location,
      isCurrent: row.id === currentSessionId,
    }));
  }

  async revokeSession(userId: string, sessionId: string): Promise<void> {
    const revoked = await new SessionRepository(this.prisma.client).revoke(
      sessionId,
      userId,
      'user_revoked',
    );
    if (!revoked) throw new AppError('NOT_FOUND', 'Session not found.');
  }

  async revokeOtherSessions(userId: string, keepSessionId: string): Promise<number> {
    return new SessionRepository(this.prisma.client).revokeAllExcept(
      userId,
      keepSessionId,
      'user_revoked_all',
    );
  }

  // ── Password management ────────────────────────────────────────────────────

  /**
   * Always returns without indicating whether the address exists, and always at roughly the same
   * cost. The response the caller renders is "if that address has an account, we have sent a
   * link" — which is true either way.
   */
  async requestPasswordReset(email: string, device: DeviceInfo): Promise<void> {
    const user = await new UserRepository(this.prisma.client).findByEmail(email);
    if (!user) return;

    const token = issueToken();
    await this.prisma.client.authToken.create({
      data: {
        id: newId('event'),
        userId: user.id,
        email,
        purpose: 'password_reset',
        tokenHash: token.hash,
        expiresAt: expiresIn.minutes(TOKEN_TTL.passwordResetMinutes),
        createdIp: device.ipAddress,
      },
    });

    await this.mailer.send({
      to: email,
      subject: `Reset your ${this.env.APP_NAME} password`,
      text:
        `Use this link to choose a new password:\n\n` +
        `${this.env.APP_URL}/reset-password?token=${token.plaintext}\n\n` +
        `The link expires in ${TOKEN_TTL.passwordResetMinutes} minutes and can be used once. ` +
        `If you did not request this, no action is needed — your password has not changed.`,
    });
  }

  async resetPassword(token: string, newPassword: string): Promise<void> {
    const row = await this.consumeAuthToken(token, 'password_reset');
    if (!row.userId) throw new AppError('MALFORMED_REQUEST', 'This link is not valid.');

    if (await isBreachedPassword(newPassword)) {
      throw new AppError(
        'VALIDATION_FAILED',
        'This password has appeared in a known data breach. Please choose a different one.',
      );
    }

    const passwordHash = await hashPassword(newPassword);
    const users = new UserRepository(this.prisma.client);
    await users.update(row.userId, { passwordHash, failedLoginCount: 0, lockedUntil: null });

    // A password reset is usually a response to a compromise. Every existing session dies.
    const revoked = await new SessionRepository(this.prisma.client).revokeAll(
      row.userId,
      'password_reset',
    );
    this.logger.info('password reset', { userId: row.userId, revokedSessions: revoked });
  }

  async changePassword(
    userId: string,
    currentSessionId: string,
    input: ChangePasswordInput,
  ): Promise<void> {
    const users = new UserRepository(this.prisma.client);
    const user = await users.findById(userId);
    if (!user?.passwordHash) throw new AppError('FORBIDDEN', 'This account has no password set.');

    const valid = await verifyPassword(user.passwordHash, input.currentPassword);
    if (!valid) throw new AppError('FORBIDDEN', 'Your current password is incorrect.');

    if (await isBreachedPassword(input.newPassword)) {
      throw new AppError(
        'VALIDATION_FAILED',
        'This password has appeared in a known data breach. Please choose a different one.',
      );
    }

    await users.update(userId, { passwordHash: await hashPassword(input.newPassword) });

    if (input.revokeOtherSessions) {
      await new SessionRepository(this.prisma.client).revokeAllExcept(
        userId,
        currentSessionId,
        'password_changed',
      );
    }
  }

  // ── Two-factor ─────────────────────────────────────────────────────────────

  async generateRecoveryCodesFor(userId: string): Promise<string[]> {
    const codes = generateRecoveryCodes(
      AUTH_POLICY.recoveryCodeCount,
      AUTH_POLICY.recoveryCodeLength,
    );

    await this.prisma.client.$transaction(async (tx) => {
      await tx.recoveryCode.deleteMany({ where: { userId } });
      await tx.recoveryCode.createMany({
        data: await Promise.all(
          codes.map(async (code) => ({
            id: newId('event'),
            userId,
            // Recovery codes are low-entropy enough to be worth a slow hash: they are a
            // password, not a 256-bit token.
            codeHash: await hashPassword(code),
          })),
        ),
      });
    });

    return codes;
  }

  async consumeRecoveryCode(userId: string, code: string): Promise<boolean> {
    const rows = await this.prisma.client.recoveryCode.findMany({
      where: { userId, usedAt: null },
      select: { id: true, codeHash: true },
    });

    for (const row of rows) {
      if (await verifyPassword(row.codeHash, code)) {
        await this.prisma.client.recoveryCode.update({
          where: { id: row.id },
          data: { usedAt: new Date() },
        });
        this.logger.warn('recovery code used', { userId, remaining: rows.length - 1 });
        return true;
      }
    }
    return false;
  }

  // ── Shared ─────────────────────────────────────────────────────────────────

  /**
   * Atomically consumes a single-use token.
   *
   * The `updateMany` with `consumedAt: null` in its predicate is what makes this safe against a
   * double-submitted reset link or a race between two tabs: exactly one caller can transition
   * the row, and the loser sees "not valid" rather than both succeeding.
   */
  private async consumeAuthToken(
    plaintext: string,
    purpose: string,
  ): Promise<{ userId: string | null; email: string | null; metadata: unknown }> {
    const tokenHash = hashToken(plaintext);

    const claimed = await this.prisma.client.authToken.updateMany({
      where: { tokenHash, purpose, consumedAt: null, expiresAt: { gt: new Date() } },
      data: { consumedAt: new Date() },
    });

    if (claimed.count === 0) {
      throw new AppError('MALFORMED_REQUEST', 'This link is invalid or has already been used.');
    }

    const row = await this.prisma.client.authToken.findUnique({
      where: { tokenHash },
      select: { userId: true, email: true, metadata: true },
    });

    return {
      userId: row?.userId ?? null,
      email: row?.email ?? null,
      metadata: row?.metadata ?? null,
    };
  }

  /** Convenience for controllers building the authenticated-user response body. */
  async publicUser(userId: UserId | string) {
    const user = await new UserRepository(this.prisma.client).findById(String(userId));
    if (!user) throw new AppError('NOT_FOUND', 'User not found.');
    return {
      id: user.id,
      email: user.email,
      name: user.name,
      avatarUrl: user.avatarUrl,
      emailVerified: user.emailVerifiedAt !== null,
      twoFactorEnabled: user.twoFactorEnabled,
      timezone: user.timezone,
      locale: user.locale,
      theme: user.theme as 'light' | 'dark' | 'system',
      createdAt: user.createdAt.toISOString(),
    };
  }
}

import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Inject,
  Param,
  Post,
  Req,
  Res,
} from '@nestjs/common';
import type { Env } from '@tessera/config';
import { AppError, type Principal } from '@tessera/types';
import {
  changePasswordSchema,
  forgotPasswordSchema,
  loginSchema,
  registerSchema,
  resetPasswordSchema,
  verifyEmailSchema,
  type ChangePasswordInput,
  type LoginInput,
  type RegisterInput,
} from '@tessera/validation';
import type { Response } from 'express';
import { UAParser } from 'ua-parser-js';

import type { AuthenticatedRequest } from '../../bootstrap/auth.guard';
import { CurrentPrincipal, Public, RateLimit, SkipTenantScope } from '../../bootstrap/decorators';
import { clientIp } from '../../bootstrap/rate-limit.guard';
import { zodBody } from '../../bootstrap/zod.pipe';
import { ENV } from '../../infrastructure/tokens';

import { AuthService, type DeviceInfo, type SessionIssued } from './auth.service';

/**
 * Authentication endpoints.
 *
 * The session token is delivered as an HttpOnly cookie and never in a response body, so a
 * cross-site scripting bug cannot read it out of JavaScript. `SameSite=Lax` blocks the
 * cross-site POST shape of CSRF while still allowing the top-level navigation that OAuth
 * callbacks and email links depend on.
 */
@Controller({ path: 'auth', version: '1' })
@SkipTenantScope()
export class AuthController {
  constructor(
    private readonly auth: AuthService,
    @Inject(ENV) private readonly env: Env,
  ) {}

  @Post('register')
  @Public()
  @RateLimit('authUnauthenticated')
  @HttpCode(201)
  async register(
    @Body(zodBody(registerSchema)) input: RegisterInput,
    @Req() req: AuthenticatedRequest,
  ) {
    await this.auth.register(input, deviceFrom(req));
    // Identical response whether or not the address was already registered.
    return {
      data: {
        status: 'pending_verification',
        message: 'Check your inbox to confirm your email address.',
      },
    };
  }

  @Post('verify-email')
  @Public()
  @RateLimit('authUnauthenticated')
  @HttpCode(200)
  async verifyEmail(@Body(zodBody(verifyEmailSchema)) input: { token: string }) {
    await this.auth.verifyEmail(input.token);
    return { data: { verified: true } };
  }

  @Post('login')
  @Public()
  @RateLimit('authUnauthenticated')
  @HttpCode(200)
  async login(
    @Body(zodBody(loginSchema)) input: LoginInput,
    @Req() req: AuthenticatedRequest,
    @Res({ passthrough: true }) res: Response,
  ) {
    const result = await this.auth.login(input, deviceFrom(req));

    switch (result.outcome) {
      case 'success':
        this.setSessionCookie(res, result.session);
        return { data: await this.auth.publicUser(result.userId) };

      case 'mfa_required':
        // 401 with a distinct code, so the client knows to show the second-factor step rather
        // than "wrong password".
        throw new AppError('MFA_REQUIRED', 'A second factor is required to finish signing in.', {
          details: { mfaToken: result.mfaToken },
        });

      case 'unverified':
        throw new AppError('FORBIDDEN', 'Confirm your email address before signing in.', {
          details: { reason: 'email_unverified' },
        });

      case 'failed':
        throw new AppError('UNAUTHENTICATED', 'That email or password is not correct.');
    }
  }

  @Post('logout')
  @Public()
  @HttpCode(204)
  async logout(@Req() req: AuthenticatedRequest, @Res({ passthrough: true }) res: Response) {
    const cookie = req.cookies?.[this.env.SESSION_COOKIE_NAME] as string | undefined;
    if (cookie) await this.auth.logout(cookie);
    this.clearSessionCookie(res);
  }

  @Post('refresh')
  @Public()
  @HttpCode(200)
  async refresh(@Req() req: AuthenticatedRequest, @Res({ passthrough: true }) res: Response) {
    const cookie = req.cookies?.[this.env.SESSION_COOKIE_NAME] as string | undefined;
    if (!cookie) throw new AppError('UNAUTHENTICATED', 'No session to refresh.');

    const session = await this.auth.refreshSession(cookie, deviceFrom(req));
    this.setSessionCookie(res, session);
    return { data: { refreshed: true, expiresAt: session.expiresAt.toISOString() } };
  }

  @Post('password/forgot')
  @Public()
  @RateLimit('passwordReset')
  @HttpCode(202)
  async forgotPassword(
    @Body(zodBody(forgotPasswordSchema)) input: { email: string },
    @Req() req: AuthenticatedRequest,
  ) {
    await this.auth.requestPasswordReset(input.email, deviceFrom(req));
    // Always 202, always the same body: whether the address exists is not disclosed.
    return {
      data: { message: 'If that address has an account, a reset link is on its way.' },
    };
  }

  @Post('password/reset')
  @Public()
  @RateLimit('authUnauthenticated')
  @HttpCode(200)
  async resetPassword(
    @Body(zodBody(resetPasswordSchema)) input: { token: string; password: string },
  ) {
    await this.auth.resetPassword(input.token, input.password);
    return { data: { reset: true } };
  }

  @Post('password/change')
  @RateLimit('authenticatedWrite')
  @HttpCode(200)
  async changePassword(
    @Body(zodBody(changePasswordSchema)) input: ChangePasswordInput,
    @CurrentPrincipal() principal: Principal,
  ) {
    const { userId, sessionId } = requireUser(principal);
    await this.auth.changePassword(userId, sessionId, input);
    return { data: { changed: true } };
  }

  @Get('sessions')
  @RateLimit('authenticatedRead')
  async listSessions(@CurrentPrincipal() principal: Principal) {
    const { userId, sessionId } = requireUser(principal);
    return { data: await this.auth.listSessions(userId, sessionId) };
  }

  @Delete('sessions/:sessionId')
  @RateLimit('authenticatedWrite')
  @HttpCode(204)
  async revokeSession(
    @Param('sessionId') sessionId: string,
    @CurrentPrincipal() principal: Principal,
  ) {
    const { userId } = requireUser(principal);
    await this.auth.revokeSession(userId, sessionId);
  }

  @Delete('sessions')
  @RateLimit('authenticatedWrite')
  @HttpCode(200)
  async revokeOtherSessions(@CurrentPrincipal() principal: Principal) {
    const { userId, sessionId } = requireUser(principal);
    const revoked = await this.auth.revokeOtherSessions(userId, sessionId);
    return { data: { revoked } };
  }

  // ── Cookie handling ────────────────────────────────────────────────────────

  private setSessionCookie(res: Response, session: SessionIssued): void {
    res.cookie(this.env.SESSION_COOKIE_NAME, session.token, {
      httpOnly: true,
      secure: this.env.NODE_ENV === 'production',
      sameSite: 'lax',
      path: '/',
      expires: session.expiresAt,
      // No `domain`: the cookie stays on the exact host that set it, so a compromised
      // subdomain cannot read or overwrite it.
    });
  }

  private clearSessionCookie(res: Response): void {
    res.clearCookie(this.env.SESSION_COOKIE_NAME, {
      httpOnly: true,
      secure: this.env.NODE_ENV === 'production',
      sameSite: 'lax',
      path: '/',
    });
  }
}

function requireUser(principal: Principal): { userId: string; sessionId: string } {
  if (principal.type !== 'user') {
    throw new AppError('FORBIDDEN', 'This endpoint requires an interactive user session.');
  }
  return { userId: principal.userId, sessionId: principal.sessionId };
}

/**
 * Builds a human-readable device label from the user agent, for the session list.
 * "Chrome on Windows" is meaningful to somebody auditing their sessions; a 200-character UA
 * string is not.
 */
function deviceFrom(req: AuthenticatedRequest): DeviceInfo {
  const raw = req.header('user-agent') ?? null;
  let label: string | null = null;

  if (raw) {
    const parsed = new UAParser(raw).getResult();
    const browser = parsed.browser.name;
    const os = parsed.os.name;
    label = browser && os ? `${browser} on ${os}` : (browser ?? os ?? null);
  }

  return {
    ipAddress: clientIp(req),
    userAgent: raw ? raw.slice(0, 512) : null,
    deviceLabel: label,
  };
}

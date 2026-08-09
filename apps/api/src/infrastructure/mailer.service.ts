import { Inject, Injectable } from '@nestjs/common';
import type { Env } from '@tessera/config';
import type { Logger } from '@tessera/logger';
import nodemailer, { type Transporter } from 'nodemailer';

import { ENV, LOGGER } from './tokens';

export interface MailMessage {
  readonly to: string;
  readonly subject: string;
  readonly text: string;
  readonly html?: string;
}

/**
 * Outbound mail.
 *
 * A port with swappable drivers rather than a direct SES/SendGrid call, so the provider can be
 * changed without touching a single feature module (docs/11-deployment.md §7).
 *
 * In development the `console` driver writes the message — including the verification link — to
 * the log, so the sign-up flow is testable without any mail infrastructure. `@tessera/config`
 * refuses to start in production with that driver selected, so a mis-set environment cannot
 * silently swallow every password reset.
 */
@Injectable()
export class MailerService {
  private transport: Transporter | null = null;

  constructor(
    @Inject(ENV) private readonly env: Env,
    @Inject(LOGGER) private readonly logger: Logger,
  ) {
    if (this.env.MAIL_DRIVER === 'smtp') {
      this.transport = nodemailer.createTransport({
        host: this.env.SMTP_HOST,
        port: this.env.SMTP_PORT,
        secure: this.env.SMTP_SECURE,
        ...(this.env.SMTP_USER
          ? { auth: { user: this.env.SMTP_USER, pass: this.env.SMTP_PASSWORD } }
          : {}),
      });
    }
  }

  async send(message: MailMessage): Promise<void> {
    if (this.env.MAIL_DRIVER === 'console' || !this.transport) {
      this.logger.info('mail (console driver)', {
        to: message.to,
        subject: message.subject,
        body: message.text,
      });
      return;
    }

    try {
      await this.transport.sendMail({
        from: this.env.MAIL_FROM,
        to: message.to,
        subject: message.subject,
        text: message.text,
        html: message.html,
      });
    } catch (error) {
      // Mail failure must not fail the request that triggered it: a user whose verification
      // email bounces should still have an account, and can request a new link. The failure is
      // logged and — in the worker — retried through the delivery queue.
      this.logger.error('mail delivery failed', { to: message.to, subject: message.subject, error });
    }
  }
}

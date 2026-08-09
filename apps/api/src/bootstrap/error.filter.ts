import {
  Catch,
  HttpException,
  Inject,
  type ArgumentsHost,
  type ExceptionFilter,
} from '@nestjs/common';
import type { Logger } from '@tessera/logger';
import { AppError, type ApiErrorBody, type ErrorCode } from '@tessera/types';
import type { Request, Response } from 'express';

import { LOGGER } from '../infrastructure/tokens';

import type { RequestWithContext } from './request-context.middleware';

/**
 * The single exit point for every error.
 *
 * Two rules, both non-negotiable:
 *
 *  1. **Clients see a code, a message, and a request id.** Never a stack trace, never a SQL
 *     fragment, never an internal identifier. An error message is an attacker's cheapest source
 *     of reconnaissance.
 *  2. **Operators see everything.** The full error, its cause chain, and the request context go
 *     to the log and the error tracker, correlated by the same id the client was given.
 *
 * An error that is not an `AppError` is by definition unanticipated, so it is reported as
 * `INTERNAL_ERROR` and logged at `error` regardless of what it claims about itself.
 */
@Catch()
export class ErrorFilter implements ExceptionFilter {
  constructor(@Inject(LOGGER) private readonly logger: Logger) {}

  catch(exception: unknown, host: ArgumentsHost): void {
    const http = host.switchToHttp();
    const response = http.getResponse<Response>();
    const request = http.getRequest<Request & Partial<RequestWithContext>>();
    const requestId = request.correlationId ?? 'unknown';

    const { status, body, logLevel } = this.translate(exception, requestId);

    if (logLevel === 'error') {
      this.logger.error('request failed', {
        status,
        code: body.error.code,
        method: request.method,
        path: request.path,
        error: exception,
      });
    } else {
      this.logger.warn('request rejected', {
        status,
        code: body.error.code,
        method: request.method,
        path: request.path,
        message: body.error.message,
      });
    }

    // A 429 must carry Retry-After or clients cannot back off correctly.
    if (body.error.code === 'RATE_LIMITED') {
      const retryAfter = (body.error.details?.['retryAfterSeconds'] as number | undefined) ?? 60;
      response.setHeader('Retry-After', String(retryAfter));
    }

    response.status(status).json(body);
  }

  private translate(
    exception: unknown,
    requestId: string,
  ): { status: number; body: ApiErrorBody; logLevel: 'warn' | 'error' } {
    if (exception instanceof AppError) {
      return {
        status: exception.status,
        logLevel: exception.status >= 500 ? 'error' : 'warn',
        body: {
          error: {
            code: exception.code,
            message: exception.message,
            ...(exception.details ? { details: exception.details } : {}),
            requestId,
          },
        },
      };
    }

    // Nest's own exceptions (route not found, method not allowed, payload too large) are mapped
    // onto the platform's code vocabulary rather than leaking Nest's default shape, so clients
    // only ever have to understand one error format.
    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      const code = NEST_STATUS_TO_CODE[status] ?? 'INTERNAL_ERROR';
      return {
        status,
        logLevel: status >= 500 ? 'error' : 'warn',
        body: {
          error: {
            code,
            message: status >= 500 ? 'An unexpected error occurred.' : exception.message,
            requestId,
          },
        },
      };
    }

    return {
      status: 500,
      logLevel: 'error',
      body: {
        error: {
          code: 'INTERNAL_ERROR',
          message: 'An unexpected error occurred.',
          requestId,
        },
      },
    };
  }
}

const NEST_STATUS_TO_CODE: Readonly<Record<number, ErrorCode>> = {
  400: 'MALFORMED_REQUEST',
  401: 'UNAUTHENTICATED',
  403: 'FORBIDDEN',
  404: 'NOT_FOUND',
  405: 'METHOD_NOT_ALLOWED',
  409: 'DUPLICATE_RESOURCE',
  413: 'PAYLOAD_TOO_LARGE',
  422: 'VALIDATION_FAILED',
  429: 'RATE_LIMITED',
  501: 'NOT_IMPLEMENTED',
  503: 'DEPENDENCY_UNAVAILABLE',
};

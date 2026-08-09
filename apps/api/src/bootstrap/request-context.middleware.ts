import { randomUUID } from 'node:crypto';

import { Injectable, type NestMiddleware } from '@nestjs/common';
import { runWithContext } from '@tessera/logger';
import type { NextFunction, Request, Response } from 'express';

/**
 * Establishes the request context for everything downstream.
 *
 * Runs first in the pipeline, before authentication, so that even a request that is rejected at
 * the door carries a correlation id in its logs and its error response. Support conversations
 * start with "what is the request id" — that only works if *every* response has one.
 */
@Injectable()
export class RequestContextMiddleware implements NestMiddleware {
  use(req: Request, res: Response, next: NextFunction): void {
    // Accept an inbound id so a trace spans the browser, the web BFF, and the API — but only
    // when it looks like an id we issued. An unvalidated header lands in log files and would be
    // a log-injection vector.
    const inbound = req.header('x-request-id');
    const correlationId = inbound && /^[A-Za-z0-9_-]{8,64}$/.test(inbound) ? inbound : randomUUID();

    res.setHeader('x-request-id', correlationId);
    (req as RequestWithContext).correlationId = correlationId;

    runWithContext(
      {
        correlationId,
        route: `${req.method} ${req.route?.path ?? req.path}`,
      },
      () => next(),
    );
  }
}

export interface RequestWithContext extends Request {
  correlationId: string;
}

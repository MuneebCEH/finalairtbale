import 'reflect-metadata';

import { VersioningType } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { SECURITY_HEADERS, loadEnv } from '@tessera/config';
import { createLogger } from '@tessera/logger';
import cookieParser from 'cookie-parser';
import helmet from 'helmet';

import { AppModule } from './app.module';
import { RealtimeGateway } from './modules/realtime/realtime.gateway';

/**
 * Teaches `JSON.stringify` how to render a BigInt.
 *
 * Postgres `bigint` columns arrive as JavaScript `BigInt`, and `JSON.stringify` throws a
 * `TypeError` on them rather than degrading — so a single unmapped bigint anywhere in a response
 * turns that endpoint into a 500 with no useful message. Serialising as a string rather than a
 * number is deliberate: values beyond 2^53 lose precision as numbers, and a silently wrong
 * record count is worse than a string the client must parse.
 *
 * Response DTOs still map explicitly; this is the net that stops the next omission being an
 * outage.
 */
(BigInt.prototype as unknown as { toJSON(): string }).toJSON = function toJSON(this: bigint) {
  return this.toString();
};

async function bootstrap(): Promise<void> {
  // Environment first: a bad configuration should stop the process here, before anything binds
  // a port or opens a connection.
  const env = loadEnv();
  const logger = createLogger({
    name: 'tessera-api',
    level: env.LOG_LEVEL,
    pretty: env.NODE_ENV === 'development',
  });

  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    bufferLogs: true,
    // The framework's own console logger is disabled: everything goes through the structured,
    // redacting logger so no code path can bypass secret redaction.
    logger: false,
    // Without this, Nest catches a startup failure in its exception zone and calls
    // `process.exit(1)` itself. Combined with `logger: false` that produces a process which
    // dies with no output whatsoever — the worst possible failure mode to debug. `false` makes
    // `create()` reject instead, so the error reaches the handler below and gets printed.
    abortOnError: false,
  });

  app.enableVersioning({ type: VersioningType.URI, defaultVersion: '1' });

  app.use(cookieParser());

  // `X-Forwarded-For` is only honoured when the deployment is explicitly behind a trusted proxy.
  // Trusting it unconditionally lets any client spoof its own address and defeat rate limiting.
  if (env.TRUST_PROXY) app.set('trust proxy', 1);

  app.use(
    helmet({
      contentSecurityPolicy: {
        directives: {
          defaultSrc: ["'self'"],
          scriptSrc: ["'self'"],
          styleSrc: ["'self'"],
          imgSrc: ["'self'", 'data:'],
          connectSrc: ["'self'"],
          frameAncestors: ["'none'"],
          baseUri: ["'none'"],
          objectSrc: ["'none'"],
          formAction: ["'self'"],
        },
      },
      hsts: env.NODE_ENV === 'production' ? { maxAge: 63_072_000, includeSubDomains: true, preload: true } : false,
      crossOriginEmbedderPolicy: false,
    }),
  );

  app.use((_req: unknown, res: { setHeader(name: string, value: string): void }, next: () => void) => {
    for (const [header, value] of Object.entries(SECURITY_HEADERS)) res.setHeader(header, value);
    next();
  });

  app.enableCors({
    origin: env.CORS_ORIGINS,
    credentials: true,
    methods: ['GET', 'POST', 'PATCH', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: [
      'Content-Type',
      'Authorization',
      'X-Request-Id',
      'Idempotency-Key',
      'If-Match',
    ],
    exposedHeaders: [
      'X-Request-Id',
      'X-RateLimit-Limit',
      'X-RateLimit-Remaining',
      'X-RateLimit-Reset',
      'Retry-After',
      'ETag',
    ],
    maxAge: 86_400,
  });

  // Uploads go direct to object storage with presigned URLs, so the API itself never needs to
  // accept a large body. A small cap here is a cheap denial-of-service defence.
  app.useBodyParser('json', { limit: '2mb' });

  const openapi = new DocumentBuilder()
    .setTitle('Tessera API')
    .setDescription('Collaborative relational workspace platform.')
    .setVersion('1.0.0')
    .addCookieAuth(env.SESSION_COOKIE_NAME)
    .addBearerAuth({ type: 'http', scheme: 'bearer', bearerFormat: 'Personal access token' })
    .build();
  SwaggerModule.setup('v1/docs', app, SwaggerModule.createDocument(app, openapi), {
    jsonDocumentUrl: 'v1/openapi.json',
  });

  // Lets Nest run onModuleDestroy / onApplicationShutdown so in-flight work finishes and pools
  // close cleanly instead of connections being severed mid-query.
  app.enableShutdownHooks();

  await app.listen(env.API_PORT, '0.0.0.0');

  // Attached after listen, because the gateway hooks the HTTP server's `upgrade` event and that
  // server does not exist until Nest has created it. Sharing the port means the WebSocket
  // inherits the TLS termination, load balancer and health checks that are already in place.
  app.get(RealtimeGateway).attach(app.getHttpServer());

  logger.info('api listening', { port: env.API_PORT, env: env.NODE_ENV, realtime: '/realtime' });
}

bootstrap().catch((error: unknown) => {
  // Startup failures predate the logger, so this is the one sanctioned console write.
  // eslint-disable-next-line no-console
  console.error('Failed to start the API:', error);
  process.exit(1);
});

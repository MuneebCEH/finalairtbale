import { existsSync } from 'node:fs';
import { dirname, join, parse } from 'node:path';

import { config as loadDotenvFile } from 'dotenv';
import { z } from 'zod';

/**
 * Environment validation.
 *
 * Two rules drive this file:
 *
 *  1. **Fail at boot, not at 3am.** A missing or malformed variable stops the process during
 *     startup with a message naming every offending key. A service that starts successfully has
 *     a valid configuration, always.
 *  2. **No insecure defaults.** Secrets have no fallback value. In production, weak or
 *     placeholder secrets are rejected outright — a default that "works in dev" is exactly the
 *     kind of thing that reaches production unnoticed.
 */

const nonEmpty = z.string().min(1);

/** Rejects the placeholder values shipped in .env.example so they cannot survive to production. */
const secret = (minLength = 32) =>
  z
    .string()
    .min(minLength, `must be at least ${minLength} characters`)
    .refine((v) => !v.startsWith('CHANGE_ME'), 'must be replaced with a generated value');

const bool = z
  .enum(['true', 'false', '1', '0'])
  .transform((v) => v === 'true' || v === '1');

const int = (min?: number, max?: number) => {
  let schema = z.coerce.number().int();
  if (min !== undefined) schema = schema.min(min);
  if (max !== undefined) schema = schema.max(max);
  return schema;
};

const csv = z
  .string()
  .transform((v) =>
    v
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
  )
  .pipe(z.array(z.string()));

export const envSchema = z
  .object({
    // ── Runtime ──
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    LOG_LEVEL: z.enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal']).default('info'),
    APP_NAME: z.string().default('Tessera'),
    APP_URL: z.string().url(),
    API_URL: z.string().url(),
    API_PORT: int(1, 65535).default(4000),
    WEB_PORT: int(1, 65535).default(3000),
    CORS_ORIGINS: csv.default('http://localhost:3000'),

    // ── Database ──
    DATABASE_URL: nonEmpty.startsWith('postgres'),
    DATABASE_REPLICA_URL: z.string().optional(),
    DATABASE_POOL_SIZE: int(1, 200).default(20),
    DATABASE_STATEMENT_TIMEOUT_MS: int(1000).default(30_000),

    // ── Redis ──
    REDIS_URL: nonEmpty.startsWith('redis'),
    REDIS_QUEUE_URL: nonEmpty.startsWith('redis'),

    // ── Storage ──
    STORAGE_DRIVER: z.enum(['s3', 'gcs', 'azure', 'memory']).default('s3'),
    STORAGE_ENDPOINT: z.string().optional(),
    STORAGE_REGION: z.string().default('us-east-1'),
    STORAGE_BUCKET: nonEmpty,
    STORAGE_ACCESS_KEY_ID: z.string().optional(),
    STORAGE_SECRET_ACCESS_KEY: z.string().optional(),
    STORAGE_FORCE_PATH_STYLE: bool.default('false'),
    STORAGE_PUBLIC_URL: z.string().url(),

    // ── Search ──
    SEARCH_DRIVER: z.enum(['opensearch', 'elasticsearch', 'postgres']).default('postgres'),
    OPENSEARCH_URL: z.string().optional(),
    OPENSEARCH_USERNAME: z.string().optional(),
    OPENSEARCH_PASSWORD: z.string().optional(),

    // ── Security ──
    SESSION_SECRET: secret(),
    JWT_SECRET: secret(),
    ENCRYPTION_KEY: secret(32),
    ENCRYPTION_KEY_VERSION: int(1).default(1),
    SESSION_COOKIE_NAME: z.string().default('tessera_session'),
    SESSION_TTL_HOURS: int(1).default(720),
    SESSION_IDLE_TIMEOUT_HOURS: int(1).default(168),
    ACCESS_TOKEN_TTL_MINUTES: int(1).default(15),
    TRUST_PROXY: bool.default('false'),

    // ── Mail ──
    MAIL_DRIVER: z.enum(['smtp', 'ses', 'sendgrid', 'postmark', 'console']).default('console'),
    MAIL_FROM: z.string().default('Tessera <no-reply@localhost>'),
    SMTP_HOST: z.string().optional(),
    SMTP_PORT: int(1, 65535).optional(),
    SMTP_USER: z.string().optional(),
    SMTP_PASSWORD: z.string().optional(),
    SMTP_SECURE: bool.default('false'),

    // ── OAuth ──
    GOOGLE_CLIENT_ID: z.string().optional(),
    GOOGLE_CLIENT_SECRET: z.string().optional(),
    MICROSOFT_CLIENT_ID: z.string().optional(),
    MICROSOFT_CLIENT_SECRET: z.string().optional(),
    MICROSOFT_TENANT: z.string().default('common'),
    GITHUB_CLIENT_ID: z.string().optional(),
    GITHUB_CLIENT_SECRET: z.string().optional(),

    // ── Billing ──
    STRIPE_SECRET_KEY: z.string().optional(),
    STRIPE_WEBHOOK_SECRET: z.string().optional(),
    STRIPE_PUBLISHABLE_KEY: z.string().optional(),

    // ── Observability ──
    OTEL_EXPORTER_OTLP_ENDPOINT: z.string().optional(),
    OTEL_SERVICE_NAME: z.string().default('tessera'),
    SENTRY_DSN: z.string().optional(),
    METRICS_ENABLED: bool.default('true'),

    // ── Limits / flags ──
    MAX_UPLOAD_BYTES: int(1).default(104_857_600),
    RATE_LIMIT_ENABLED: bool.default('true'),
    SIGNUP_ENABLED: bool.default('true'),
    REQUIRE_EMAIL_VERIFICATION: bool.default('true'),
    ALLOW_UNSAFE_SEED: bool.default('false'),
  })
  .superRefine((env, ctx) => {
    if (env.NODE_ENV !== 'production') return;

    // Production-only invariants. These are the settings that are harmless in development and
    // dangerous in production, so they are checked exactly where it matters.
    const requireInProd: Array<[keyof typeof env, string]> = [
      ['STORAGE_ACCESS_KEY_ID', 'object storage credentials are required in production'],
      ['STORAGE_SECRET_ACCESS_KEY', 'object storage credentials are required in production'],
    ];
    for (const [key, message] of requireInProd) {
      if (!env[key]) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: [key as string], message });
      }
    }

    if (env.MAIL_DRIVER === 'console') {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['MAIL_DRIVER'],
        message: 'the console mail driver silently discards mail and must not be used in production',
      });
    }
    if (env.ALLOW_UNSAFE_SEED) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['ALLOW_UNSAFE_SEED'],
        message: 'must be false in production',
      });
    }
    if (!env.APP_URL.startsWith('https://') || !env.API_URL.startsWith('https://')) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['APP_URL'],
        message: 'APP_URL and API_URL must use https in production',
      });
    }
    if (env.SEARCH_DRIVER !== 'postgres' && !env.OPENSEARCH_URL) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['OPENSEARCH_URL'],
        message: 'required when SEARCH_DRIVER is not "postgres"',
      });
    }
  });

export type Env = z.infer<typeof envSchema>;

export class EnvironmentValidationError extends Error {
  constructor(public readonly issues: z.ZodIssue[]) {
    const lines = issues.map((i) => `  • ${i.path.join('.') || '(root)'}: ${i.message}`);
    super(`Invalid environment configuration:\n${lines.join('\n')}\n`);
    this.name = 'EnvironmentValidationError';
  }
}

/**
 * Parses and caches the environment. Call once during bootstrap; import the result everywhere
 * else. Direct `process.env` access outside this package is forbidden by lint rule.
 */
let cached: Env | null = null;

/**
 * Loads a `.env` file from the nearest ancestor directory that has one.
 *
 * Each app runs with its own working directory (`apps/api`, `apps/worker`), so a plain
 * `dotenv.config()` would look in the wrong place; walking up finds the monorepo root's file from
 * anywhere in the tree.
 *
 * Deliberately skipped in production. There, configuration arrives from the platform's secret
 * store, and silently picking up a stray `.env` that happened to be baked into an image is
 * exactly the accident that leaks a development credential into a live environment. Values
 * already present in `process.env` always win, so a real environment variable is never
 * overwritten by the file.
 */
function loadDotenv(): void {
  if (process.env['NODE_ENV'] === 'production') return;

  let directory = process.cwd();
  const { root } = parse(directory);

  // Bounded rather than `while (true)`: a symlink loop or an unexpected path shape would
  // otherwise hang startup instead of failing, and no real tree is 32 levels deep.
  for (let depth = 0; depth < 32; depth += 1) {
    const candidate = join(directory, '.env');
    if (existsSync(candidate)) {
      loadDotenvFile({ path: candidate, override: false });
      return;
    }
    if (directory === root) return;
    directory = dirname(directory);
  }
}

export function loadEnv(source: NodeJS.ProcessEnv = process.env, force = false): Env {
  if (cached && !force) return cached;

  if (source === process.env) loadDotenv();

  const result = envSchema.safeParse(source);
  if (!result.success) {
    throw new EnvironmentValidationError(result.error.issues);
  }
  cached = result.data;
  return cached;
}

/** Test helper. Never called by application code. */
export function resetEnvCache(): void {
  cached = null;
}

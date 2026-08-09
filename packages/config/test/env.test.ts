import { describe, expect, it } from 'vitest';

import { envSchema, loadEnv } from '../src/env';

/**
 * The environment schema is the last thing standing between a misconfigured deployment and a
 * running one. Its job is to fail loudly at boot rather than quietly at 3am, so what is tested
 * here is mostly what it *refuses*.
 */

/** A configuration that satisfies every non-production requirement. */
const VALID = {
  APP_URL: 'https://app.example.com',
  API_URL: 'https://api.example.com',
  DATABASE_URL: 'postgresql://user:pass@localhost:5432/tessera',
  REDIS_URL: 'redis://localhost:6379',
  REDIS_QUEUE_URL: 'redis://localhost:6379/1',
  STORAGE_BUCKET: 'tessera-attachments',
  STORAGE_PUBLIC_URL: 'https://files.example.com',
  SESSION_SECRET: 's'.repeat(32),
  JWT_SECRET: 'j'.repeat(32),
  ENCRYPTION_KEY: 'e'.repeat(32),
} as const;

const parse = (overrides: Record<string, string> = {}) =>
  envSchema.safeParse({ ...VALID, ...overrides });

/** Production requires a few more things; this is the smallest valid production configuration. */
const PRODUCTION = {
  NODE_ENV: 'production',
  MAIL_DRIVER: 'smtp',
  STORAGE_ACCESS_KEY_ID: 'AKIA_EXAMPLE',
  STORAGE_SECRET_ACCESS_KEY: 'secret-example',
} as const;

const issuePaths = (result: ReturnType<typeof parse>): string[] =>
  result.success ? [] : result.error.issues.map((i) => i.path.join('.'));

describe('envSchema', () => {
  it('accepts a complete development configuration', () => {
    const result = parse();
    expect(issuePaths(result)).toEqual([]);
  });

  it('applies sensible defaults for anything optional', () => {
    const result = parse();
    if (!result.success) throw new Error('expected a valid configuration');

    expect(result.data.NODE_ENV).toBe('development');
    expect(result.data.API_PORT).toBe(4000);
    expect(result.data.SEARCH_DRIVER).toBe('postgres');
    expect(result.data.RATE_LIMIT_ENABLED).toBe(true);
    expect(result.data.CORS_ORIGINS).toEqual(['http://localhost:3000']);
  });

  describe('required values', () => {
    for (const key of Object.keys(VALID)) {
      it(`refuses to start without ${key}`, () => {
        const partial = { ...VALID } as Record<string, string>;
        delete partial[key];
        expect(issuePaths(envSchema.safeParse(partial))).toContain(key);
      });
    }
  });

  describe('secrets', () => {
    it('rejects a secret shorter than 32 characters', () => {
      expect(issuePaths(parse({ SESSION_SECRET: 'short' }))).toContain('SESSION_SECRET');
      expect(issuePaths(parse({ JWT_SECRET: 'x'.repeat(31) }))).toContain('JWT_SECRET');
    });

    it('rejects the placeholder from .env.example', () => {
      // The failure mode this exists for: someone copies .env.example and deploys it.
      const result = parse({ SESSION_SECRET: `CHANGE_ME${'x'.repeat(40)}` });
      expect(issuePaths(result)).toContain('SESSION_SECRET');
    });

    it('requires the encryption key to be exactly the length AES-256 needs', () => {
      expect(issuePaths(parse({ ENCRYPTION_KEY: 'x'.repeat(31) }))).toContain('ENCRYPTION_KEY');
      expect(issuePaths(parse({ ENCRYPTION_KEY: 'x'.repeat(32) }))).not.toContain('ENCRYPTION_KEY');
    });
  });

  describe('connection strings', () => {
    it('rejects a database URL that is not postgres', () => {
      expect(issuePaths(parse({ DATABASE_URL: 'mysql://localhost/db' }))).toContain('DATABASE_URL');
    });

    it('rejects a redis URL that is not redis', () => {
      expect(issuePaths(parse({ REDIS_URL: 'http://localhost:6379' }))).toContain('REDIS_URL');
    });

    it('rejects malformed URLs', () => {
      expect(issuePaths(parse({ APP_URL: 'not a url' }))).toContain('APP_URL');
      expect(issuePaths(parse({ STORAGE_PUBLIC_URL: '/relative' }))).toContain('STORAGE_PUBLIC_URL');
    });
  });

  describe('numbers and booleans', () => {
    it('coerces numeric strings', () => {
      const result = parse({ API_PORT: '8080' });
      expect(result.success && result.data.API_PORT).toBe(8080);
    });

    it('rejects an out-of-range port', () => {
      expect(issuePaths(parse({ API_PORT: '0' }))).toContain('API_PORT');
      expect(issuePaths(parse({ API_PORT: '70000' }))).toContain('API_PORT');
      expect(issuePaths(parse({ API_PORT: 'eighty' }))).toContain('API_PORT');
    });

    it('accepts only unambiguous booleans', () => {
      for (const value of ['true', 'false', '1', '0']) {
        expect(issuePaths(parse({ RATE_LIMIT_ENABLED: value })), value).not.toContain(
          'RATE_LIMIT_ENABLED',
        );
      }
      // "yes"/"on"/"" are the values that make a config file ambiguous; reject them.
      for (const value of ['yes', 'on', '', 'TRUE']) {
        expect(issuePaths(parse({ RATE_LIMIT_ENABLED: value })), value).toContain(
          'RATE_LIMIT_ENABLED',
        );
      }
    });

    it('parses CORS origins into a trimmed list', () => {
      const result = parse({ CORS_ORIGINS: 'https://a.com, https://b.com ,,' });
      expect(result.success && result.data.CORS_ORIGINS).toEqual(['https://a.com', 'https://b.com']);
    });
  });

  describe('production invariants', () => {
    const production = (overrides: Record<string, string> = {}) =>
      parse({ ...PRODUCTION, ...overrides });

    it('accepts a complete production configuration', () => {
      expect(issuePaths(production())).toEqual([]);
    });

    it('demands object storage credentials', () => {
      const result = production({ STORAGE_ACCESS_KEY_ID: '' });
      expect(issuePaths(result)).toContain('STORAGE_ACCESS_KEY_ID');
    });

    it('refuses the console mail driver, which silently discards mail', () => {
      expect(issuePaths(production({ MAIL_DRIVER: 'console' }))).toContain('MAIL_DRIVER');
    });

    it('refuses the unsafe seed flag', () => {
      expect(issuePaths(production({ ALLOW_UNSAFE_SEED: 'true' }))).toContain('ALLOW_UNSAFE_SEED');
    });

    it('refuses plaintext http URLs', () => {
      expect(issuePaths(production({ APP_URL: 'http://app.example.com' }))).toContain('APP_URL');
      expect(issuePaths(production({ API_URL: 'http://api.example.com' }))).toContain('APP_URL');
    });

    it('demands a search URL when the driver is not postgres', () => {
      expect(issuePaths(production({ SEARCH_DRIVER: 'opensearch' }))).toContain('OPENSEARCH_URL');
      expect(
        issuePaths(production({ SEARCH_DRIVER: 'opensearch', OPENSEARCH_URL: 'https://os:9200' })),
      ).toEqual([]);
    });

    it('applies none of these constraints outside production', () => {
      // The same settings that fail above must be fine in development, or nobody can run locally.
      const development = parse({ MAIL_DRIVER: 'console', ALLOW_UNSAFE_SEED: 'true', APP_URL: 'http://localhost:3000' });
      expect(issuePaths(development)).toEqual([]);
    });
  });

  it('reports every problem at once rather than one per restart', () => {
    const result = envSchema.safeParse({ ...VALID, API_PORT: '0', SESSION_SECRET: 'short', DATABASE_URL: 'mysql://x' });
    const paths = issuePaths(result);

    expect(paths).toContain('API_PORT');
    expect(paths).toContain('SESSION_SECRET');
    expect(paths).toContain('DATABASE_URL');
  });
});

describe('the PORT alias', () => {
  /**
   * Passenger — which is what cPanel's Node.js applications run under — and every
   * platform-as-a-service hand the port to the process as `PORT`. Reading only `API_PORT` meant
   * the app ignored the port it had been given and bound its own default, which on a shared host
   * is either already taken or firewalled. The symptom is indistinguishable from a crash at boot.
   */
  it('uses PORT when API_PORT is absent', () => {
    expect(loadEnv({ ...VALID, PORT: '8080' } as NodeJS.ProcessEnv, true).API_PORT).toBe(8080);
  });

  it('prefers an explicit API_PORT over PORT', () => {
    const env = loadEnv({ ...VALID, PORT: '8080', API_PORT: '4000' } as NodeJS.ProcessEnv, true);
    expect(env.API_PORT).toBe(4000);
  });

  it('falls back to the default when neither is set', () => {
    expect(loadEnv({ ...VALID } as NodeJS.ProcessEnv, true).API_PORT).toBe(4000);
  });
});

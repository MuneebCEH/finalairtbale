import { describe, expect, it } from 'vitest';

import { REDACTED, redact } from '../src/redact';

/**
 * Redaction is a security control, so it is tested like one: the cases that matter are the ones
 * where a secret arrives somewhere nobody expected it.
 */
describe('redaction', () => {
  it('removes sensitive keys at any depth', () => {
    const output = redact({
      user: { email: 'a@b.test', password: 'hunter2' },
      request: { headers: { authorization: 'Bearer abc', 'content-type': 'application/json' } },
    }) as Record<string, never>;

    expect(JSON.stringify(output)).not.toContain('hunter2');
    expect(JSON.stringify(output)).not.toContain('Bearer abc');
    // Non-sensitive neighbours survive: over-redaction makes logs useless.
    expect(JSON.stringify(output)).toContain('application/json');
    expect(JSON.stringify(output)).toContain('a@b.test');
  });

  it('matches key names regardless of casing or separators', () => {
    const output = redact({
      API_KEY: 'secret-one',
      'client-secret': 'secret-two',
      refreshToken: 'secret-three',
    }) as Record<string, string>;

    expect(output['API_KEY']).toBe(REDACTED);
    expect(output['client-secret']).toBe(REDACTED);
    expect(output['refreshToken']).toBe(REDACTED);
  });

  it('redacts credential-shaped values under innocuous keys', () => {
    // The case key-based redaction alone misses entirely, and the one that actually leaks in
    // practice: a token pasted into a free-text field, a comment, or an error message.
    const output = redact({
      note: 'the token is tsk_abcdefghijklmnopqrstuvwxyz012345 please rotate it',
      jwt: 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjMifQ.abcdefghijklmnop',
    }) as Record<string, string>;

    expect(output['note']).not.toContain('tsk_abcdefghijklmnopqrstuvwxyz012345');
    expect(output['note']).toContain(REDACTED);
    expect(output['jwt']).toContain(REDACTED);
  });

  it('survives circular references', () => {
    const node: Record<string, unknown> = { name: 'root' };
    node['self'] = node;

    expect(() => redact(node)).not.toThrow();
    expect(JSON.stringify(redact(node))).toContain('circular');
  });

  it('caps depth and array length so logging cannot become a denial of service', () => {
    const deep: Record<string, unknown> = {};
    let cursor = deep;
    for (let i = 0; i < 50; i += 1) {
      cursor['next'] = {};
      cursor = cursor['next'] as Record<string, unknown>;
    }

    expect(JSON.stringify(redact(deep))).toContain('truncated');
    expect(JSON.stringify(redact({ items: Array.from({ length: 5_000 }, (_, i) => i) }))).toContain(
      'more',
    );
  });

  it('keeps an error readable while redacting its message', () => {
    const error = new Error('failed with token tsk_abcdefghijklmnopqrstuvwxyz012345');
    const output = redact({ error }) as { error: { name: string; message: string } };

    expect(output.error.name).toBe('Error');
    expect(output.error.message).toContain(REDACTED);
    expect(output.error.message).toContain('failed with token');
  });
});

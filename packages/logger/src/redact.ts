/**
 * Secret redaction.
 *
 * Two complementary strategies, because either alone is insufficient:
 *
 *  - **Key-based**: any property whose name matches a sensitive key is replaced, at any depth.
 *    Catches `{ user: { password } }` and `{ headers: { authorization } }`.
 *  - **Shape-based**: string *values* that look like credentials are replaced even when the key
 *    is innocuous. Catches `{ note: "the token is tsk_live_..." }`, which key-based redaction
 *    would happily print.
 *
 * Redaction runs at serialisation time, so a secret cannot reach a log sink even if a developer
 * logs an entire request object. See docs/03-security-and-permissions.md §T12.
 */

const SENSITIVE_KEYS = new Set(
  [
    'password',
    'passwordconfirmation',
    'currentpassword',
    'newpassword',
    'passwordhash',
    'token',
    'accesstoken',
    'refreshtoken',
    'idtoken',
    'apikey',
    'apisecret',
    'secret',
    'clientsecret',
    'webhooksecret',
    'sessionsecret',
    'jwtsecret',
    'encryptionkey',
    'privatekey',
    'authorization',
    'cookie',
    'setcookie',
    'proxyauthorization',
    'totpsecret',
    'mfasecret',
    'recoverycodes',
    'creditcard',
    'cardnumber',
    'cvv',
    'ssn',
    'otp',
    'signature',
  ].map((k) => k.toLowerCase()),
);

/** Value shapes that are credentials regardless of the key they appear under. */
const SECRET_VALUE_PATTERNS: readonly RegExp[] = [
  /\bey[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/, // JWT
  /\btsk_[A-Za-z0-9]{16,}\b/, // Tessera personal access token
  /\btsa_[A-Za-z0-9]{16,}\b/, // Tessera OAuth access token
  /\b(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{16,}\b/, // Stripe
  /\bghp_[A-Za-z0-9]{20,}\b/, // GitHub
  /\bAKIA[0-9A-Z]{16}\b/, // AWS access key id
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/,
];

export const REDACTED = '[redacted]';

function isSensitiveKey(key: string): boolean {
  return SENSITIVE_KEYS.has(key.toLowerCase().replace(/[-_\s]/g, ''));
}

function redactString(value: string): string {
  let out = value;
  for (const pattern of SECRET_VALUE_PATTERNS) {
    out = out.replace(new RegExp(pattern.source, pattern.flags.includes('g') ? pattern.flags : `${pattern.flags}g`), REDACTED);
  }
  return out;
}

/**
 * Deep-redacts a value. Cycles are handled; depth is capped so a pathological object cannot
 * turn logging into a denial of service.
 */
export function redact(value: unknown, maxDepth = 8): unknown {
  return redactInternal(value, maxDepth, new WeakSet());
}

function redactInternal(value: unknown, depthLeft: number, seen: WeakSet<object>): unknown {
  if (value === null || value === undefined) return value;
  if (typeof value === 'string') return redactString(value);
  if (typeof value !== 'object') return value;
  if (depthLeft <= 0) return '[truncated]';

  if (seen.has(value as object)) return '[circular]';
  seen.add(value as object);

  if (value instanceof Error) {
    return {
      name: value.name,
      message: redactString(value.message),
      stack: value.stack ? redactString(value.stack) : undefined,
      cause: value.cause ? redactInternal(value.cause, depthLeft - 1, seen) : undefined,
    };
  }

  if (Array.isArray(value)) {
    // Cap array length so a 1M-element payload does not produce a 1M-line log entry.
    const capped = value.length > 100 ? value.slice(0, 100) : value;
    const mapped: unknown[] = capped.map((item) => redactInternal(item, depthLeft - 1, seen));
    if (value.length > 100) mapped.push(`[…${value.length - 100} more]`);
    return mapped;
  }

  if (value instanceof Date) return value.toISOString();
  if (value instanceof Map || value instanceof Set) return `[${value.constructor.name}(${value.size})]`;
  if (Buffer.isBuffer(value)) return `[Buffer(${value.length})]`;

  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    out[key] = isSensitiveKey(key) ? REDACTED : redactInternal(item, depthLeft - 1, seen);
  }
  return out;
}

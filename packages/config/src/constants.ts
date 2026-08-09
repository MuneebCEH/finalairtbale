/** Values that are policy, not configuration — the same in every environment. */

export const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Resource-Policy': 'same-origin',
  'Permissions-Policy': 'geolocation=(), camera=(), microphone=(), payment=()',
  'X-Frame-Options': 'DENY',
} as const;

/** Route classes for rate limiting. See docs/03-security-and-permissions.md §8. */
export const RATE_LIMITS = {
  authUnauthenticated: { points: 10, windowSeconds: 900 },
  authenticatedRead: { points: 300, windowSeconds: 60 },
  authenticatedWrite: { points: 120, windowSeconds: 60 },
  bulkWrite: { points: 20, windowSeconds: 60 },
  publicFormSubmit: { points: 20, windowSeconds: 3600 },
  search: { points: 60, windowSeconds: 60 },
  passwordReset: { points: 5, windowSeconds: 3600 },
} as const;

export type RateLimitClass = keyof typeof RATE_LIMITS;

export const TOKEN_TTL = {
  emailVerificationHours: 24,
  passwordResetMinutes: 30,
  magicLinkMinutes: 15,
  invitationDays: 14,
  mfaChallengeMinutes: 10,
} as const;

export const AUTH_POLICY = {
  passwordMinLength: 12,
  passwordMaxLength: 256,
  /** Failed attempts before an account is temporarily locked. */
  maxFailedAttempts: 10,
  lockoutMinutes: 15,
  recoveryCodeCount: 10,
  recoveryCodeLength: 10,
  /** TOTP: 30-second step, one step of drift tolerated either side. */
  totpStepSeconds: 30,
  totpWindow: 1,
  argon2: {
    memoryCost: 19_456,
    timeCost: 2,
    parallelism: 1,
  },
} as const;

export const UPLOAD_POLICY = {
  allowedMimeTypes: [
    'image/png',
    'image/jpeg',
    'image/gif',
    'image/webp',
    'image/svg+xml',
    'application/pdf',
    'text/plain',
    'text/csv',
    'application/json',
    'application/zip',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    'video/mp4',
    'video/webm',
    'audio/mpeg',
    'audio/wav',
  ],
  /** Extensions blocked regardless of declared MIME type. */
  deniedExtensions: [
    '.exe', '.dll', '.bat', '.cmd', '.com', '.scr', '.msi', '.ps1', '.vbs', '.js', '.jar',
    '.sh', '.app', '.deb', '.rpm', '.dmg', '.pkg', '.htaccess', '.php',
  ],
  multipartThresholdBytes: 8 * 1024 * 1024,
  thumbnailSizes: [64, 256, 1024],
} as const;

/**
 * Private IP ranges that outbound webhook and integration calls must never reach.
 * See docs/03-security-and-permissions.md §T8 (SSRF).
 */
export const SSRF_DENIED_CIDRS = [
  '0.0.0.0/8',
  '10.0.0.0/8',
  '100.64.0.0/10',
  '127.0.0.0/8',
  '169.254.0.0/16', // link-local, includes cloud metadata endpoints
  '172.16.0.0/12',
  '192.0.0.0/24',
  '192.168.0.0/16',
  '198.18.0.0/15',
  '224.0.0.0/4',
  '240.0.0.0/4',
  '::1/128',
  'fc00::/7',
  'fe80::/10',
] as const;

export const CACHE_TTL_SECONDS = {
  authorization: 60,
  schema: 300,
  viewQuery: 30,
  userProfile: 120,
  entitlements: 300,
} as const;

export const REALTIME = {
  heartbeatIntervalMs: 20_000,
  presenceTtlSeconds: 60,
  presenceThrottleMs: 500,
  deltaCoalesceMs: 100,
  maxChannelsPerSocket: 50,
  replayWindowSeconds: 300,
} as const;

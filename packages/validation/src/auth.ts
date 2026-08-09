import { z } from 'zod';

import {
  displayNameSchema,
  emailSchema,
  localeSchema,
  passwordSchema,
  recoveryCodeSchema,
  timezoneSchema,
  totpCodeSchema,
} from './primitives';

/**
 * Auth request/response contracts.
 *
 * Every schema here is `.strict()`: an unexpected property is a validation error, not silently
 * ignored. This is the mass-assignment defence — a client cannot smuggle `role`,
 * `emailVerified`, or `isPlatformAdmin` into a registration payload, because the schema is an
 * allowlist and the parsed object is what reaches the service.
 */

export const registerSchema = z
  .object({
    email: emailSchema,
    password: passwordSchema,
    name: displayNameSchema,
    /** Optional: accepting an invitation during registration. */
    invitationToken: z.string().max(512).optional(),
    acceptedTerms: z.literal(true, {
      errorMap: () => ({ message: 'you must accept the terms to create an account' }),
    }),
    marketingOptIn: z.boolean().default(false),
  })
  .strict();
export type RegisterInput = z.infer<typeof registerSchema>;

export const loginSchema = z
  .object({
    email: emailSchema,
    password: z.string().min(1).max(256),
    /** Extends the session lifetime; still bounded by the absolute TTL. */
    rememberMe: z.boolean().default(false),
  })
  .strict();
export type LoginInput = z.infer<typeof loginSchema>;

export const mfaVerifySchema = z
  .object({
    mfaToken: z.string().min(1).max(512),
    code: z.union([totpCodeSchema, recoveryCodeSchema]),
  })
  .strict();
export type MfaVerifyInput = z.infer<typeof mfaVerifySchema>;

export const mfaActivateSchema = z.object({ code: totpCodeSchema }).strict();

export const mfaDisableSchema = z
  .object({
    /** Disabling a second factor requires re-proving the first. */
    password: z.string().min(1).max(256),
    code: z.union([totpCodeSchema, recoveryCodeSchema]),
  })
  .strict();

export const verifyEmailSchema = z.object({ token: z.string().min(1).max(512) }).strict();

export const magicLinkRequestSchema = z.object({ email: emailSchema }).strict();

export const magicLinkConsumeSchema = z.object({ token: z.string().min(1).max(512) }).strict();

export const forgotPasswordSchema = z.object({ email: emailSchema }).strict();

export const resetPasswordSchema = z
  .object({
    token: z.string().min(1).max(512),
    password: passwordSchema,
  })
  .strict();

export const changePasswordSchema = z
  .object({
    currentPassword: z.string().min(1).max(256),
    newPassword: passwordSchema,
    /** Default true: a password change is usually a response to suspected compromise. */
    revokeOtherSessions: z.boolean().default(true),
  })
  .strict()
  .refine((v) => v.currentPassword !== v.newPassword, {
    message: 'the new password must differ from the current one',
    path: ['newPassword'],
  });
export type ChangePasswordInput = z.infer<typeof changePasswordSchema>;

export const updateProfileSchema = z
  .object({
    name: displayNameSchema.optional(),
    timezone: timezoneSchema.optional(),
    locale: localeSchema.optional(),
    theme: z.enum(['light', 'dark', 'system']).optional(),
    notificationPreferences: z
      .object({
        emailMentions: z.boolean(),
        emailComments: z.boolean(),
        emailRecordChanges: z.boolean(),
        emailDigest: z.enum(['off', 'daily', 'weekly']),
        inAppMentions: z.boolean(),
        inAppComments: z.boolean(),
      })
      .partial()
      .optional(),
  })
  .strict();

export const oauthProviderSchema = z.enum(['google', 'microsoft', 'github']);

export const oauthCallbackSchema = z
  .object({
    code: z.string().min(1).max(2_048),
    state: z.string().min(1).max(512),
  })
  .strict();

// ── Response shapes ──────────────────────────────────────────────────────────

export const sessionSummarySchema = z.object({
  id: z.string(),
  createdAt: z.string(),
  lastSeenAt: z.string(),
  expiresAt: z.string(),
  ipAddress: z.string().nullable(),
  userAgent: z.string().nullable(),
  deviceLabel: z.string().nullable(),
  location: z.string().nullable(),
  isCurrent: z.boolean(),
});
export type SessionSummary = z.infer<typeof sessionSummarySchema>;

export const authenticatedUserSchema = z.object({
  id: z.string(),
  email: z.string(),
  name: z.string(),
  avatarUrl: z.string().nullable(),
  emailVerified: z.boolean(),
  twoFactorEnabled: z.boolean(),
  timezone: z.string(),
  locale: z.string(),
  theme: z.enum(['light', 'dark', 'system']),
  createdAt: z.string(),
});
export type AuthenticatedUser = z.infer<typeof authenticatedUserSchema>;

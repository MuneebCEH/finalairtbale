import { ORGANIZATION_ROLES, WORKSPACE_ROLES } from '@tessera/types';
import { z } from 'zod';

import {
  colorSchema,
  descriptionSchema,
  displayNameSchema,
  emailSchema,
  idSchema,
  slugSchema,
} from './primitives';

export const createOrganizationSchema = z
  .object({
    name: displayNameSchema,
    /** Derived from the name when omitted. */
    slug: slugSchema.optional(),
  })
  .strict();
export type CreateOrganizationInput = z.infer<typeof createOrganizationSchema>;

export const updateOrganizationSchema = z
  .object({
    name: displayNameSchema.optional(),
    slug: slugSchema.optional(),
    logoUrl: z.string().url().max(2_048).nullable().optional(),
    brandColor: colorSchema.optional(),
  })
  .strict();

/**
 * Governance settings.
 *
 * These are the switches an administrator uses to constrain what members may do. They are read
 * by the policy engine, so flipping one takes effect on the next authorization check — there is
 * no separate "apply" step that could leave the UI and the enforcement out of step.
 */
export const organizationSettingsSchema = z
  .object({
    memberCanCreateWorkspaces: z.boolean(),
    memberCanInvite: z.boolean(),
    guestCanInvite: z.boolean(),
    allowPublicSharing: z.boolean(),
    allowPublicForms: z.boolean(),
    allowExports: z.boolean(),
    allowApiAccess: z.boolean(),
    requireTwoFactor: z.boolean(),
    sessionTimeoutHours: z.number().int().min(1).max(8_760),
    /** Users with these email domains join automatically instead of needing an invitation. */
    approvedEmailDomains: z.array(z.string().max(253)).max(50),
    /** Restricts share links to recipients at these domains. */
    shareLinkDomainAllowlist: z.array(z.string().max(253)).max(50),
    defaultWorkspaceRole: z.enum(WORKSPACE_ROLES),
    retentionDays: z.number().int().min(1).max(3_650).nullable(),
  })
  .partial()
  .strict();
export type OrganizationSettingsInput = z.infer<typeof organizationSettingsSchema>;

export const inviteMemberSchema = z
  .object({
    emails: z.array(emailSchema).min(1).max(50),
    role: z.enum(ORGANIZATION_ROLES).default('member'),
    /** Optional immediate workspace grants, so an invite lands somebody somewhere useful. */
    workspaceGrants: z
      .array(
        z.object({
          workspaceId: idSchema('workspace'),
          role: z.enum(WORKSPACE_ROLES),
        }),
      )
      .max(20)
      .default([]),
    message: descriptionSchema.optional(),
  })
  .strict()
  .refine(
    (v) => v.role !== 'owner',
    { message: 'ownership is transferred, not invited', path: ['role'] },
  );
export type InviteMemberInput = z.infer<typeof inviteMemberSchema>;

export const updateMemberRoleSchema = z
  .object({ role: z.enum(ORGANIZATION_ROLES) })
  .strict()
  .refine((v) => v.role !== 'owner', {
    message: 'use the ownership transfer endpoint to make somebody an owner',
    path: ['role'],
  });

export const transferOwnershipSchema = z
  .object({
    newOwnerId: idSchema('user'),
    /** Transferring ownership is irreversible without the new owner's cooperation. */
    confirmation: z.literal('TRANSFER OWNERSHIP'),
  })
  .strict();

export const createGroupSchema = z
  .object({
    name: displayNameSchema,
    description: descriptionSchema.optional(),
    memberIds: z.array(idSchema('user')).max(1_000).default([]),
  })
  .strict();

export const acceptInvitationSchema = z.object({ token: z.string().min(1).max(512) }).strict();

// ── Workspaces ───────────────────────────────────────────────────────────────

export const createWorkspaceSchema = z
  .object({
    name: displayNameSchema,
    description: descriptionSchema.optional(),
    icon: z.string().max(64).optional(),
    color: colorSchema.optional(),
  })
  .strict();
export type CreateWorkspaceInput = z.infer<typeof createWorkspaceSchema>;

export const updateWorkspaceSchema = createWorkspaceSchema.partial().strict();

export const addWorkspaceMemberSchema = z
  .object({
    userId: idSchema('user').optional(),
    groupId: idSchema('group').optional(),
    role: z.enum(WORKSPACE_ROLES),
  })
  .strict()
  .refine((v) => Boolean(v.userId) !== Boolean(v.groupId), {
    message: 'provide exactly one of userId or groupId',
  });

export const deleteWorkspaceSchema = z
  .object({
    /** Typed confirmation for a destructive action, matched against the workspace name. */
    confirmation: z.string().min(1),
  })
  .strict();

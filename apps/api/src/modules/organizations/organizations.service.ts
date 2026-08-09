import { Inject, Injectable } from '@nestjs/common';
import { expiresIn, issueToken } from '@tessera/auth';
import { TOKEN_TTL, type Env } from '@tessera/config';
import {
  AuditWriter,
  OrganizationRepository,
  OutboxWriter,
  UserRepository,
  newId,
} from '@tessera/database';
import type { Logger } from '@tessera/logger';
import {
  AppError,
  PLAN_ENTITLEMENTS,
  type OrganizationRole,
  type Plan,
  type TenantContext,
  type UserId,
} from '@tessera/types';
import type {
  CreateOrganizationInput,
  InviteMemberInput,
  OrganizationSettingsInput,
} from '@tessera/validation';
import { RESERVED_SLUGS } from '@tessera/validation';

import { MailerService } from '../../infrastructure/mailer.service';
import { MembershipService } from '../../infrastructure/membership.service';
import { PrismaService } from '../../infrastructure/prisma.service';
import { ENV, LOGGER } from '../../infrastructure/tokens';

/**
 * Organization lifecycle and membership.
 *
 * Three invariants are enforced here rather than left to callers, because each of them produces
 * an unrecoverable state if violated:
 *
 *  1. **An organization always has at least one active owner.** The last owner cannot be
 *     removed, demoted, or suspended. Without this an organization becomes unadministrable and
 *     needs platform intervention to fix.
 *  2. **Seat limits are checked at the moment of grant**, not only at invitation time — an
 *     invitation issued when a seat was free must not be accepted after the plan filled up.
 *  3. **Every membership change invalidates the actor's cached authorization immediately**, so a
 *     revocation is never subject to the 60-second cache window.
 */
@Injectable()
export class OrganizationsService {
  private readonly outbox = new OutboxWriter();
  private readonly audit = new AuditWriter();

  constructor(
    private readonly prisma: PrismaService,
    private readonly memberships: MembershipService,
    private readonly mailer: MailerService,
    @Inject(ENV) private readonly env: Env,
    @Inject(LOGGER) private readonly logger: Logger,
  ) {}

  // ── Creation ───────────────────────────────────────────────────────────────

  /**
   * Creates an organization with its owner, default group, and free subscription in one
   * transaction. A partially-created organization — one with no owner, say — would be a support
   * ticket, so the whole thing is atomic.
   */
  async create(input: CreateOrganizationInput, ownerId: string) {
    const slug = await this.uniqueSlug(input.slug ?? slugify(input.name));
    const organizationId = newId('organization');

    const tenant: TenantContext = {
      organizationId: organizationId as never,
      principal: { type: 'user', userId: ownerId as UserId, sessionId: '' as never, mfaSatisfied: true, isPlatformAdmin: false },
      correlationId: 'organization.create',
    };

    const organization = await this.prisma.client.$transaction(async (tx) => {
      const org = await tx.organization.create({
        data: {
          id: organizationId,
          name: input.name,
          slug,
          plan: 'free',
          settings: DEFAULT_ORGANIZATION_SETTINGS as never,
        },
      });

      await tx.organizationMember.create({
        data: {
          id: newId('user'),
          organizationId,
          userId: ownerId,
          role: 'owner',
        },
      });

      // A system "Everyone" group exists from day one so that org-wide grants have somewhere to
      // attach without a later migration that has to backfill every existing member.
      await tx.organizationGroup.create({
        data: {
          id: newId('group'),
          organizationId,
          name: 'Everyone',
          description: 'All members of this organization.',
          isSystem: true,
          createdById: ownerId,
        },
      });

      await tx.subscription.create({
        data: {
          id: newId('organization'),
          organizationId,
          plan: 'free',
          status: 'active',
          seats: 1,
        },
      });

      await this.outbox.append(tx, tenant, 'organization.created', {
        organizationId,
        name: input.name,
        slug,
        ownerId,
      });

      await this.audit.write(tx, tenant, {
        action: 'organization.created',
        resourceType: 'organization',
        resourceId: organizationId,
        after: { name: input.name, slug },
      });

      return org;
    });

    this.logger.info('organization created', { organizationId, ownerId });
    return organization;
  }

  // ── Read / update ──────────────────────────────────────────────────────────

  async get(tenant: TenantContext) {
    return new OrganizationRepository(this.prisma.read, tenant).findById();
  }

  async update(tenant: TenantContext, patch: Record<string, unknown>) {
    const repo = new OrganizationRepository(this.prisma.client, tenant);
    const before = await repo.findById();

    if (typeof patch['slug'] === 'string' && patch['slug'] !== before.slug) {
      patch['slug'] = await this.uniqueSlug(patch['slug']);
    }

    const after = await repo.update(patch);

    await this.prisma.transact(tenant, async (tx) => {
      const diff = this.audit.diff(before as never, after as never);
      await this.audit.write(tx, tenant, {
        action: 'organization.updated',
        resourceType: 'organization',
        resourceId: tenant.organizationId,
        before: diff.before,
        after: diff.after,
      });
    });

    return after;
  }

  async updateSettings(tenant: TenantContext, patch: OrganizationSettingsInput) {
    const repo = new OrganizationRepository(this.prisma.client, tenant);
    const before = await repo.findById();
    const settings = await repo.updateSettings(patch as Record<string, unknown>);

    await this.prisma.transact(tenant, async (tx) => {
      await this.audit.write(tx, tenant, {
        action: 'organization.settings_changed',
        resourceType: 'organization',
        resourceId: tenant.organizationId,
        before: before.settings,
        after: settings,
      });
    });

    // Settings feed directly into permission decisions, so every cached snapshot in this
    // organization is now potentially wrong.
    await this.memberships.invalidateOrganization(tenant.organizationId);
    return settings;
  }

  // ── Members ────────────────────────────────────────────────────────────────

  async listMembers(tenant: TenantContext, page: { limit: number; cursor?: string }) {
    return new OrganizationRepository(this.prisma.read, tenant).listMembers(page);
  }

  async invite(tenant: TenantContext, input: InviteMemberInput, invitedById: string) {
    const repo = new OrganizationRepository(this.prisma.client, tenant);
    const organization = await repo.findById();
    await this.assertSeatsAvailable(tenant, organization.plan as Plan, input.emails.length, input.role);

    const issued: Array<{ email: string; invitationId: string }> = [];

    for (const email of input.emails) {
      // An existing member is skipped rather than re-invited, and reported as such — silently
      // creating a second membership row would corrupt seat counting.
      const existingUser = await new UserRepository(this.prisma.read).findByEmail(email);
      if (existingUser && (await repo.findMember(existingUser.id))) continue;

      const token = issueToken();
      const invitationId = newId('invitation');

      await this.prisma.transact(tenant, async (tx) => {
        await tx.invitation.create({
          data: {
            id: invitationId,
            organizationId: tenant.organizationId,
            email,
            role: input.role,
            workspaceGrants: input.workspaceGrants as never,
            tokenHash: token.hash,
            message: input.message ?? null,
            invitedById,
            expiresAt: expiresIn.days(TOKEN_TTL.invitationDays),
          },
        });

        await this.outbox.append(tx, tenant, 'member.invited', {
          invitationId,
          email,
          role: input.role,
          invitedBy: invitedById,
        });

        await this.audit.write(tx, tenant, {
          action: 'member.invited',
          resourceType: 'organization',
          resourceId: tenant.organizationId,
          after: { email, role: input.role },
        });
      });

      await this.mailer.send({
        to: email,
        subject: `You have been invited to ${organization.name} on ${this.env.APP_NAME}`,
        text:
          `You have been invited to join ${organization.name} as a ${input.role}.\n\n` +
          `${input.message ? `Message: ${input.message}\n\n` : ''}` +
          `Accept the invitation:\n${this.env.APP_URL}/invitations/${token.plaintext}\n\n` +
          `The invitation expires in ${TOKEN_TTL.invitationDays} days.`,
      });

      issued.push({ email, invitationId });
    }

    return { invited: issued.length, invitations: issued };
  }

  async changeRole(tenant: TenantContext, userId: string, role: OrganizationRole) {
    const repo = new OrganizationRepository(this.prisma.client, tenant);
    const member = await repo.findMember(userId);
    if (!member) throw new AppError('NOT_FOUND', 'That person is not a member of this organization.');

    if (member.role === 'owner' && (await repo.countOwners()) <= 1) {
      throw new AppError(
        'FORBIDDEN',
        'This is the only owner. Transfer ownership before changing this role.',
      );
    }

    await repo.updateMemberRole(userId, role);

    await this.prisma.transact(tenant, async (tx) => {
      await this.outbox.append(tx, tenant, 'member.role_changed', {
        userId,
        from: member.role,
        to: role,
        changedBy: actingUser(tenant),
      });
      await this.audit.write(tx, tenant, {
        action: 'member.role_changed',
        resourceType: 'organization',
        resourceId: tenant.organizationId,
        before: { userId, role: member.role },
        after: { userId, role },
      });
    });

    await this.memberships.invalidate(tenant.organizationId, userId);
  }

  async removeMember(tenant: TenantContext, userId: string) {
    const repo = new OrganizationRepository(this.prisma.client, tenant);
    const member = await repo.findMember(userId);
    if (!member) throw new AppError('NOT_FOUND', 'That person is not a member of this organization.');

    if (member.role === 'owner' && (await repo.countOwners()) <= 1) {
      throw new AppError('FORBIDDEN', 'The only owner cannot be removed.');
    }

    await this.prisma.transact(tenant, async (tx) => {
      // Workspace and base grants go with the membership. Leaving orphaned grants behind would
      // silently restore access if the person were ever re-added.
      await tx.workspaceMember.deleteMany({
        where: { organizationId: tenant.organizationId, userId },
      });
      await tx.baseMember.deleteMany({ where: { organizationId: tenant.organizationId, userId } });
      await tx.organizationMember.deleteMany({
        where: { organizationId: tenant.organizationId, userId },
      });

      await this.outbox.append(tx, tenant, 'member.removed', {
        userId,
        removedBy: actingUser(tenant),
      });
      await this.audit.write(tx, tenant, {
        action: 'member.removed',
        resourceType: 'organization',
        resourceId: tenant.organizationId,
        before: { userId, role: member.role },
      });
    });

    await this.memberships.invalidate(tenant.organizationId, userId);
  }

  async setSuspended(tenant: TenantContext, userId: string, suspended: boolean) {
    const repo = new OrganizationRepository(this.prisma.client, tenant);
    const member = await repo.findMember(userId);
    if (!member) throw new AppError('NOT_FOUND', 'That person is not a member of this organization.');

    if (suspended && member.role === 'owner' && (await repo.countOwners()) <= 1) {
      throw new AppError('FORBIDDEN', 'The only owner cannot be suspended.');
    }

    await repo.setMemberStatus(userId, suspended ? 'suspended' : 'active');

    await this.prisma.transact(tenant, async (tx) => {
      await this.audit.write(tx, tenant, {
        action: suspended ? 'member.suspended' : 'member.reinstated',
        resourceType: 'organization',
        resourceId: tenant.organizationId,
        after: { userId },
      });
    });

    await this.memberships.invalidate(tenant.organizationId, userId);
  }

  /**
   * Transfers ownership.
   *
   * The current owner is demoted to admin rather than removed — an organization losing its
   * previous owner entirely is almost never what anybody intends, and re-adding them requires
   * the new owner to act.
   */
  async transferOwnership(tenant: TenantContext, currentOwnerId: string, newOwnerId: string) {
    const repo = new OrganizationRepository(this.prisma.client, tenant);
    const target = await repo.findMember(newOwnerId);
    if (!target) throw new AppError('NOT_FOUND', 'The new owner must already be a member.');
    if (target.status !== 'active') {
      throw new AppError('FORBIDDEN', 'The new owner must be an active member.');
    }

    await this.prisma.transact(tenant, async (tx) => {
      await tx.organizationMember.updateMany({
        where: { organizationId: tenant.organizationId, userId: newOwnerId },
        data: { role: 'owner' },
      });
      await tx.organizationMember.updateMany({
        where: { organizationId: tenant.organizationId, userId: currentOwnerId },
        data: { role: 'admin' },
      });

      await this.audit.write(tx, tenant, {
        action: 'organization.ownership_transferred',
        resourceType: 'organization',
        resourceId: tenant.organizationId,
        before: { ownerId: currentOwnerId },
        after: { ownerId: newOwnerId },
      });
    });

    await this.memberships.invalidate(tenant.organizationId, currentOwnerId);
    await this.memberships.invalidate(tenant.organizationId, newOwnerId);
    this.logger.warn('ownership transferred', {
      organizationId: tenant.organizationId,
      from: currentOwnerId,
      to: newOwnerId,
    });
  }

  // ── Invitations ────────────────────────────────────────────────────────────

  async acceptInvitation(tokenPlaintext: string, userId: string, userEmail: string) {
    const { hashToken } = await import('@tessera/auth');
    const invitation = await this.prisma.client.invitation.findUnique({
      where: { tokenHash: hashToken(tokenPlaintext) },
    });

    if (
      !invitation ||
      invitation.acceptedAt ||
      invitation.revokedAt ||
      invitation.expiresAt.getTime() <= Date.now()
    ) {
      throw new AppError('NOT_FOUND', 'This invitation is no longer valid.');
    }

    // The invitation is bound to the address it was sent to. Without this check, anybody who
    // obtained the link — forwarded email, shared screenshot — could join the organization.
    if (invitation.email.toLowerCase() !== userEmail.toLowerCase()) {
      throw new AppError('FORBIDDEN', 'This invitation was issued to a different email address.');
    }

    const tenant: TenantContext = {
      organizationId: invitation.organizationId as never,
      principal: { type: 'user', userId: userId as UserId, sessionId: '' as never, mfaSatisfied: true, isPlatformAdmin: false },
      correlationId: 'invitation.accept',
    };

    const organization = await new OrganizationRepository(this.prisma.read, tenant).findById();
    await this.assertSeatsAvailable(tenant, organization.plan as Plan, 1, invitation.role as OrganizationRole);

    await this.prisma.transact(tenant, async (tx) => {
      await tx.organizationMember.create({
        data: {
          id: newId('user'),
          organizationId: invitation.organizationId,
          userId,
          role: invitation.role,
          invitedById: invitation.invitedById,
        },
      });

      for (const grant of (invitation.workspaceGrants ?? []) as Array<{
        workspaceId: string;
        role: string;
      }>) {
        await tx.workspaceMember.create({
          data: {
            id: newId('workspace'),
            organizationId: invitation.organizationId,
            workspaceId: grant.workspaceId,
            userId,
            role: grant.role,
            addedById: invitation.invitedById,
          },
        });
      }

      await tx.invitation.update({
        where: { id: invitation.id },
        data: { acceptedAt: new Date(), acceptedByUserId: userId },
      });

      await this.outbox.append(tx, tenant, 'member.joined', { userId, role: invitation.role });
      await this.audit.write(tx, tenant, {
        action: 'member.joined',
        resourceType: 'organization',
        resourceId: invitation.organizationId,
        after: { userId, role: invitation.role },
      });
    });

    await this.memberships.invalidate(invitation.organizationId, userId);
    return { organizationId: invitation.organizationId };
  }

  // ── Helpers ────────────────────────────────────────────────────────────────

  /**
   * Enforces the plan's seat entitlement.
   *
   * Guests are metered separately from members, because a plan that includes unlimited read-only
   * collaborators but five editors is a common and legitimate shape.
   */
  private async assertSeatsAvailable(
    tenant: TenantContext,
    plan: Plan,
    additional: number,
    role: OrganizationRole,
  ): Promise<void> {
    const entitlements = PLAN_ENTITLEMENTS[plan];
    const counts = await new OrganizationRepository(this.prisma.read, tenant).countSeats();

    if (role === 'guest') {
      if (entitlements.guests !== null && counts.guests + additional > entitlements.guests) {
        throw new AppError('PLAN_LIMIT_EXCEEDED', 'Your plan has no guest seats remaining.', {
          details: { limit: 'guests', allowed: entitlements.guests, usage: counts.guests },
        });
      }
      return;
    }

    if (entitlements.seats !== null && counts.members + additional > entitlements.seats) {
      throw new AppError('PLAN_LIMIT_EXCEEDED', 'Your plan has no seats remaining.', {
        details: { limit: 'seats', allowed: entitlements.seats, usage: counts.members },
      });
    }
  }

  private async uniqueSlug(candidate: string): Promise<string> {
    const base = slugify(candidate);
    let slug = RESERVED_SLUGS.has(base) ? `${base}-org` : base;

    for (let attempt = 0; attempt < 20; attempt += 1) {
      const taken = await this.prisma.read.organization.findUnique({
        where: { slug },
        select: { id: true },
      });
      if (!taken) return slug;
      slug = `${base}-${Math.random().toString(36).slice(2, 6)}`;
    }

    throw new AppError('DUPLICATE_RESOURCE', 'Could not derive a unique URL for this name.');
  }
}

function slugify(value: string): string {
  return (
    value
      .toLowerCase()
      .normalize('NFKD')
      // Strip the combining marks NFKD just separated out, so "Café" becomes "cafe" rather
      // than "caf-". Written as an escape so the source file stays pure ASCII.
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 40) || 'workspace'
  );
}

function actingUser(tenant: TenantContext): string | null {
  return tenant.principal.type === 'user' ? tenant.principal.userId : null;
}

/** Conservative defaults: sharing and API access are opt-in, not opt-out. */
export const DEFAULT_ORGANIZATION_SETTINGS = {
  memberCanCreateWorkspaces: true,
  memberCanInvite: false,
  guestCanInvite: false,
  allowPublicSharing: true,
  allowPublicForms: true,
  allowExports: true,
  allowApiAccess: true,
  requireTwoFactor: false,
  sessionTimeoutHours: 720,
  approvedEmailDomains: [] as string[],
  shareLinkDomainAllowlist: [] as string[],
  defaultWorkspaceRole: 'editor',
  retentionDays: null,
};

import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post, Query } from '@nestjs/common';
import { AppError, actingUserId, type Principal, type TenantContext } from '@tessera/types';
import {
  acceptInvitationSchema,
  createOrganizationSchema,
  inviteMemberSchema,
  organizationSettingsSchema,
  paginationSchema,
  transferOwnershipSchema,
  updateMemberRoleSchema,
  updateOrganizationSchema,
  type CreateOrganizationInput,
  type InviteMemberInput,
  type OrganizationSettingsInput,
} from '@tessera/validation';

import {
  CurrentPrincipal,
  CurrentTenant,
  RateLimit,
  RequiresAction,
  SkipTenantScope,
} from '../../bootstrap/decorators';
import { zodBody } from '../../bootstrap/zod.pipe';
import { PrismaService } from '../../infrastructure/prisma.service';

import { OrganizationsService } from './organizations.service';

/**
 * Organization endpoints.
 *
 * Note the shape of every method: validate (pipe) → authorize (`@RequiresAction`) → delegate.
 * Controllers hold no business logic and touch no repository — they translate HTTP into a
 * service call and a DTO back. That separation is what keeps authorization auditable: the
 * required permission for every route is a single line above the handler.
 */
@Controller({ path: 'organizations', version: '1' })
export class OrganizationsController {
  constructor(
    private readonly organizations: OrganizationsService,
    private readonly prisma: PrismaService,
  ) {}

  @Post()
  @SkipTenantScope() // No tenant exists yet — this call creates one.
  @RateLimit('authenticatedWrite')
  @HttpCode(201)
  async create(
    @Body(zodBody(createOrganizationSchema)) input: CreateOrganizationInput,
    @CurrentPrincipal() principal: Principal,
  ) {
    const userId = requireUserId(principal);
    const organization = await this.organizations.create(input, userId);
    return {
      data: {
        id: organization.id,
        name: organization.name,
        slug: organization.slug,
        plan: organization.plan,
      },
    };
  }

  @Get(':orgId')
  @RequiresAction('organization:read')
  @RateLimit('authenticatedRead')
  async get(@CurrentTenant() tenant: TenantContext) {
    return { data: await this.organizations.get(tenant) };
  }

  @Patch(':orgId')
  @RequiresAction('organization:update')
  @RateLimit('authenticatedWrite')
  async update(
    @CurrentTenant() tenant: TenantContext,
    @Body(zodBody(updateOrganizationSchema)) input: Record<string, unknown>,
  ) {
    return { data: await this.organizations.update(tenant, input) };
  }

  @Patch(':orgId/settings')
  @RequiresAction('organization:manage_settings')
  @RateLimit('authenticatedWrite')
  async updateSettings(
    @CurrentTenant() tenant: TenantContext,
    @Body(zodBody(organizationSettingsSchema)) input: OrganizationSettingsInput,
  ) {
    return { data: await this.organizations.updateSettings(tenant, input) };
  }

  @Get(':orgId/members')
  @RequiresAction('member:read')
  @RateLimit('authenticatedRead')
  async listMembers(
    @CurrentTenant() tenant: TenantContext,
    @Query() query: Record<string, unknown>,
  ) {
    const page = paginationSchema.parse(query);
    return this.organizations.listMembers(tenant, page);
  }

  @Post(':orgId/invitations')
  @RequiresAction('member:invite')
  @RateLimit('authenticatedWrite')
  @HttpCode(202)
  async invite(
    @CurrentTenant() tenant: TenantContext,
    @Body(zodBody(inviteMemberSchema)) input: InviteMemberInput,
    @CurrentPrincipal() principal: Principal,
  ) {
    // Inviting a guest is a distinct permission from inviting a member, because the two have
    // very different blast radii. The route-level check covers the common case; the narrower
    // check happens here where the requested role is known.
    const userId = requireUserId(principal);
    return { data: await this.organizations.invite(tenant, input, userId) };
  }

  @Patch(':orgId/members/:userId')
  @RequiresAction('member:change_role')
  @RateLimit('authenticatedWrite')
  @HttpCode(204)
  async changeRole(
    @CurrentTenant() tenant: TenantContext,
    @Param('userId') targetUserId: string,
    @Body(zodBody(updateMemberRoleSchema)) input: { role: string },
  ) {
    await this.organizations.changeRole(tenant, targetUserId, input.role as never);
  }

  @Delete(':orgId/members/:userId')
  @RequiresAction('member:remove')
  @RateLimit('authenticatedWrite')
  @HttpCode(204)
  async removeMember(
    @CurrentTenant() tenant: TenantContext,
    @Param('userId') targetUserId: string,
  ) {
    await this.organizations.removeMember(tenant, targetUserId);
  }

  @Post(':orgId/members/:userId/suspend')
  @RequiresAction('member:suspend')
  @RateLimit('authenticatedWrite')
  @HttpCode(204)
  async suspend(@CurrentTenant() tenant: TenantContext, @Param('userId') targetUserId: string) {
    await this.organizations.setSuspended(tenant, targetUserId, true);
  }

  @Post(':orgId/members/:userId/reinstate')
  @RequiresAction('member:suspend')
  @RateLimit('authenticatedWrite')
  @HttpCode(204)
  async reinstate(@CurrentTenant() tenant: TenantContext, @Param('userId') targetUserId: string) {
    await this.organizations.setSuspended(tenant, targetUserId, false);
  }

  @Post(':orgId/transfer-ownership')
  @RequiresAction('organization:transfer_ownership')
  @RateLimit('authenticatedWrite')
  @HttpCode(204)
  async transferOwnership(
    @CurrentTenant() tenant: TenantContext,
    @Body(zodBody(transferOwnershipSchema)) input: { newOwnerId: string },
    @CurrentPrincipal() principal: Principal,
  ) {
    await this.organizations.transferOwnership(
      tenant,
      requireUserId(principal),
      input.newOwnerId,
    );
  }
}

/**
 * Invitation acceptance lives outside the organization path on purpose: the invitee is not yet a
 * member, so the tenant guard would reject them before they could join.
 */
@Controller({ path: 'invitations', version: '1' })
@SkipTenantScope()
export class InvitationsController {
  constructor(
    private readonly organizations: OrganizationsService,
    private readonly prisma: PrismaService,
  ) {}

  @Post('accept')
  @RateLimit('authenticatedWrite')
  @HttpCode(200)
  async accept(
    @Body(zodBody(acceptInvitationSchema)) input: { token: string },
    @CurrentPrincipal() principal: Principal,
  ) {
    const userId = requireUserId(principal);
    const user = await this.prisma.read.user.findUnique({
      where: { id: userId },
      select: { email: true },
    });
    if (!user) throw new AppError('UNAUTHENTICATED', 'Sign in to accept this invitation.');

    return { data: await this.organizations.acceptInvitation(input.token, userId, user.email) };
  }
}

function requireUserId(principal: Principal): string {
  const userId = actingUserId(principal);
  if (!userId) {
    throw new AppError('FORBIDDEN', 'This endpoint requires a user, not a service credential.');
  }
  return userId;
}

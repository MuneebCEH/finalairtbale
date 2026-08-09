import { Body, Controller, Get, Patch } from '@nestjs/common';
import { UserRepository } from '@tessera/database';
import { AppError, actingUserId, type Principal } from '@tessera/types';
import { updateProfileSchema } from '@tessera/validation';

import {
  CurrentPrincipal,
  RateLimit,
  SkipTenantScope,
} from '../../bootstrap/decorators';
import { zodBody } from '../../bootstrap/zod.pipe';
import { PrismaService } from '../../infrastructure/prisma.service';
import { AuthService } from '../auth/auth.service';

/**
 * The caller's own account.
 *
 * Tenant-exempt by nature: a user exists independently of any organization, and this is the
 * endpoint the web app calls before it knows which organization to open.
 */
@Controller({ path: 'me', version: '1' })
@SkipTenantScope()
export class UsersController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly auth: AuthService,
  ) {}

  @Get()
  @RateLimit('authenticatedRead')
  async me(@CurrentPrincipal() principal: Principal) {
    return { data: await this.auth.publicUser(requireUserId(principal)) };
  }

  @Patch()
  @RateLimit('authenticatedWrite')
  async updateProfile(
    @CurrentPrincipal() principal: Principal,
    @Body(zodBody(updateProfileSchema)) input: Record<string, unknown>,
  ) {
    const userId = requireUserId(principal);
    const users = new UserRepository(this.prisma.client);

    // Notification preferences are merged rather than replaced, so a client that knows about
    // four toggles cannot clear the fifth by omitting it.
    if (input['notificationPreferences']) {
      const current = await users.findById(userId);
      input['notificationPreferences'] = {
        ...((current?.notificationPreferences ?? {}) as Record<string, unknown>),
        ...(input['notificationPreferences'] as Record<string, unknown>),
      };
    }

    await users.update(userId, input);
    return { data: await this.auth.publicUser(userId) };
  }

  /**
   * The organizations this user belongs to.
   *
   * Deliberately derived from membership rather than accepting an organization id, so it is the
   * one endpoint that can safely enumerate across tenants — it only ever returns rows the caller
   * is a member of.
   */
  @Get('organizations')
  @RateLimit('authenticatedRead')
  async organizations(@CurrentPrincipal() principal: Principal) {
    const rows = await new UserRepository(this.prisma.read).listOrganizations(
      requireUserId(principal),
    );
    return {
      data: rows.map((row) => ({
        id: row.organization.id,
        name: row.organization.name,
        slug: row.organization.slug,
        logoUrl: row.organization.logoUrl,
        plan: row.organization.plan,
        status: row.organization.status,
        role: row.role,
        joinedAt: row.joinedAt.toISOString(),
      })),
    };
  }
}

function requireUserId(principal: Principal): string {
  const userId = actingUserId(principal);
  if (!userId) throw new AppError('FORBIDDEN', 'This endpoint requires a user credential.');
  return userId;
}

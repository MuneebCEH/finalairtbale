import { Body, Controller, Get, Post, Query } from '@nestjs/common';
import type { TenantContext } from '@tessera/types';
import { z } from 'zod';

import { CurrentTenant, RateLimit, RequiresAction } from '../../bootstrap/decorators';
import { zodBody } from '../../bootstrap/zod.pipe';

import { NotificationsService } from './notifications.service';

const markReadSchema = z
  .object({
    /** Either specific ids or everything unread. */
    ids: z.array(z.string().max(30)).max(500).optional(),
    all: z.boolean().optional(),
  })
  .strict()
  .refine((input) => input.all === true || (input.ids?.length ?? 0) > 0, {
    message: 'name the notifications to mark, or pass all: true',
  });

@Controller({ version: '1' })
export class NotificationsController {
  constructor(private readonly notifications: NotificationsService) {}

  @Get('organizations/:orgId/notifications')
  // A notification belongs to the caller, so membership of the organization is the whole check —
  // there is no separate action to hold.
  @RequiresAction('organization:read')
  async list(
    @CurrentTenant() tenant: TenantContext,
    @Query('unread') unread?: string,
    @Query('limit') limit?: string,
  ) {
    const parsed = Number(limit);
    return {
      data: await this.notifications.list(tenant, {
        unreadOnly: unread === 'true',
        ...(Number.isFinite(parsed) && parsed > 0 ? { limit: parsed } : {}),
      }),
      meta: { unread: await this.notifications.unreadCount(tenant) },
    };
  }

  @Post('organizations/:orgId/notifications/read')
  @RequiresAction('organization:read')
  @RateLimit('authenticatedWrite')
  async markRead(
    @CurrentTenant() tenant: TenantContext,
    @Body(zodBody(markReadSchema)) input: z.infer<typeof markReadSchema>,
  ) {
    return {
      data: await this.notifications.markRead(tenant, input.all ? 'all' : (input.ids ?? [])),
    };
  }
}

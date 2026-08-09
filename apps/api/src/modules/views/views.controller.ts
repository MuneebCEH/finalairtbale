import { Body, Controller, Delete, Get, Param, Patch, Post } from '@nestjs/common';
import type { TenantContext } from '@tessera/types';
import { viewSchema } from '@tessera/views';
import { z } from 'zod';

import { CurrentTenant, RateLimit, RequiresAction } from '../../bootstrap/decorators';
import { zodBody } from '../../bootstrap/zod.pipe';

import { ViewsService } from './views.service';

const createSchema = z
  .object({
    name: z.string().min(1).max(120),
    view: viewSchema,
    isPersonal: z.boolean().optional(),
    description: z.string().max(2_000).optional(),
    icon: z.string().max(64).optional(),
  })
  .strict();

const updateSchema = z
  .object({
    name: z.string().min(1).max(120).optional(),
    view: viewSchema.optional(),
    expectedVersion: z.number().int().min(1).optional(),
  })
  .strict()
  .refine((input) => input.name !== undefined || input.view !== undefined, {
    message: 'nothing to change',
  });

const lockSchema = z.object({ locked: z.boolean() }).strict();

@Controller({ version: '1' })
export class ViewsController {
  constructor(private readonly views: ViewsService) {}

  @Get('tables/:tableId/views')
  @RequiresAction('record:read')
  async list(@CurrentTenant() tenant: TenantContext, @Param('tableId') tableId: string) {
    return { data: await this.views.list(tenant, tableId) };
  }

  @Post('tables/:tableId/views')
  // Creating a view changes what the table looks like for everyone, so it needs schema rights
  // rather than record rights — except for personal views, which the service scopes to the owner.
  @RequiresAction('field:create')
  @RateLimit('authenticatedWrite')
  async create(
    @CurrentTenant() tenant: TenantContext,
    @Param('tableId') tableId: string,
    @Body(zodBody(createSchema)) input: z.infer<typeof createSchema>,
  ) {
    return { data: await this.views.create(tenant, tableId, input) };
  }

  @Get('views/:viewId')
  @RequiresAction('record:read')
  async get(@CurrentTenant() tenant: TenantContext, @Param('viewId') viewId: string) {
    return { data: await this.views.get(tenant, viewId) };
  }

  @Patch('views/:viewId')
  @RequiresAction('field:create')
  @RateLimit('authenticatedWrite')
  async update(
    @CurrentTenant() tenant: TenantContext,
    @Param('viewId') viewId: string,
    @Body(zodBody(updateSchema)) input: z.infer<typeof updateSchema>,
  ) {
    return { data: await this.views.update(tenant, viewId, input) };
  }

  @Delete('views/:viewId')
  @RequiresAction('field:delete')
  @RateLimit('authenticatedWrite')
  async remove(@CurrentTenant() tenant: TenantContext, @Param('viewId') viewId: string) {
    return { data: await this.views.remove(tenant, viewId) };
  }

  @Post('views/:viewId/lock')
  @RequiresAction('field:create')
  @RateLimit('authenticatedWrite')
  async setLocked(
    @CurrentTenant() tenant: TenantContext,
    @Param('viewId') viewId: string,
    @Body(zodBody(lockSchema)) input: z.infer<typeof lockSchema>,
  ) {
    return { data: await this.views.setLocked(tenant, viewId, input.locked) };
  }
}

import { Body, Controller, Delete, Get, Param, Post, Query } from '@nestjs/common';
import { automationSchema } from '@tessera/automations';
import type { TenantContext } from '@tessera/types';
import { z } from 'zod';

import { CurrentTenant, RateLimit, RequiresAction } from '../../bootstrap/decorators';
import { zodBody } from '../../bootstrap/zod.pipe';

import { AutomationsService } from './automations.service';

const createSchema = z
  .object({
    name: z.string().min(1).max(120),
    description: z.string().max(2_000).optional(),
    automation: automationSchema,
  })
  .strict();

const draftSchema = z.object({ automation: automationSchema }).strict();
const publishSchema = z.object({ versionId: z.string().max(30) }).strict();
const enableSchema = z.object({ enabled: z.boolean() }).strict();

@Controller({ version: '1' })
export class AutomationsController {
  constructor(private readonly automations: AutomationsService) {}

  @Get('bases/:baseId/automations')
  @RequiresAction('automation:read')
  async list(@CurrentTenant() tenant: TenantContext, @Param('baseId') baseId: string) {
    return { data: await this.automations.list(tenant, baseId) };
  }

  @Post('bases/:baseId/automations')
  @RequiresAction('automation:manage')
  @RateLimit('authenticatedWrite')
  async create(
    @CurrentTenant() tenant: TenantContext,
    @Param('baseId') baseId: string,
    @Body(zodBody(createSchema)) input: z.infer<typeof createSchema>,
  ) {
    return { data: await this.automations.create(tenant, baseId, input) };
  }

  @Post('automations/:automationId/versions')
  @RequiresAction('automation:manage')
  @RateLimit('authenticatedWrite')
  async saveDraft(
    @CurrentTenant() tenant: TenantContext,
    @Param('automationId') automationId: string,
    @Body(zodBody(draftSchema)) input: z.infer<typeof draftSchema>,
  ) {
    return { data: await this.automations.saveDraft(tenant, automationId, input.automation) };
  }

  @Post('automations/:automationId/publish')
  @RequiresAction('automation:manage')
  @RateLimit('authenticatedWrite')
  async publish(
    @CurrentTenant() tenant: TenantContext,
    @Param('automationId') automationId: string,
    @Body(zodBody(publishSchema)) input: z.infer<typeof publishSchema>,
  ) {
    return { data: await this.automations.publish(tenant, automationId, input.versionId) };
  }

  @Post('automations/:automationId/enabled')
  @RequiresAction('automation:manage')
  @RateLimit('authenticatedWrite')
  async setEnabled(
    @CurrentTenant() tenant: TenantContext,
    @Param('automationId') automationId: string,
    @Body(zodBody(enableSchema)) input: z.infer<typeof enableSchema>,
  ) {
    return { data: await this.automations.setEnabled(tenant, automationId, input.enabled) };
  }

  @Get('automations/:automationId/runs')
  @RequiresAction('automation:read')
  async runs(
    @CurrentTenant() tenant: TenantContext,
    @Param('automationId') automationId: string,
    @Query('limit') limit?: string,
  ) {
    const parsed = Number(limit);
    return {
      data: await this.automations.runs(
        tenant,
        automationId,
        Number.isFinite(parsed) && parsed > 0 ? parsed : undefined,
      ),
    };
  }

  @Delete('automations/:automationId')
  @RequiresAction('automation:manage')
  @RateLimit('authenticatedWrite')
  async remove(
    @CurrentTenant() tenant: TenantContext,
    @Param('automationId') automationId: string,
  ) {
    return { data: await this.automations.remove(tenant, automationId) };
  }
}

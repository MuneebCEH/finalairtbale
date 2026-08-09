import { Body, Controller, Delete, Get, Param, Patch, Post, Req } from '@nestjs/common';
import type { TenantContext } from '@tessera/types';
import { formConfigSchema } from '@tessera/views';
import type { Request } from 'express';
import { z } from 'zod';

import {
  CurrentTenant,
  Public,
  RateLimit,
  RequiresAction,
  SkipTenantScope,
} from '../../bootstrap/decorators';
import { zodBody } from '../../bootstrap/zod.pipe';

import { FormsService } from './forms.service';

const createSchema = z
  .object({
    name: z.string().min(1).max(120),
    title: z.string().min(1).max(255),
    description: z.string().max(2_000).optional(),
    config: formConfigSchema,
  })
  .strict();

const updateSchema = z
  .object({
    name: z.string().min(1).max(120).optional(),
    title: z.string().min(1).max(255).optional(),
    description: z.string().max(2_000).optional(),
    config: formConfigSchema.optional(),
    isPublished: z.boolean().optional(),
    submissionLimit: z.number().int().min(1).nullable().optional(),
    opensAt: z.string().datetime().nullable().optional(),
    closesAt: z.string().datetime().nullable().optional(),
  })
  .strict();

const submitSchema = z
  .object({
    // Values are validated against the form's own field list on the server, not here — the shape
    // is deliberately open because the field ids differ per form.
    values: z.record(z.unknown()),
    idempotencyKey: z.string().max(120).optional(),
  })
  .strict();

@Controller({ version: '1' })
export class FormsController {
  constructor(private readonly forms: FormsService) {}

  @Get('tables/:tableId/forms')
  @RequiresAction('record:read')
  async list(@CurrentTenant() tenant: TenantContext, @Param('tableId') tableId: string) {
    return { data: await this.forms.list(tenant, tableId) };
  }

  @Post('tables/:tableId/forms')
  @RequiresAction('field:create')
  @RateLimit('authenticatedWrite')
  async create(
    @CurrentTenant() tenant: TenantContext,
    @Param('tableId') tableId: string,
    @Body(zodBody(createSchema)) input: z.infer<typeof createSchema>,
  ) {
    return { data: await this.forms.create(tenant, tableId, input) };
  }

  @Patch('forms/:formId')
  @RequiresAction('field:create')
  @RateLimit('authenticatedWrite')
  async update(
    @CurrentTenant() tenant: TenantContext,
    @Param('formId') formId: string,
    @Body(zodBody(updateSchema)) input: z.infer<typeof updateSchema>,
  ) {
    return { data: await this.forms.update(tenant, formId, input) };
  }

  @Delete('forms/:formId')
  @RequiresAction('field:delete')
  @RateLimit('authenticatedWrite')
  async remove(@CurrentTenant() tenant: TenantContext, @Param('formId') formId: string) {
    return { data: await this.forms.remove(tenant, formId) };
  }
}

/**
 * The public surface.
 *
 * Separate, `@Public()` and tenant-exempt: these are the two endpoints an anonymous browser
 * reaches, and keeping them in their own controller makes that boundary visible rather than a
 * decorator buried among authenticated routes.
 */
@Controller({ path: 'f', version: '1' })
@Public()
@SkipTenantScope()
export class PublicFormsController {
  constructor(private readonly forms: FormsService) {}

  @Get(':slug')
  // Rate-limited by address even for a read: an unbounded public endpoint is a free way to
  // enumerate slugs and to make the database work on somebody else's behalf.
  @RateLimit('publicFormSubmit')
  async view(@Param('slug') slug: string) {
    return { data: await this.forms.publicView(slug) };
  }

  @Post(':slug/submit')
  @RateLimit('publicFormSubmit')
  async submit(
    @Param('slug') slug: string,
    @Body(zodBody(submitSchema)) input: z.infer<typeof submitSchema>,
    @Req() request: Request,
  ) {
    return {
      data: await this.forms.submit(slug, {
        values: input.values,
        ...(input.idempotencyKey ? { idempotencyKey: input.idempotencyKey } : {}),
        ...(request.ip ? { ipAddress: request.ip } : {}),
        ...(request.headers['user-agent'] ? { userAgent: request.headers['user-agent'] } : {}),
      }),
    };
  }
}

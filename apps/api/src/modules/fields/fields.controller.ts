import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post } from '@nestjs/common';
import type { FieldType, TenantContext } from '@tessera/types';
import {
  createFieldSchema,
  previewFieldChangeSchema,
  updateFieldSchema,
  type CreateFieldInput,
  type UpdateFieldInput,
} from '@tessera/validation';

import { CurrentTenant, RateLimit, RequiresAction } from '../../bootstrap/decorators';
import { zodBody } from '../../bootstrap/zod.pipe';

import { FieldsService } from './fields.service';

@Controller({ version: '1' })
export class FieldsController {
  constructor(private readonly fields: FieldsService) {}

  @Get('tables/:tableId/fields')
  @RequiresAction('base:read')
  @RateLimit('authenticatedRead')
  async list(@CurrentTenant() tenant: TenantContext, @Param('tableId') tableId: string) {
    return { data: await this.fields.list(tenant, tableId) };
  }

  @Post('tables/:tableId/fields')
  @RequiresAction('field:create')
  @RateLimit('authenticatedWrite')
  @HttpCode(201)
  async create(
    @CurrentTenant() tenant: TenantContext,
    @Param('tableId') tableId: string,
    @Body(zodBody(createFieldSchema)) input: CreateFieldInput,
  ) {
    return { data: await this.fields.create(tenant, tableId, input) };
  }

  /**
   * Dry-runs a type change.
   *
   * Deliberately a POST despite being read-only: the request carries a body describing the
   * proposed shape, and a GET with a JSON body is a request nobody's proxy handles predictably.
   */
  @Post('tables/:tableId/fields/:fieldId/preview-change')
  @RequiresAction('field:update')
  @RateLimit('authenticatedRead')
  @HttpCode(200)
  async previewChange(
    @CurrentTenant() tenant: TenantContext,
    @Param('fieldId') fieldId: string,
    @Body(zodBody(previewFieldChangeSchema))
    input: { type: FieldType; options?: Record<string, unknown> },
  ) {
    return { data: await this.fields.previewChange(tenant, fieldId, input) };
  }

  @Patch('tables/:tableId/fields/:fieldId')
  @RequiresAction('field:update')
  @RateLimit('authenticatedWrite')
  async update(
    @CurrentTenant() tenant: TenantContext,
    @Param('fieldId') fieldId: string,
    @Body(zodBody(updateFieldSchema)) input: UpdateFieldInput,
  ) {
    return { data: await this.fields.update(tenant, fieldId, input) };
  }

  @Delete('tables/:tableId/fields/:fieldId')
  @RequiresAction('field:delete')
  @RateLimit('authenticatedWrite')
  @HttpCode(204)
  async remove(@CurrentTenant() tenant: TenantContext, @Param('fieldId') fieldId: string) {
    await this.fields.delete(tenant, fieldId);
  }
}

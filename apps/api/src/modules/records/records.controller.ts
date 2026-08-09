import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post, Query } from '@nestjs/common';
import type { TenantContext } from '@tessera/types';
import {
  createRecordsSchema,
  deleteRecordsSchema,
  listRecordsSchema,
  updateRecordSchema,
  type CreateRecordsInput,
  type UpdateRecordInput,
} from '@tessera/validation';

import { CurrentTenant, RateLimit, RequiresAction } from '../../bootstrap/decorators';
import { zodBody } from '../../bootstrap/zod.pipe';

import { RecordsService } from './records.service';

@Controller({ version: '1' })
export class RecordsController {
  constructor(private readonly records: RecordsService) {}

  /**
   * Lists records.
   *
   * A GET with the query in the URL for simple cases, and a POST companion below for filter
   * trees — a nested AND/OR group does not fit in a query string without inventing an encoding,
   * and the encodings people invent are exactly where injection bugs live.
   */
  @Get('tables/:tableId/records')
  @RequiresAction('record:read')
  @RateLimit('authenticatedRead')
  async list(
    @CurrentTenant() tenant: TenantContext,
    @Param('tableId') tableId: string,
    @Query() query: Record<string, unknown>,
  ) {
    const parsed = listRecordsSchema.parse({
      limit: query['limit'] ?? 100,
      ...(query['cursor'] ? { cursor: query['cursor'] } : {}),
      ...(query['search'] ? { search: query['search'] } : {}),
      ...(query['fieldIds']
        ? { fieldIds: String(query['fieldIds']).split(',').filter(Boolean) }
        : {}),
    });
    return this.records.list(tenant, tableId, parsed);
  }

  @Post('tables/:tableId/records/query')
  @RequiresAction('record:read')
  @RateLimit('authenticatedRead')
  @HttpCode(200)
  async query(
    @CurrentTenant() tenant: TenantContext,
    @Param('tableId') tableId: string,
    @Body(zodBody(listRecordsSchema)) input: Record<string, unknown>,
  ) {
    return this.records.list(tenant, tableId, input as never);
  }

  @Get('tables/:tableId/records/:recordId')
  @RequiresAction('record:read')
  @RateLimit('authenticatedRead')
  async get(
    @CurrentTenant() tenant: TenantContext,
    @Param('tableId') tableId: string,
    @Param('recordId') recordId: string,
  ) {
    return { data: await this.records.get(tenant, tableId, recordId) };
  }

  @Post('tables/:tableId/records')
  @RequiresAction('record:create')
  @RateLimit('bulkWrite')
  @HttpCode(201)
  async create(
    @CurrentTenant() tenant: TenantContext,
    @Param('tableId') tableId: string,
    @Body(zodBody(createRecordsSchema)) input: CreateRecordsInput,
  ) {
    return { data: await this.records.createMany(tenant, tableId, input) };
  }

  @Patch('tables/:tableId/records/:recordId')
  @RequiresAction('record:update')
  @RateLimit('authenticatedWrite')
  async update(
    @CurrentTenant() tenant: TenantContext,
    @Param('tableId') tableId: string,
    @Param('recordId') recordId: string,
    @Body(zodBody(updateRecordSchema)) input: UpdateRecordInput,
  ) {
    return { data: await this.records.update(tenant, tableId, recordId, input) };
  }

  @Delete('tables/:tableId/records')
  @RequiresAction('record:delete')
  @RateLimit('bulkWrite')
  @HttpCode(200)
  async removeMany(
    @CurrentTenant() tenant: TenantContext,
    @Param('tableId') tableId: string,
    @Body(zodBody(deleteRecordsSchema)) input: { recordIds: string[] },
  ) {
    return { data: await this.records.deleteMany(tenant, tableId, input.recordIds) };
  }
}

import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post, Query } from '@nestjs/common';
import type { TenantContext } from '@tessera/types';
import {
  createBaseSchema,
  createTableSchema,
  deleteWorkspaceSchema,
  paginationSchema,
  updateBaseSchema,
  updateTableSchema,
  type CreateBaseInput,
  type CreateTableInput,
} from '@tessera/validation';

import { CurrentTenant, RateLimit, RequiresAction } from '../../bootstrap/decorators';
import { zodBody } from '../../bootstrap/zod.pipe';

import { BasesService } from './bases.service';

/**
 * Bases and tables.
 *
 * Collection routes hang off the parent (`/workspaces/:id/bases`, `/bases/:id/tables`) so the
 * tenant is unambiguous from the path; item routes are flat (`/bases/:baseId`) and let the
 * tenant guard resolve ownership by lookup, which is what stops a caller pairing their own
 * workspace id with somebody else's base.
 */
@Controller({ version: '1' })
export class BasesController {
  constructor(private readonly bases: BasesService) {}

  // ── Bases ─────────────────────────────────────────────────────────────────

  @Get('workspaces/:workspaceId/bases')
  @RequiresAction('base:read')
  @RateLimit('authenticatedRead')
  async list(
    @CurrentTenant() tenant: TenantContext,
    @Param('workspaceId') workspaceId: string,
    @Query() query: Record<string, unknown>,
  ) {
    const page = paginationSchema.parse(query);
    return this.bases.list(tenant, workspaceId, page);
  }

  @Post('workspaces/:workspaceId/bases')
  @RequiresAction('base:create')
  @RateLimit('authenticatedWrite')
  @HttpCode(201)
  async create(
    @CurrentTenant() tenant: TenantContext,
    @Param('workspaceId') workspaceId: string,
    @Body(zodBody(createBaseSchema)) input: CreateBaseInput,
  ) {
    return { data: await this.bases.create(tenant, workspaceId, input) };
  }

  @Get('bases/:baseId')
  @RequiresAction('base:read')
  @RateLimit('authenticatedRead')
  async get(@CurrentTenant() tenant: TenantContext, @Param('baseId') baseId: string) {
    return { data: await this.bases.get(tenant, baseId) };
  }

  @Patch('bases/:baseId')
  @RequiresAction('base:update')
  @RateLimit('authenticatedWrite')
  async update(
    @CurrentTenant() tenant: TenantContext,
    @Param('baseId') baseId: string,
    @Body(zodBody(updateBaseSchema)) input: Record<string, unknown>,
  ) {
    return { data: await this.bases.update(tenant, baseId, input) };
  }

  @Post('bases/:baseId/archive')
  @RequiresAction('base:update')
  @RateLimit('authenticatedWrite')
  @HttpCode(204)
  async archive(@CurrentTenant() tenant: TenantContext, @Param('baseId') baseId: string) {
    await this.bases.setArchived(tenant, baseId, true);
  }

  @Post('bases/:baseId/restore')
  @RequiresAction('base:update')
  @RateLimit('authenticatedWrite')
  @HttpCode(204)
  async restore(@CurrentTenant() tenant: TenantContext, @Param('baseId') baseId: string) {
    await this.bases.setArchived(tenant, baseId, false);
  }

  @Delete('bases/:baseId')
  @RequiresAction('base:delete')
  @RateLimit('authenticatedWrite')
  @HttpCode(204)
  async remove(
    @CurrentTenant() tenant: TenantContext,
    @Param('baseId') baseId: string,
    @Body(zodBody(deleteWorkspaceSchema)) input: { confirmation: string },
  ) {
    await this.bases.delete(tenant, baseId, input.confirmation);
  }

  // ── Tables ────────────────────────────────────────────────────────────────

  @Get('bases/:baseId/tables')
  @RequiresAction('base:read')
  @RateLimit('authenticatedRead')
  async listTables(@CurrentTenant() tenant: TenantContext, @Param('baseId') baseId: string) {
    return { data: await this.bases.listTables(tenant, baseId) };
  }

  @Post('bases/:baseId/tables')
  @RequiresAction('table:create')
  @RateLimit('authenticatedWrite')
  @HttpCode(201)
  async createTable(
    @CurrentTenant() tenant: TenantContext,
    @Param('baseId') baseId: string,
    @Body(zodBody(createTableSchema)) input: CreateTableInput,
  ) {
    return { data: await this.bases.createTable(tenant, baseId, input) };
  }

  @Get('tables/:tableId')
  @RequiresAction('base:read')
  @RateLimit('authenticatedRead')
  async getTable(@CurrentTenant() tenant: TenantContext, @Param('tableId') tableId: string) {
    return { data: await this.bases.getTable(tenant, tableId) };
  }

  @Patch('tables/:tableId')
  @RequiresAction('table:update')
  @RateLimit('authenticatedWrite')
  async updateTable(
    @CurrentTenant() tenant: TenantContext,
    @Param('tableId') tableId: string,
    @Body(zodBody(updateTableSchema)) input: Record<string, unknown>,
  ) {
    return { data: await this.bases.updateTable(tenant, tableId, input) };
  }

  @Delete('tables/:tableId')
  @RequiresAction('table:delete')
  @RateLimit('authenticatedWrite')
  @HttpCode(204)
  async deleteTable(
    @CurrentTenant() tenant: TenantContext,
    @Param('tableId') tableId: string,
    @Body(zodBody(deleteWorkspaceSchema)) input: { confirmation: string },
  ) {
    await this.bases.deleteTable(tenant, tableId, input.confirmation);
  }
}

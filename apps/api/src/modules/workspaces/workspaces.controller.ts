import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post, Query } from '@nestjs/common';
import type { TenantContext, WorkspaceRole } from '@tessera/types';
import {
  addWorkspaceMemberSchema,
  createWorkspaceSchema,
  deleteWorkspaceSchema,
  paginationSchema,
  updateWorkspaceSchema,
  type CreateWorkspaceInput,
} from '@tessera/validation';
import { z } from 'zod';

import { CurrentTenant, RateLimit, RequiresAction } from '../../bootstrap/decorators';
import { zodBody } from '../../bootstrap/zod.pipe';

import { WorkspacesService } from './workspaces.service';

const listQuerySchema = paginationSchema.extend({
  includeArchived: z
    .enum(['true', 'false'])
    .transform((v) => v === 'true')
    .optional(),
});

/**
 * Workspace endpoints under an organization.
 *
 * Collection routes live under `/organizations/:orgId/workspaces` so the tenant is unambiguous
 * from the path. Item routes use `/workspaces/:workspaceId` and let the tenant guard resolve the
 * owning organization by lookup — which means a caller cannot pair their own organization id
 * with somebody else's workspace id.
 */
@Controller({ version: '1' })
export class WorkspacesController {
  constructor(private readonly workspaces: WorkspacesService) {}

  // `workspace:list`, not `workspace:read`: this is the organization-scoped collection, and the
  // per-workspace filtering happens inside the query. Requiring the per-workspace permission
  // here would deny anybody who is not an organization administrator, including the people who
  // hold grants on individual workspaces — which is most users.
  @Get('organizations/:orgId/workspaces')
  @RequiresAction('workspace:list')
  @RateLimit('authenticatedRead')
  async list(@CurrentTenant() tenant: TenantContext, @Query() query: Record<string, unknown>) {
    const parsed = listQuerySchema.parse(query);
    return this.workspaces.list(tenant, parsed);
  }

  @Post('organizations/:orgId/workspaces')
  @RequiresAction('workspace:create')
  @RateLimit('authenticatedWrite')
  @HttpCode(201)
  async create(
    @CurrentTenant() tenant: TenantContext,
    @Body(zodBody(createWorkspaceSchema)) input: CreateWorkspaceInput,
  ) {
    return { data: await this.workspaces.create(tenant, input) };
  }

  @Get('workspaces/:workspaceId')
  @RequiresAction('workspace:read')
  @RateLimit('authenticatedRead')
  async get(
    @CurrentTenant() tenant: TenantContext,
    @Param('workspaceId') workspaceId: string,
  ) {
    return { data: await this.workspaces.get(tenant, workspaceId) };
  }

  @Patch('workspaces/:workspaceId')
  @RequiresAction('workspace:update')
  @RateLimit('authenticatedWrite')
  async update(
    @CurrentTenant() tenant: TenantContext,
    @Param('workspaceId') workspaceId: string,
    @Body(zodBody(updateWorkspaceSchema)) input: Record<string, unknown>,
  ) {
    return { data: await this.workspaces.update(tenant, workspaceId, input) };
  }

  @Post('workspaces/:workspaceId/archive')
  @RequiresAction('workspace:archive')
  @RateLimit('authenticatedWrite')
  @HttpCode(204)
  async archive(
    @CurrentTenant() tenant: TenantContext,
    @Param('workspaceId') workspaceId: string,
  ) {
    await this.workspaces.setArchived(tenant, workspaceId, true);
  }

  @Post('workspaces/:workspaceId/restore')
  @RequiresAction('workspace:archive')
  @RateLimit('authenticatedWrite')
  @HttpCode(204)
  async restore(
    @CurrentTenant() tenant: TenantContext,
    @Param('workspaceId') workspaceId: string,
  ) {
    await this.workspaces.setArchived(tenant, workspaceId, false);
  }

  @Delete('workspaces/:workspaceId')
  @RequiresAction('workspace:delete')
  @RateLimit('authenticatedWrite')
  @HttpCode(204)
  async remove(
    @CurrentTenant() tenant: TenantContext,
    @Param('workspaceId') workspaceId: string,
    @Body(zodBody(deleteWorkspaceSchema)) input: { confirmation: string },
  ) {
    await this.workspaces.delete(tenant, workspaceId, input.confirmation);
  }

  @Get('workspaces/:workspaceId/members')
  @RequiresAction('workspace:read')
  @RateLimit('authenticatedRead')
  async listMembers(
    @CurrentTenant() tenant: TenantContext,
    @Param('workspaceId') workspaceId: string,
  ) {
    return { data: await this.workspaces.listMembers(tenant, workspaceId) };
  }

  @Post('workspaces/:workspaceId/members')
  @RequiresAction('workspace:manage_members')
  @RateLimit('authenticatedWrite')
  @HttpCode(201)
  async addMember(
    @CurrentTenant() tenant: TenantContext,
    @Param('workspaceId') workspaceId: string,
    @Body(zodBody(addWorkspaceMemberSchema))
    input: { userId?: string; groupId?: string; role: WorkspaceRole },
  ) {
    await this.workspaces.addMember(tenant, workspaceId, input);
    return { data: { added: true } };
  }

  @Patch('workspaces/:workspaceId/members/:userId')
  @RequiresAction('workspace:manage_members')
  @RateLimit('authenticatedWrite')
  @HttpCode(204)
  async updateMemberRole(
    @CurrentTenant() tenant: TenantContext,
    @Param('workspaceId') workspaceId: string,
    @Param('userId') userId: string,
    @Body(zodBody(z.object({ role: z.string() }).strict())) input: { role: string },
  ) {
    await this.workspaces.updateMemberRole(
      tenant,
      workspaceId,
      { userId },
      input.role as WorkspaceRole,
    );
  }

  @Delete('workspaces/:workspaceId/members/:userId')
  @RequiresAction('workspace:manage_members')
  @RateLimit('authenticatedWrite')
  @HttpCode(204)
  async removeMember(
    @CurrentTenant() tenant: TenantContext,
    @Param('workspaceId') workspaceId: string,
    @Param('userId') userId: string,
  ) {
    await this.workspaces.removeMember(tenant, workspaceId, { userId });
  }
}

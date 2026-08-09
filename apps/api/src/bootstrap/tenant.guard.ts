import { Injectable, type CanActivate, type ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { extendContext } from '@tessera/logger';
import { AppError, NotFoundError, actingUserId, type TenantContext } from '@tessera/types';

import { PrismaService } from '../infrastructure/prisma.service';

import type { AuthenticatedRequest } from './auth.guard';
import { SKIP_TENANT_KEY } from './decorators';

/**
 * Resolves which tenant a request operates on, and proves the caller belongs to it.
 *
 * The organization is derived from the route, never from a client-supplied header or body field.
 * Nested resources (`/v1/workspaces/:id`, `/v1/bases/:id`) are resolved *upwards* to their owning
 * organization by a database lookup, so a caller cannot pair one organization's id with another
 * organization's resource.
 *
 * Failure is `404`, not `403`: telling somebody "this exists but is not yours" turns id
 * enumeration into a map of the platform.
 */
@Injectable()
export class TenantGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly prisma: PrismaService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const skip = this.reflector.getAllAndOverride<boolean>(SKIP_TENANT_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (skip) return true;

    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    const principal = request.principal;
    if (!principal) return true; // AuthGuard has already decided; nothing to scope.

    const ancestry = await this.resolveAncestry(request);
    if (!ancestry) {
      throw new AppError(
        'MALFORMED_REQUEST',
        'This endpoint requires an organization, workspace, base, or table in its path.',
      );
    }
    const organizationId = ancestry.organizationId;

    // Membership is proven here so that no handler can operate on an organization the caller has
    // no relationship with, whatever its own logic does.
    const userId = actingUserId(principal);
    if (userId) {
      const membership = await this.prisma.client.organizationMember.findUnique({
        where: { organizationId_userId: { organizationId, userId } },
        select: { status: true },
      });
      if (!membership) throw new NotFoundError('Organization', organizationId);
      if (membership.status !== 'active') {
        throw new AppError('FORBIDDEN', 'Your membership of this organization is suspended.');
      }
    }

    const tenant: TenantContext = {
      organizationId: ancestry.organizationId as never,
      ...(ancestry.workspaceId ? { workspaceId: ancestry.workspaceId as never } : {}),
      ...(ancestry.baseId ? { baseId: ancestry.baseId as never } : {}),
      principal,
      correlationId: request.correlationId,
    };

    request.tenant = tenant;
    request.ancestry = ancestry;
    extendContext({ organizationId });
    return true;
  }

  /**
   * Walks the containment chain upwards from whatever the route names.
   *
   * The full ancestry, not just the organization, because the policy engine resolves grants from
   * the most specific level down: a user whose only access is an editor grant on one base must
   * be allowed to edit records in it, and a route that names only `tableId` would otherwise
   * present the policy engine with no base to match that grant against.
   *
   * One query per request, at the point where the resource is being resolved for tenancy
   * anyway — the ancestry comes back in the same round trip that already had to happen.
   */
  private async resolveAncestry(request: AuthenticatedRequest): Promise<ResourceAncestry | null> {
    const params = request.params as Record<string, string | undefined>;

    /*
     * Leaf resources that carry their own id in the path and no ancestor.
     *
     * Every one of these was originally missing, and each time the symptom was the same and
     * misleading: the endpoint answered 400 "no organization in the path" rather than 403, so it
     * read as a malformed request rather than a scoping gap. Adding a route here is now part of
     * adding a top-level endpoint — a table rather than four more if-branches, so the next one is
     * a line instead of a copy.
     */
    const leafResource = async (): Promise<ResourceAncestry | null> => {
      if (params['automationId']) {
        const row = await this.prisma.client.automation.findFirst({
          where: { id: params['automationId'], deletedAt: null },
          select: { organizationId: true, baseId: true },
        });
        if (!row) throw new NotFoundError('Automation', params['automationId']);
        const base = await this.prisma.client.base.findFirst({
          where: { id: row.baseId },
          select: { workspaceId: true },
        });
        return {
          organizationId: row.organizationId,
          baseId: row.baseId,
          ...(base ? { workspaceId: base.workspaceId } : {}),
        };
      }

      if (params['formId']) {
        const row = await this.prisma.client.form.findFirst({
          where: { id: params['formId'], deletedAt: null },
          select: { organizationId: true, baseId: true },
        });
        if (!row) throw new NotFoundError('Form', params['formId']);
        const base = await this.prisma.client.base.findFirst({
          where: { id: row.baseId },
          select: { workspaceId: true },
        });
        return {
          organizationId: row.organizationId,
          baseId: row.baseId,
          ...(base ? { workspaceId: base.workspaceId } : {}),
        };
      }
      return null;
    };

    const leaf = await leafResource();
    if (leaf) return leaf;

    // A comment resolves through its record, and a record through its table. Both are listed
    // before the table branch because their routes carry no table id — without these, every
    // comment endpoint is rejected as "no organization in the path" rather than being scoped.
    if (params['commentId']) {
      const row = await this.prisma.client.comment.findFirst({
        where: { id: params['commentId'], deletedAt: null },
        select: { organizationId: true, baseId: true },
      });
      if (!row) throw new NotFoundError('Comment', params['commentId']);
      const base = await this.prisma.client.base.findFirst({
        where: { id: row.baseId },
        select: { workspaceId: true },
      });
      return {
        organizationId: row.organizationId,
        baseId: row.baseId,
        ...(base ? { workspaceId: base.workspaceId } : {}),
      };
    }

    if (params['viewId']) {
      const row = await this.prisma.client.view.findFirst({
        where: { id: params['viewId'], deletedAt: null },
        select: {
          organizationId: true,
          table: { select: { baseId: true, base: { select: { workspaceId: true } } } },
        },
      });
      if (!row) throw new NotFoundError('View', params['viewId']);
      return {
        organizationId: row.organizationId,
        baseId: row.table?.baseId,
        workspaceId: row.table?.base?.workspaceId,
      };
    }

    if (params['recordId']) {
      const row = await this.prisma.client.record.findFirst({
        where: { id: params['recordId'], deletedAt: null },
        select: { organizationId: true, tableId: true },
      });
      if (!row) throw new NotFoundError('Record', params['recordId']);
      const table = await this.prisma.client.table.findFirst({
        where: { id: row.tableId, deletedAt: null },
        select: { baseId: true, base: { select: { workspaceId: true } } },
      });
      return {
        organizationId: row.organizationId,
        ...(table ? { baseId: table.baseId, workspaceId: table.base?.workspaceId } : {}),
      };
    }

    if (params['tableId']) {
      const row = await this.prisma.client.table.findFirst({
        where: { id: params['tableId'], deletedAt: null },
        select: { organizationId: true, baseId: true, base: { select: { workspaceId: true } } },
      });
      if (!row) throw new NotFoundError('Table', params['tableId']);
      return {
        organizationId: row.organizationId,
        baseId: row.baseId,
        workspaceId: row.base?.workspaceId,
      };
    }

    if (params['baseId']) {
      const row = await this.prisma.client.base.findFirst({
        where: { id: params['baseId'], deletedAt: null },
        select: { organizationId: true, workspaceId: true },
      });
      if (!row) throw new NotFoundError('Base', params['baseId']);
      return {
        organizationId: row.organizationId,
        baseId: params['baseId'],
        workspaceId: row.workspaceId,
      };
    }

    if (params['workspaceId']) {
      const row = await this.prisma.client.workspace.findFirst({
        where: { id: params['workspaceId'], deletedAt: null },
        select: { organizationId: true },
      });
      if (!row) throw new NotFoundError('Workspace', params['workspaceId']);
      return { organizationId: row.organizationId, workspaceId: params['workspaceId'] };
    }

    if (params['orgId']) return { organizationId: params['orgId'] };

    return null;
  }
}

export interface ResourceAncestry {
  readonly organizationId: string;
  readonly workspaceId?: string | undefined;
  readonly baseId?: string | undefined;
}

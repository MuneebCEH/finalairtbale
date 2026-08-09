import { Injectable } from '@nestjs/common';
import {
  automationSchema,
  isAllowedRequestTarget,
  type Action,
  type Automation,
  type Trigger,
} from '@tessera/automations';
import { newId } from '@tessera/database';
import { AppError, actingUserId, type TenantContext } from '@tessera/types';

import { PrismaService } from '../../infrastructure/prisma.service';

/**
 * Automations.
 *
 * Versioned rather than edited in place. An automation that is running when somebody saves a
 * change must finish against the definition it started with — otherwise a half-executed run
 * switches rules mid-flight, and its own history describes something that never happened. Edits
 * create a draft version; publishing points the automation at it.
 */
@Injectable()
export class AutomationsService {
  constructor(private readonly prisma: PrismaService) {}

  async list(tenant: TenantContext, baseId: string) {
    const rows = await this.prisma.read.automation.findMany({
      where: { organizationId: tenant.organizationId, baseId, deletedAt: null },
      orderBy: { createdAt: 'asc' },
      include: { versions: { orderBy: { version: 'desc' }, take: 1 } },
    });

    return rows.map((row) => this.present(row));
  }

  async create(
    tenant: TenantContext,
    baseId: string,
    input: { name: string; description?: string; automation: Automation },
  ) {
    const userId = actingUserId(tenant.principal);
    if (!userId) throw new AppError('FORBIDDEN', 'Only a signed-in user can create an automation.');

    this.assertSafe(tenant, input.automation);

    const automationId = newId('automation');

    const row = await this.prisma.client.$transaction(async (tx) => {
      const automation = await tx.automation.create({
        data: {
          id: automationId,
          organizationId: tenant.organizationId,
          baseId,
          name: input.name,
          description: input.description ?? null,
          // Created disabled. An automation that starts running the moment it is saved gives its
          // author no chance to look at it first, and its first act is on real data.
          enabled: false,
          createdById: userId,
        },
      });

      const version = await tx.automationVersion.create({
        data: {
          id: newId('automation'),
          organizationId: tenant.organizationId,
          automationId,
          version: 1,
          trigger: input.automation.trigger as never,
          graph: { steps: input.automation.steps } as never,
          status: 'draft',
        },
      });

      return { ...automation, versions: [version] };
    });

    return this.present(row);
  }

  /** Saves a new draft version. The published one keeps running until this is published. */
  async saveDraft(tenant: TenantContext, automationId: string, automation: Automation) {
    const existing = await this.requireAutomation(tenant, automationId);
    this.assertSafe(tenant, automation);

    const last = await this.prisma.read.automationVersion.findFirst({
      where: { automationId, organizationId: tenant.organizationId },
      orderBy: { version: 'desc' },
      select: { version: true },
    });

    const version = await this.prisma.client.automationVersion.create({
      data: {
        id: newId('automation'),
        organizationId: tenant.organizationId,
        automationId: existing.id,
        version: (last?.version ?? 0) + 1,
        trigger: automation.trigger as never,
        graph: { steps: automation.steps } as never,
        status: 'draft',
      },
    });

    return { id: version.id, version: version.version, status: version.status };
  }

  async publish(tenant: TenantContext, automationId: string, versionId: string) {
    const existing = await this.requireAutomation(tenant, automationId);
    const userId = actingUserId(tenant.principal);

    const version = await this.prisma.read.automationVersion.findFirst({
      where: { id: versionId, automationId: existing.id, organizationId: tenant.organizationId },
    });
    if (!version) throw new AppError('NOT_FOUND', 'That version no longer exists.');

    // Re-validated at publish, not only at save: the base's tables and fields may have changed
    // since the draft was written, and publishing is the moment it becomes live.
    const parsed = automationSchema.safeParse({
      name: existing.name,
      trigger: version.trigger,
      steps: (version.graph as { steps: Action[] }).steps,
    });
    if (!parsed.success) {
      throw new AppError('VALIDATION_FAILED', 'This version is no longer valid and cannot be published.', {
        details: { issues: parsed.error.issues.map((issue) => issue.message) },
      });
    }
    this.assertSafe(tenant, parsed.data);

    await this.prisma.client.$transaction([
      this.prisma.client.automationVersion.update({
        where: { id: versionId },
        data: { status: 'published', publishedAt: new Date(), publishedById: userId },
      }),
      this.prisma.client.automation.update({
        where: { id: automationId },
        data: { activeVersionId: versionId },
      }),
    ]);

    return { published: true, versionId };
  }

  async setEnabled(tenant: TenantContext, automationId: string, enabled: boolean) {
    const existing = await this.requireAutomation(tenant, automationId);

    // Enabling something with no published version would arm a trigger that has nothing to run.
    if (enabled && !existing.activeVersionId) {
      throw new AppError('VALIDATION_FAILED', 'Publish a version before enabling this automation.');
    }

    await this.prisma.client.automation.update({
      where: { id: automationId },
      data: { enabled },
    });

    return { enabled };
  }

  async remove(tenant: TenantContext, automationId: string) {
    await this.requireAutomation(tenant, automationId);
    await this.prisma.client.automation.update({
      where: { id: automationId },
      data: { deletedAt: new Date(), enabled: false },
    });
    return { deleted: true };
  }

  /** Run history, newest first. The only way to find out why an automation did nothing. */
  async runs(tenant: TenantContext, automationId: string, limit = 50) {
    const existing = await this.requireAutomation(tenant, automationId);

    const rows = await this.prisma.read.automationRun.findMany({
      where: {
        organizationId: tenant.organizationId,
        version: { automationId: existing.id },
      },
      orderBy: { createdAt: 'desc' },
      take: Math.min(limit, 200),
    });

    return rows.map((row) => ({
      id: row.id,
      status: row.status,
      errorCode: row.errorCode,
      startedAt: row.startedAt?.toISOString() ?? null,
      finishedAt: row.finishedAt?.toISOString() ?? null,
      durationMs: row.durationMs,
      // Exposed because a run that was skipped for looping is otherwise indistinguishable from
      // one that never fired, and that is the single most confusing automation failure.
      causationChain: row.causationChain,
      createdAt: row.createdAt.toISOString(),
    }));
  }

  // ── Helpers ───────────────────────────────────────────────────────────────

  /**
   * Refuses an automation whose steps would reach somewhere they should not.
   *
   * The HTTP action is a server-side request composed by a user, so its target is checked before
   * the automation is stored — refusing at save time tells the author immediately, rather than
   * producing a run that fails every time it fires.
   */
  private assertSafe(tenant: TenantContext, automation: Automation): void {
    const check = (steps: readonly Action[]): void => {
      for (const step of steps) {
        if (step.type === 'httpRequest' && !isAllowedRequestTarget(step.url)) {
          throw new AppError('VALIDATION_FAILED', 'That address cannot be called from an automation.', {
            details: { url: step.url },
          });
        }
        if (step.type === 'condition' && step.then) check(step.then);
      }
    };

    check(automation.steps);
    void tenant;
  }

  private async requireAutomation(tenant: TenantContext, automationId: string) {
    const row = await this.prisma.read.automation.findFirst({
      where: { id: automationId, organizationId: tenant.organizationId, deletedAt: null },
    });
    if (!row) throw new AppError('NOT_FOUND', 'That automation no longer exists.');
    return row;
  }

  private present(row: {
    id: string;
    name: string;
    description: string | null;
    enabled: boolean;
    activeVersionId: string | null;
    createdAt: Date;
    updatedAt: Date;
    versions?: Array<{ id: string; version: number; status: string; trigger: unknown; graph: unknown }>;
  }) {
    const latest = row.versions?.[0];

    return {
      id: row.id,
      name: row.name,
      description: row.description,
      enabled: row.enabled,
      activeVersionId: row.activeVersionId,
      // `enabled` alone is misleading: an automation can be enabled and still not run because
      // nothing is published, so both facts travel together.
      isLive: row.enabled && row.activeVersionId !== null,
      latestVersion: latest
        ? {
            id: latest.id,
            version: latest.version,
            status: latest.status,
            trigger: latest.trigger as Trigger,
            steps: (latest.graph as { steps: Action[] }).steps,
          }
        : null,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    };
  }
}

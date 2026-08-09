import { createHash } from 'node:crypto';

import { Injectable } from '@nestjs/common';
import { generateSlug } from '@tessera/auth';
import { newId } from '@tessera/database';
import { AppError, actingUserId, type TenantContext } from '@tessera/types';
import {
  filterSubmission,
  formFieldIds,
  missingRequired,
  submissionState,
  type FormConfig,
} from '@tessera/views';

import { PrismaService } from '../../infrastructure/prisma.service';
import { RecordsService } from '../records/records.service';

/**
 * Forms: a public write surface onto a private table.
 *
 * The submission path deliberately does **not** reuse the authenticated record-create path's
 * trust assumptions. A signed-in user writing a record is bounded by their permissions; a form
 * submitter has none, so the boundary is the form's own field list, applied here on the server
 * (see `filterSubmission`). Everything else — validation, storage, audit — then goes through the
 * same record service, so a form cannot write something the API would refuse.
 */
@Injectable()
export class FormsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly records: RecordsService,
  ) {}

  async list(tenant: TenantContext, tableId: string) {
    const rows = await this.prisma.read.form.findMany({
      where: { organizationId: tenant.organizationId, tableId, deletedAt: null },
      orderBy: { createdAt: 'asc' },
    });
    return rows.map((row) => this.present(row));
  }

  async create(
    tenant: TenantContext,
    tableId: string,
    input: { name: string; title: string; description?: string; config: FormConfig },
  ) {
    const userId = actingUserId(tenant.principal);
    if (!userId) throw new AppError('FORBIDDEN', 'Only a signed-in user can create a form.');

    const table = await this.prisma.read.table.findFirst({
      where: { id: tableId, organizationId: tenant.organizationId, deletedAt: null },
      select: { baseId: true },
    });
    if (!table) throw new AppError('NOT_FOUND', 'That table no longer exists.');

    await this.assertFieldsExist(tenant, tableId, input.config);

    const row = await this.prisma.client.form.create({
      data: {
        id: newId('form'),
        organizationId: tenant.organizationId,
        baseId: table.baseId,
        tableId,
        name: input.name,
        // Unguessable rather than derived from the name: a slug like `job-application` invites
        // enumeration of every other form in the account.
        slug: generateSlug(16),
        title: input.title,
        description: input.description ?? null,
        config: input.config as never,
        createdById: userId,
      },
    });

    return this.present(row);
  }

  async update(
    tenant: TenantContext,
    formId: string,
    input: {
      name?: string;
      title?: string;
      description?: string;
      config?: FormConfig;
      isPublished?: boolean;
      submissionLimit?: number | null;
      opensAt?: string | null;
      closesAt?: string | null;
    },
  ) {
    const existing = await this.requireForm(tenant, formId);
    if (input.config) await this.assertFieldsExist(tenant, existing.tableId, input.config);

    const row = await this.prisma.client.form.update({
      where: { id: formId },
      data: {
        ...(input.name !== undefined ? { name: input.name } : {}),
        ...(input.title !== undefined ? { title: input.title } : {}),
        ...(input.description !== undefined ? { description: input.description } : {}),
        ...(input.config ? { config: input.config as never } : {}),
        ...(input.isPublished !== undefined ? { isPublished: input.isPublished } : {}),
        ...(input.submissionLimit !== undefined ? { submissionLimit: input.submissionLimit } : {}),
        ...(input.opensAt !== undefined ? { opensAt: input.opensAt ? new Date(input.opensAt) : null } : {}),
        ...(input.closesAt !== undefined ? { closesAt: input.closesAt ? new Date(input.closesAt) : null } : {}),
      },
    });

    return this.present(row);
  }

  async remove(tenant: TenantContext, formId: string) {
    await this.requireForm(tenant, formId);
    await this.prisma.client.form.update({ where: { id: formId }, data: { deletedAt: new Date() } });
    return { deleted: true };
  }

  /**
   * The public view of a form, by slug.
   *
   * Returns only what a stranger needs to render it — the field list, labels and rules — and
   * nothing about the table, the base or the organization. A closed form still resolves, with a
   * reason, so the page can say why rather than 404ing on something that plainly exists.
   */
  async publicView(slug: string) {
    const form = await this.prisma.read.form.findFirst({
      where: { slug, deletedAt: null },
      select: {
        id: true,
        title: true,
        description: true,
        config: true,
        isPublished: true,
        opensAt: true,
        closesAt: true,
        submissionLimit: true,
        submissionCount: true,
        requiresAuth: true,
        tableId: true,
        organizationId: true,
      },
    });

    // An unpublished form is not merely closed — it has never been public, so it must not be
    // distinguishable from one that does not exist.
    if (!form || !form.isPublished) throw new AppError('NOT_FOUND', 'There is no form at this address.');

    const state = submissionState(form);
    const config = form.config as FormConfig;

    // Field types travel with the form so the page can render the right input without a second
    // request that would have to be public too.
    const fields = await this.prisma.read.field.findMany({
      where: { tableId: form.tableId, id: { in: formFieldIds(config) }, deletedAt: null },
      select: { id: true, name: true, type: true, options: true },
    });

    return {
      title: form.title,
      description: form.description,
      config,
      fields,
      requiresAuth: form.requiresAuth,
      open: state.open,
      ...(state.open ? {} : { closedReason: state.reason }),
    };
  }

  /**
   * Accepts a submission.
   *
   * Everything a stranger sent is filtered against the form's own field list before anything is
   * written, and the record is then created through the ordinary record service so a form cannot
   * bypass validation, quotas or the audit log.
   */
  async submit(
    slug: string,
    input: {
      values: Record<string, unknown>;
      idempotencyKey?: string;
      ipAddress?: string;
      userAgent?: string;
    },
  ) {
    const form = await this.prisma.read.form.findFirst({
      where: { slug, deletedAt: null },
      select: {
        id: true,
        organizationId: true,
        tableId: true,
        config: true,
        isPublished: true,
        opensAt: true,
        closesAt: true,
        submissionLimit: true,
        submissionCount: true,
      },
    });

    if (!form || !form.isPublished) throw new AppError('NOT_FOUND', 'There is no form at this address.');

    const state = submissionState(form);
    if (!state.open) {
      throw new AppError('FORBIDDEN', 'This form is not accepting responses.', {
        details: { reason: state.reason },
      });
    }

    // A double-submitted form must not create two records. Checked before doing any work, and
    // enforced again by the unique index in case two requests race.
    if (input.idempotencyKey) {
      const seen = await this.prisma.read.formSubmission.findFirst({
        where: { formId: form.id, idempotencyKey: input.idempotencyKey },
        select: { recordId: true },
      });
      if (seen) return { recordId: seen.recordId, duplicate: true };
    }

    const config = form.config as FormConfig;
    const { accepted, rejected } = filterSubmission(config, input.values);

    const missing = missingRequired(config, accepted);
    if (missing.length > 0) {
      throw new AppError('VALIDATION_FAILED', 'Some required answers are missing.', {
        details: { missing },
      });
    }

    // The submission acts as the form's owner, because a stranger has no principal of their own.
    // Scoped to this one table by the tenant context that is built here rather than inherited.
    // `anonymous` is the principal the type system already has for exactly this — its own comment
    // names public form submissions. Inventing a `form` principal, as an earlier draft did, gets
    // past TypeScript through a cast and then fails inside the outbox writer, which reads the
    // principal type to attribute the event.
    const tenant: TenantContext = {
      organizationId: form.organizationId,
      principal: { type: 'anonymous', shareId: form.id },
    } as TenantContext;

    const created = await this.records.createMany(tenant, form.tableId, {
      records: [{ fields: accepted }],
      // Every value a form sends is a value it asked for, so this is a complete write, not a
      // partial patch — an omitted optional answer means blank, not "leave whatever was there".
      partial: false,
    });

    const recordId = created.records[0]?.id ?? null;

    await this.prisma.client.$transaction([
      this.prisma.client.formSubmission.create({
        data: {
          id: newId('event'),
          organizationId: form.organizationId,
          formId: form.id,
          recordId,
          // Hashed, not stored: the address is needed to rate-limit and to spot abuse, not to
          // identify a person who filled in a public form.
          ipHash: input.ipAddress ? createHash('sha256').update(input.ipAddress).digest('hex') : null,
          userAgent: input.userAgent?.slice(0, 1_000) ?? null,
          idempotencyKey: input.idempotencyKey ?? null,
          status: 'accepted',
          ...(rejected.length > 0 ? { errorDetail: { rejectedFields: rejected } as never } : {}),
        },
      }),
      this.prisma.client.form.update({
        where: { id: form.id },
        data: { submissionCount: { increment: 1 } },
      }),
    ]);

    return { recordId, duplicate: false };
  }

  // ── Helpers ───────────────────────────────────────────────────────────────

  private async assertFieldsExist(tenant: TenantContext, tableId: string, config: FormConfig) {
    const referenced = formFieldIds(config);
    if (referenced.length === 0) return;

    const found = await this.prisma.read.field.findMany({
      where: { organizationId: tenant.organizationId, tableId, id: { in: referenced }, deletedAt: null },
      select: { id: true, type: true },
    });

    const missing = referenced.filter((id) => !found.some((field) => field.id === id));
    if (missing.length > 0) {
      throw new AppError('VALIDATION_FAILED', 'This form refers to fields that are not in the table.', {
        details: { missing },
      });
    }

    // A computed field cannot be filled in by anyone, so putting one on a form produces an input
    // whose value is discarded — better refused while the form is being built.
    const computed = found.filter((field) =>
      ['formula', 'rollup', 'lookup', 'count', 'autoNumber', 'createdTime', 'lastModifiedTime'].includes(
        field.type,
      ),
    );
    if (computed.length > 0) {
      throw new AppError('VALIDATION_FAILED', 'A form cannot ask for a calculated field.', {
        details: { fields: computed.map((field) => field.id) },
      });
    }
  }

  private async requireForm(tenant: TenantContext, formId: string) {
    const form = await this.prisma.read.form.findFirst({
      where: { id: formId, organizationId: tenant.organizationId, deletedAt: null },
    });
    if (!form) throw new AppError('NOT_FOUND', 'That form no longer exists.');
    return form;
  }

  private present(row: {
    id: string;
    name: string;
    slug: string;
    title: string;
    description: string | null;
    config: unknown;
    isPublished: boolean;
    submissionCount: number;
    submissionLimit: number | null;
    opensAt: Date | null;
    closesAt: Date | null;
    createdAt: Date;
  }) {
    return {
      id: row.id,
      name: row.name,
      slug: row.slug,
      title: row.title,
      description: row.description,
      config: row.config,
      isPublished: row.isPublished,
      submissionCount: row.submissionCount,
      submissionLimit: row.submissionLimit,
      opensAt: row.opensAt?.toISOString() ?? null,
      closesAt: row.closesAt?.toISOString() ?? null,
      createdAt: row.createdAt.toISOString(),
    };
  }
}

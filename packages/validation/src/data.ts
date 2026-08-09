import { FIELD_TYPES } from '@tessera/types';
import { z } from 'zod';

import { colorSchema, descriptionSchema, displayNameSchema, idSchema } from './primitives';

/**
 * Request contracts for the data layer: bases, tables, fields and records.
 *
 * Every schema is `.strict()` for the same reason as the auth schemas — the parsed object is
 * what reaches the service, so a client cannot smuggle `organizationId`, `version` or
 * `promotedSlot` into a payload and have it persisted.
 */

// ── Bases ───────────────────────────────────────────────────────────────────

export const createBaseSchema = z
  .object({
    name: displayNameSchema,
    description: descriptionSchema.optional(),
    icon: z.string().max(64).optional(),
    color: colorSchema.optional(),
    /** Seeds the base from a template instead of leaving it empty. */
    templateId: idSchema('base').optional(),
  })
  .strict();
export type CreateBaseInput = z.infer<typeof createBaseSchema>;

export const updateBaseSchema = createBaseSchema.omit({ templateId: true }).partial().strict();

// ── Tables ──────────────────────────────────────────────────────────────────

export const createTableSchema = z
  .object({
    name: displayNameSchema,
    description: descriptionSchema.optional(),
    icon: z.string().max(64).optional(),
    color: colorSchema.optional(),
    /**
     * Optional initial fields. A table with no fields is useless, so when this is omitted the
     * service creates a single primary text field rather than leaving an unusable shell.
     */
    fields: z.array(z.lazy(() => createFieldSchema)).max(200).optional(),
  })
  .strict();
export type CreateTableInput = z.infer<typeof createTableSchema>;

export const updateTableSchema = z
  .object({
    name: displayNameSchema.optional(),
    description: descriptionSchema.optional(),
    icon: z.string().max(64).optional(),
    color: colorSchema.optional(),
    position: z.number().int().min(0).optional(),
  })
  .strict();

// ── Fields ──────────────────────────────────────────────────────────────────

export const createFieldSchema = z
  .object({
    name: displayNameSchema,
    type: z.enum(FIELD_TYPES),
    description: descriptionSchema.optional(),
    /** Type-specific configuration; validated against the field spec's own schema by the service. */
    options: z.record(z.unknown()).optional(),
    isRequired: z.boolean().optional(),
    isUnique: z.boolean().optional(),
    position: z.number().int().min(0).optional(),
  })
  .strict();
export type CreateFieldInput = z.infer<typeof createFieldSchema>;

export const updateFieldSchema = z
  .object({
    name: displayNameSchema.optional(),
    description: descriptionSchema.optional(),
    options: z.record(z.unknown()).optional(),
    isRequired: z.boolean().optional(),
    position: z.number().int().min(0).optional(),
    /**
     * Changing a field's type is a data migration, not an edit. The service refuses unless the
     * caller has previewed the change and echoes back the token from that preview — so a
     * destructive conversion cannot happen by accident or by a replayed request.
     */
    type: z.enum(FIELD_TYPES).optional(),
    migrationToken: z.string().max(128).optional(),
  })
  .strict()
  .refine((value) => value.type === undefined || value.migrationToken !== undefined, {
    message: 'changing a field type requires a migration token from the preview endpoint',
    path: ['migrationToken'],
  });
export type UpdateFieldInput = z.infer<typeof updateFieldSchema>;

export const previewFieldChangeSchema = z
  .object({
    type: z.enum(FIELD_TYPES),
    options: z.record(z.unknown()).optional(),
  })
  .strict();

// ── Records ─────────────────────────────────────────────────────────────────

/** `{ fieldId: value }`. Values are validated by the field registry, not here. */
export const recordFieldsSchema = z.record(z.unknown());

export const createRecordSchema = z
  .object({
    fields: recordFieldsSchema,
  })
  .strict();

export const createRecordsSchema = z
  .object({
    // Matches the public API's documented batch ceiling. Larger writes go through the import
    // pipeline, which is asynchronous and restartable.
    records: z.array(createRecordSchema).min(1).max(100),
    /** Fail the whole batch on any invalid row (default), or accept the valid ones. */
    partial: z.boolean().default(false),
  })
  .strict();
export type CreateRecordsInput = z.infer<typeof createRecordsSchema>;

export const updateRecordSchema = z
  .object({
    fields: recordFieldsSchema,
    /**
     * Optimistic concurrency. Omitting it opts into per-field last-write-wins, which is safe
     * because the update only touches the keys actually sent — two people editing two different
     * columns of one row never collide.
     */
    version: z.number().int().min(1).optional(),
  })
  .strict();
export type UpdateRecordInput = z.infer<typeof updateRecordSchema>;

export const updateRecordsSchema = z
  .object({
    records: z
      .array(
        z.object({
          id: idSchema('record'),
          fields: recordFieldsSchema,
          version: z.number().int().min(1).optional(),
        }),
      )
      .min(1)
      .max(100),
    partial: z.boolean().default(false),
  })
  .strict();

export const deleteRecordsSchema = z
  .object({ recordIds: z.array(idSchema('record')).min(1).max(100) })
  .strict();

// ── Queries ─────────────────────────────────────────────────────────────────

const filterConditionSchema = z.object({
  fieldId: z.string().min(1).max(40),
  operator: z.string().min(1).max(32),
  value: z.unknown().optional(),
});

type FilterGroupShape = {
  conjunction: 'and' | 'or';
  conditions: Array<z.infer<typeof filterConditionSchema> | FilterGroupShape>;
};

const filterGroupSchema: z.ZodType<FilterGroupShape> = z.lazy(() =>
  z.object({
    conjunction: z.enum(['and', 'or']),
    conditions: z.array(z.union([filterConditionSchema, filterGroupSchema])).max(100),
  }),
);

export const listRecordsSchema = z
  .object({
    filter: filterGroupSchema.optional(),
    sort: z
      .array(
        z.object({
          fieldId: z.string().min(1).max(40),
          direction: z.enum(['asc', 'desc']).default('asc'),
          nulls: z.enum(['first', 'last']).optional(),
        }),
      )
      .max(5)
      .optional(),
    group: z
      .array(
        z.object({
          fieldId: z.string().min(1).max(40),
          direction: z.enum(['asc', 'desc']).default('asc'),
        }),
      )
      .max(3)
      .optional(),
    fieldIds: z.array(z.string().min(1).max(40)).max(500).optional(),
    search: z.string().max(500).optional(),
    limit: z.coerce.number().int().min(1).max(1_000).default(100),
    cursor: z.string().max(2_048).optional(),
  })
  .strict();
export type ListRecordsInput = z.infer<typeof listRecordsSchema>;

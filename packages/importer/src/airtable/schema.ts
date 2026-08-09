import { z } from 'zod';

/**
 * The shape of an Airtable export.
 *
 * Modelled from the metadata API's responses. Validated on the way in rather than trusted:
 * a snapshot file is an external input, and an importer that assumes well-formed input produces
 * confusing failures halfway through a long load.
 */

export const airtableFieldSchema = z.object({
  id: z.string(),
  name: z.string(),
  type: z.string(),
  description: z.string().optional(),
  options: z.record(z.unknown()).optional(),
});

export type AirtableField = z.infer<typeof airtableFieldSchema>;

export const airtableTableSchema = z.object({
  id: z.string(),
  name: z.string(),
  primaryFieldId: z.string().optional(),
  description: z.string().optional(),
  fields: z.array(airtableFieldSchema),
});

export type AirtableTable = z.infer<typeof airtableTableSchema>;

/**
 * A record's cells.
 *
 * Airtable returns these under `fields` from the REST API and under `cellValuesByFieldId` from
 * the MCP surface. Both are accepted and normalised to `fields`, so a snapshot taken either way
 * loads without a conversion step — and nobody has to discover the difference at 300 records in.
 */
export const airtableRecordSchema = z
  .object({
    id: z.string(),
    createdTime: z.string().optional(),
    fields: z.record(z.unknown()).optional(),
    cellValuesByFieldId: z.record(z.unknown()).optional(),
  })
  .transform((record) => ({
    id: record.id,
    createdTime: record.createdTime,
    fields: record.fields ?? record.cellValuesByFieldId ?? {},
  }));

export type AirtableRecord = z.infer<typeof airtableRecordSchema>;

export const airtableBaseSchema = z.object({
  id: z.string(),
  name: z.string(),
  tables: z.array(airtableTableSchema),
});

export type AirtableBase = z.infer<typeof airtableBaseSchema>;

/**
 * A complete snapshot: schema plus records, keyed by table id.
 *
 * Records live outside the table objects so a snapshot can carry schema alone — which is the
 * default mode, and the one to use when the source contains data that should not be copied into
 * a development environment.
 */
export const airtableSnapshotSchema = z.object({
  takenAt: z.string(),
  bases: z.array(airtableBaseSchema),
  records: z.record(z.array(airtableRecordSchema)).default({}),
});

export type AirtableSnapshot = z.infer<typeof airtableSnapshotSchema>;

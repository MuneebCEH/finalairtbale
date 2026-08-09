import { inferSelectChoices, mapField, optionsFor, transformValue } from './airtable/mapping';
import type { AirtableBase, AirtableRecord, AirtableSnapshot, AirtableTable } from './airtable/schema';

/**
 * The import runner.
 *
 * Talks to Tessera through the same public API a browser uses — not through the database. That
 * is a deliberate constraint: it means the importer cannot bypass validation, permissions, plan
 * limits or the audit trail, so an import produces exactly the state a user typing the same data
 * would have produced. An importer that writes directly to Postgres is how a dataset ends up
 * violating invariants that the rest of the system assumes.
 */

export interface TesseraClient {
  /** Organizations the signed-in user belongs to. Used to resolve where workspaces are created. */
  listOrganizations(): Promise<Array<{ id: string; name: string; slug: string }>>;
  listWorkspaces(organizationId: string): Promise<Array<{ id: string; name: string }>>;
  createWorkspace(organizationId: string, input: { name: string }): Promise<{ id: string }>;
  createBase(workspaceId: string, input: { name: string; description?: string }): Promise<{ id: string }>;
  listTables(baseId: string): Promise<Array<{ id: string; name: string }>>;
  createTable(baseId: string, name: string): Promise<{ id: string }>;
  updateTable(tableId: string, name: string): Promise<void>;
  listFields(tableId: string): Promise<Array<{ id: string; name: string; type: string }>>;
  updateField(tableId: string, fieldId: string, input: { name: string }): Promise<void>;
  createField(
    tableId: string,
    input: { name: string; type: string; options?: Record<string, unknown> },
  ): Promise<{ id: string }>;
  createRecords(
    tableId: string,
    records: Array<{ fields: Record<string, unknown> }>,
  ): Promise<{ records: Array<{ id: string }> }>;
  /** Fetches a remote file and stores it as an attachment on the base. */
  ingestAttachment(
    baseId: string,
    input: { url: string; filename: string },
  ): Promise<{ id: string; filename: string; mimeType: string; size: number }>;
}

/**
 * The key a table's records are stored under in a snapshot.
 *
 * Airtable table ids are unique within a base, not across an account — copying a base preserves
 * them. Anything that holds records for more than one base must therefore qualify the table id
 * with the base id.
 */
export function recordKey(baseId: string, tableId: string): string {
  return `${baseId}::${tableId}`;
}

export interface ImportOptions {
  readonly workspaceId: string;
  /** Cap on records per table. `null` imports everything. */
  readonly recordLimit: number | null;
  /** Skip records entirely and import only the structure. */
  readonly schemaOnly: boolean;
  /**
   * Download attachment bytes and re-host them, rather than importing only file metadata.
   *
   * Off by default: it turns a fast metadata import into a bandwidth-bound one, and the source
   * URLs expire, so a long run can start failing partway through. Worth doing deliberately.
   */
  readonly withAttachments?: boolean;
  /** Records per API call. The public API's batch ceiling is 100. */
  readonly batchSize?: number;
  onProgress?(message: string): void;
}

export interface FieldReport {
  readonly table: string;
  readonly field: string;
  readonly sourceType: string;
  readonly targetType: string;
  readonly confidence: string;
  readonly note?: string;
}

export interface ImportReport {
  readonly baseName: string;
  readonly baseId: string;
  readonly tables: number;
  readonly fields: number;
  readonly records: number;
  readonly files: number;
  readonly fieldMappings: readonly FieldReport[];
  readonly warnings: readonly string[];
  readonly errors: readonly string[];
}

export async function importBase(
  client: TesseraClient,
  base: AirtableBase,
  recordsByTable: Readonly<Record<string, AirtableRecord[]>>,
  options: ImportOptions,
): Promise<ImportReport> {
  const report = {
    fieldMappings: [] as FieldReport[],
    warnings: [] as string[],
    errors: [] as string[],
    fields: 0,
    records: 0,
    files: 0,
  };

  const progress = options.onProgress ?? ((): void => undefined);
  const batchSize = Math.min(options.batchSize ?? 50, 100);

  progress(`Creating base "${base.name}"...`);
  const created = await client.createBase(options.workspaceId, {
    name: base.name,
    description: `Imported from Airtable base ${base.id}.`,
  });

  // A new base arrives with one starter table. The first source table reuses it rather than
  // leaving an empty "Table 1" behind for the user to clean up.
  const existing = await client.listTables(created.id);
  let starterTableId: string | null = existing[0]?.id ?? null;

  for (const table of base.tables) {
    progress(`  Table "${table.name}" (${table.fields.length} fields)`);

    let tableId: string;
    if (starterTableId) {
      tableId = starterTableId;
      await client.updateTable(tableId, table.name);
      starterTableId = null;
    } else {
      tableId = (await client.createTable(created.id, table.name)).id;
    }

    // Keyed by base *and* table, because Airtable table ids are not globally unique: duplicating
    // a base keeps every table id, so "Delta Medical portal Old" and its copy share all eleven.
    // A bare table-id lookup silently loads one base's records into the other's tables. The plain
    // id is still accepted so snapshots written before this fix keep working.
    const rows = recordsByTable[recordKey(base.id, table.id)] ?? recordsByTable[table.id] ?? [];
    const capped = options.recordLimit === null ? rows : rows.slice(0, options.recordLimit);

    // Fields are created from the records as well as the schema, so select columns get their
    // option lists inferred from the values actually present. Passing the rows the import is
    // about to write — rather than the full set — keeps the two consistent: every value that
    // lands has a matching option.
    const fieldIdMap = await importFields(client, tableId, table, capped, report);

    if (!options.schemaOnly) {
      if (options.withAttachments) {
        report.files += await transferAttachments(client, created.id, table, capped, report, progress);
      }
      report.records += await importRecords(client, tableId, table, capped, fieldIdMap, batchSize, report, progress);
    }
  }

  return {
    baseName: base.name,
    baseId: created.id,
    tables: base.tables.length,
    fields: report.fields,
    records: report.records,
    files: report.files,
    fieldMappings: report.fieldMappings,
    warnings: report.warnings,
    errors: report.errors,
  };
}

/**
 * Creates the target fields, returning a source-field-id -> target-field-id map.
 *
 * The starter table already has a primary field, which is renamed to match the source's primary
 * rather than left as "Name" beside a duplicate. The primary field cannot be deleted, so reusing
 * it is the only way to end up with the source's own column set and no stray extra.
 */
async function importFields(
  client: TesseraClient,
  tableId: string,
  table: AirtableTable,
  records: ReadonlyArray<{ fields: Record<string, unknown> }>,
  report: { fieldMappings: FieldReport[]; warnings: string[]; errors: string[]; fields: number },
): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  const existing = await client.listFields(tableId);
  let reusablePrimaryId: string | null = existing[0]?.id ?? null;

  // Import the primary field first so it becomes the table's label column.
  const ordered = [...table.fields].sort((a, b) => {
    if (a.id === table.primaryFieldId) return -1;
    if (b.id === table.primaryFieldId) return 1;
    return 0;
  });

  const usedNames = new Set<string>();

  for (const field of ordered) {
    const mapping = mapField(field);

    // Airtable permits two fields whose names differ only by trailing whitespace ("STATE " and
    // "STATE"); Tessera requires uniqueness after trimming, so collisions are suffixed rather
    // than allowed to fail the whole table.
    let name = field.name.trim() || 'Untitled field';
    if (usedNames.has(name.toLowerCase())) {
      let suffix = 2;
      while (usedNames.has(`${name} ${suffix}`.toLowerCase())) suffix += 1;
      report.warnings.push(`"${table.name}": duplicate field name "${name}" imported as "${name} ${suffix}"`);
      name = `${name} ${suffix}`;
    }
    usedNames.add(name.toLowerCase());

    report.fieldMappings.push({
      table: table.name,
      field: name,
      sourceType: field.type,
      targetType: mapping.type,
      confidence: mapping.confidence,
      ...(mapping.note ? { note: mapping.note } : {}),
    });

    try {
      if (reusablePrimaryId) {
        // The starter primary field is text; the source primary is almost always text too.
        // Renaming it keeps the table's label column meaningful without a type migration.
        await client.updateField(tableId, reusablePrimaryId, { name });
        map.set(field.id, reusablePrimaryId);
        reusablePrimaryId = null;
      } else {
        const isSelect = field.type === 'singleSelect' || field.type === 'multipleSelects';
        const options = isSelect ? inferSelectChoices(field, records) : optionsFor(field);

        if (isSelect && (options['choices'] as unknown[]).length === 0) {
          // A select column with no values anywhere in the imported rows has nothing to infer
          // from. Creating it with an empty option list would make it unusable — any later edit
          // would be rejected — so it becomes text and the substitution is reported.
          report.warnings.push(
            `"${table.name}" / "${name}": no values present, imported as text instead of a select`,
          );
          const target = await client.createField(tableId, { name, type: 'singleLineText' });
          map.set(field.id, target.id);
          report.fields += 1;
          continue;
        }

        const target = await client.createField(tableId, {
          name,
          type: mapping.type,
          ...(Object.keys(options).length > 0 ? { options } : {}),
        });
        map.set(field.id, target.id);
      }
      report.fields += 1;
    } catch (error) {
      // One bad field must not abandon the table. The column is skipped, recorded, and the rest
      // of the import proceeds — a partial table the user can inspect beats no table at all.
      report.errors.push(
        `"${table.name}" / "${name}" (${field.type}): ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  return map;
}

/**
 * Downloads each attachment and rewrites the record's cell to point at the re-hosted file.
 *
 * Mutates the record objects in place, so the record pass that follows writes the new ids rather
 * than the source's. Done as a separate pass before records are written because a file that
 * fails to transfer should leave the record importable without it, not block the row.
 *
 * Failures are per file: an expired URL costs that one attachment and is reported, because a
 * long import will always outlive some of its source links and aborting the run over one dead
 * file would waste everything already transferred.
 */
async function transferAttachments(
  client: TesseraClient,
  baseId: string,
  table: AirtableTable,
  records: ReadonlyArray<AirtableRecord>,
  report: { warnings: string[]; errors: string[] },
  progress: (message: string) => void,
): Promise<number> {
  const attachmentFields = table.fields.filter((field) => field.type === 'multipleAttachments');
  if (attachmentFields.length === 0) return 0;

  let transferred = 0;
  let attempted = 0;

  for (const record of records) {
    for (const field of attachmentFields) {
      const value = record.fields[field.id];
      if (!Array.isArray(value) || value.length === 0) continue;

      const rehosted: Array<Record<string, unknown>> = [];

      for (const file of value) {
        const source = file as Record<string, unknown>;
        const url = typeof source['url'] === 'string' ? source['url'] : null;
        const filename = String(source['filename'] ?? 'file');

        if (!url) {
          report.warnings.push(`"${table.name}": "${filename}" had no download URL in the snapshot`);
          continue;
        }

        attempted += 1;
        try {
          const stored = await client.ingestAttachment(baseId, { url, filename });
          rehosted.push({
            id: stored.id,
            filename: stored.filename,
            mimeType: stored.mimeType,
            size: stored.size,
          });
          transferred += 1;
          if (transferred % 5 === 0) progress(`    ${transferred}/${attempted} files transferred`);
        } catch (error) {
          report.errors.push(
            `"${table.name}": file "${filename}" not transferred - ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      }

      record.fields[field.id] = rehosted;
    }
  }

  if (attempted > 0) progress(`    ${transferred}/${attempted} files transferred`);
  return transferred;
}

async function importRecords(
  client: TesseraClient,
  tableId: string,
  table: AirtableTable,
  records: readonly AirtableRecord[],
  fieldIdMap: ReadonlyMap<string, string>,
  batchSize: number,
  report: { warnings: string[]; errors: string[] },
  progress: (message: string) => void,
): Promise<number> {
  if (records.length === 0) return 0;

  const byName = new Map(table.fields.map((field) => [field.name, field]));
  const byId = new Map(table.fields.map((field) => [field.id, field]));

  const rows = records.map((record) => {
    const fields: Record<string, unknown> = {};

    for (const [key, rawValue] of Object.entries(record.fields)) {
      // Exports key cells by field id or by field name depending on the endpoint used; both are
      // accepted so a snapshot from either source loads without a conversion step.
      const source = byId.get(key) ?? byName.get(key);
      if (!source) continue;

      const targetId = fieldIdMap.get(source.id);
      if (!targetId) continue; // the field failed to import; skip its values rather than error

      const value = transformValue(source, rawValue);
      if (value !== undefined) fields[targetId] = value;
    }

    return { fields };
  });

  let imported = 0;
  for (let index = 0; index < rows.length; index += batchSize) {
    const batch = rows.slice(index, index + batchSize);
    try {
      const result = await client.createRecords(tableId, batch);
      imported += result.records.length;
      progress(`    ${imported}/${rows.length} records`);
    } catch {
      // Retry the batch one row at a time so a single malformed record costs one record, not
      // fifty. The batch error itself is not recorded: it is a rollup of whatever the per-row
      // pass is about to report individually, and duplicating it would bury the useful detail.
      for (const row of batch) {
        try {
          await client.createRecords(tableId, [row]);
          imported += 1;
        } catch (rowError) {
          const message = rowError instanceof Error ? rowError.message : String(rowError);
          const rejected = rejectedFieldIds(message);

          // A record is worth more than a cell. Airtable validates several types far more loosely
          // than Tessera does — its phone field is free text, so "n/a" or a fragment of a number
          // lives happily there and fails here. Dropping the whole row over one such cell loses a
          // patient; dropping the cell loses a phone number that was already not a phone number.
          if (rejected.length > 0) {
            const retry = { fields: { ...row.fields } };
            for (const fieldId of rejected) delete retry.fields[fieldId];

            try {
              await client.createRecords(tableId, [retry]);
              imported += 1;
              report.warnings.push(
                `"${table.name}": kept a record but dropped ${rejected.length} cell(s) the target type rejected - ${message}`,
              );
              continue;
            } catch {
              // Fall through to the error below: retrying without the offending cells did not
              // help, so the problem is something else and the record genuinely cannot land.
            }
          }

          report.errors.push(`"${table.name}": record skipped - ${message}`);
        }
      }
    }
  }

  return imported;
}

/**
 * Pulls the field ids out of a validation error.
 *
 * The API reports issues as `records[0].fields.<fieldId>: <reason>`, which the client formats
 * into the message. Reading them back is admittedly parsing a string, but the alternative —
 * threading a structured error through the client interface — buys nothing here: a miss simply
 * means the record is reported as skipped, which is the behaviour this replaced.
 */
function rejectedFieldIds(message: string): string[] {
  return [...message.matchAll(/records\[\d+\]\.fields\.(fld_[0-9A-HJKMNP-TV-Z]{26})/g)].map(
    (match) => match[1] as string,
  );
}

export function summarise(reports: readonly ImportReport[]): string {
  const lines: string[] = ['', '='.repeat(64), 'Import summary', '='.repeat(64)];

  for (const report of reports) {
    lines.push(
      '',
      `${report.baseName}  ->  ${report.baseId}`,
      `  ${report.tables} tables, ${report.fields} fields, ${report.records} records, ${report.files} files`,
    );

    const lossy = report.fieldMappings.filter((mapping) => mapping.confidence !== 'exact');
    if (lossy.length > 0) {
      lines.push(`  ${lossy.length} field(s) needed an approximate mapping:`);
      for (const mapping of lossy.slice(0, 12)) {
        lines.push(`    - ${mapping.table}.${mapping.field}: ${mapping.sourceType} -> ${mapping.targetType}${mapping.note ? ` (${mapping.note})` : ''}`);
      }
      if (lossy.length > 12) lines.push(`    ... and ${lossy.length - 12} more`);
    }

    for (const warning of report.warnings.slice(0, 8)) lines.push(`  warning: ${warning}`);
    for (const error of report.errors.slice(0, 8)) lines.push(`  error:   ${error}`);
    if (report.errors.length > 8) lines.push(`  ... and ${report.errors.length - 8} more errors`);
  }

  lines.push('', '='.repeat(64), '');
  return lines.join('\n');
}

export type { AirtableSnapshot };

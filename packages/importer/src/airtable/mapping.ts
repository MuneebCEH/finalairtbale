import type { FieldType } from '@tessera/types';

import type { AirtableField } from './schema';

/**
 * Airtable field type -> Tessera field type.
 *
 * This is the heart of the importer, and the place where an import quietly loses data if it is
 * careless. Three rules govern every entry:
 *
 *  1. **Never silently downgrade a value.** Where the target type cannot hold the source value,
 *     the mapping falls back to a type that can (usually long text) and records a note, rather
 *     than truncating.
 *  2. **Computed stays computed, or becomes data.** Airtable formulas and rollups have no
 *     equivalent until the formula engine lands, so their *current values* are imported as plain
 *     data and flagged. That preserves what the user can see today; it does not pretend the
 *     formula came across.
 *  3. **Unknown types are reported, not dropped.** A type this table has never heard of becomes
 *     long text with a warning, because losing a column silently is the worst possible outcome.
 */

export type MappingConfidence = 'exact' | 'lossy' | 'fallback';

export interface FieldMapping {
  readonly type: FieldType;
  readonly confidence: MappingConfidence;
  /** Surfaced in the import report; empty when the mapping is exact. */
  readonly note?: string;
  /** Builds the Tessera field options from the Airtable field definition. */
  buildOptions?(field: AirtableField): Record<string, unknown>;
}

const AS = (type: FieldType, confidence: MappingConfidence = 'exact', note?: string): FieldMapping =>
  note === undefined ? { type, confidence } : { type, confidence, note };

/** Airtable's select options carry ids, names and colours; ours carry ids, labels and positions. */
function selectOptions(field: AirtableField): Record<string, unknown> {
  const raw = (field.options?.['choices'] as Array<Record<string, unknown>> | undefined) ?? [];
  return {
    choices: raw.map((choice, index) => ({
      // The Airtable option id is preserved, so a record's stored value transfers unchanged and
      // a re-import is idempotent rather than creating duplicate options.
      id: String(choice['id'] ?? `opt_${index}`),
      label: String(choice['name'] ?? `Option ${index + 1}`),
      position: index,
      ...(typeof choice['color'] === 'string' ? { color: airtableColour(choice['color']) } : {}),
    })),
    allowNewOptions: false,
  };
}

/**
 * Derives select choices from the records themselves.
 *
 * Airtable's table listing returns field *types* but not their option lists — those need a
 * separate metadata call per field, and a base with fifty select columns would need fifty of
 * them before a single row could be written.
 *
 * The cell values already carry everything needed: each one is `{ id, name, color }`. Walking
 * the records once yields the exact option set that is actually in use, with its original ids
 * and colours intact. Options nobody has used are absent, which is a real (and usually welcome)
 * difference from the source, and it is reported rather than hidden.
 */
export function inferSelectChoices(
  field: AirtableField,
  records: ReadonlyArray<{ fields: Record<string, unknown> }>,
): Record<string, unknown> {
  const declared = (field.options?.['choices'] as Array<Record<string, unknown>> | undefined) ?? [];
  if (declared.length > 0) return selectOptions(field);

  const seen = new Map<string, { id: string; label: string; color?: string }>();

  const observe = (value: unknown): void => {
    if (value === null || value === undefined) return;

    if (typeof value === 'object') {
      const choice = value as Record<string, unknown>;
      const id = String(choice['id'] ?? choice['name'] ?? '');
      const label = String(choice['name'] ?? id);
      if (!id || seen.has(id)) return;
      seen.set(id, {
        id,
        label,
        ...(typeof choice['color'] === 'string' ? { color: airtableColour(choice['color']) } : {}),
      });
      return;
    }

    // A bare string: use it as both id and label so the record's stored value still resolves.
    const text = String(value).trim();
    if (text && !seen.has(text)) seen.set(text, { id: text, label: text });
  };

  for (const record of records) {
    const value = record.fields[field.id];
    if (Array.isArray(value)) value.forEach(observe);
    else observe(value);
  }

  return {
    choices: [...seen.values()]
      // Alphabetical, since the source's own ordering is not available here. Stable across runs,
      // which matters because the position becomes the sort key.
      .sort((a, b) => a.label.localeCompare(b.label))
      .map((choice, index) => ({ ...choice, position: index })),
    allowNewOptions: false,
  };
}

function numberOptions(field: AirtableField): Record<string, unknown> {
  const precision = field.options?.['precision'];
  return { precision: typeof precision === 'number' ? Math.min(precision, 8) : 2 };
}

function currencyOptions(field: AirtableField): Record<string, unknown> {
  const symbol = field.options?.['symbol'];
  return {
    ...numberOptions(field),
    currencyCode: CURRENCY_BY_SYMBOL[String(symbol ?? '$')] ?? 'USD',
  };
}

const CURRENCY_BY_SYMBOL: Readonly<Record<string, string>> = {
  $: 'USD',
  '£': 'GBP',
  '€': 'EUR',
  '¥': 'JPY',
  '₹': 'INR',
  '₨': 'PKR',
};

export const FIELD_MAPPINGS: Readonly<Record<string, FieldMapping>> = {
  // ── Exact ──
  singleLineText: AS('singleLineText'),
  multilineText: AS('longText'),
  richText: AS('longText', 'lossy', 'rich text formatting is imported as plain text'),
  email: AS('email'),
  url: AS('url'),
  phoneNumber: AS('phone'),
  checkbox: AS('checkbox'),
  date: AS('date'),
  dateTime: AS('dateTime'),
  duration: AS('duration'),
  barcode: AS('barcode'),
  rating: { ...AS('rating'), buildOptions: (field) => ({ max: (field.options?.['max'] as number) ?? 5 }) },
  percent: { ...AS('percent'), buildOptions: numberOptions },
  currency: { ...AS('currency'), buildOptions: currencyOptions },
  number: { ...AS('decimal'), buildOptions: numberOptions },
  singleSelect: { ...AS('singleSelect'), buildOptions: selectOptions },
  multipleSelects: { ...AS('multipleSelect'), buildOptions: selectOptions },
  multipleAttachments: AS('attachment', 'lossy', 'file contents are not copied; only names and sizes'),
  singleCollaborator: AS(
    'singleLineText',
    'fallback',
    'collaborators become text until the user directory is mapped',
  ),
  multipleCollaborators: AS(
    'longText',
    'fallback',
    'collaborators become text until the user directory is mapped',
  ),

  // ── Airtable-specific text ──
  aiText: AS('longText', 'lossy', 'AI-generated summary imported as its current text'),

  // ── Computed: current values only ──
  formula: AS('longText', 'lossy', 'formula result imported as a static value; the formula is not recreated'),
  rollup: AS('longText', 'lossy', 'rollup result imported as a static value'),
  count: AS('decimal', 'lossy', 'count result imported as a static number'),
  lookup: AS('longText', 'lossy', 'lookup result imported as a static value'),
  multipleLookupValues: AS('longText', 'lossy', 'lookup result imported as a static value'),
  autoNumber: AS('decimal', 'lossy', 'source auto-numbers imported as plain numbers to preserve them'),
  createdTime: AS('dateTime', 'lossy', 'imported as data; the target has its own created time'),
  lastModifiedTime: AS('dateTime', 'lossy', 'imported as data; the target has its own modified time'),
  createdBy: AS('singleLineText', 'fallback', 'imported as text'),
  lastModifiedBy: AS('singleLineText', 'fallback', 'imported as text'),

  // ── Relational: deferred ──
  multipleRecordLinks: AS(
    'longText',
    'fallback',
    'linked records are imported as their display text; real links arrive with Phase 3',
  ),

  // ── Other ──
  button: AS('longText', 'fallback', 'buttons have no stored value; imported as empty text'),
  externalSyncSource: AS('singleLineText', 'fallback', 'sync source imported as text'),
};

export function mapField(field: AirtableField): FieldMapping {
  return (
    FIELD_MAPPINGS[field.type] ??
    AS('longText', 'fallback', `unrecognised Airtable type "${field.type}"; imported as text`)
  );
}

export function optionsFor(field: AirtableField): Record<string, unknown> {
  const mapping = mapField(field);
  return mapping.buildOptions?.(field) ?? {};
}

/**
 * Airtable colour names -> hex.
 *
 * Approximate rather than exact, and deliberately so: the point is that a status column looks
 * recognisably like it did in the source, not that the hex matches to the byte.
 */
function airtableColour(name: string): string {
  const base = name.replace(/(Light|Bright|Dark)\d?$/i, '').toLowerCase();
  const palette: Record<string, string> = {
    blue: '#2563eb',
    cyan: '#0891b2',
    teal: '#0d7377',
    green: '#168054',
    yellow: '#b46a0c',
    orange: '#c2410c',
    red: '#be2c37',
    pink: '#db2777',
    purple: '#7c3aed',
    gray: '#64748b',
    grey: '#64748b',
  };
  return palette[base] ?? '#64748b';
}

// ── Value transformation ────────────────────────────────────────────────────

/**
 * Converts one Airtable cell value into the shape the target field expects.
 *
 * Returns `undefined` for values that should be omitted entirely rather than written as null —
 * the distinction matters, because writing null to a required field fails while omitting it
 * lets the record through.
 */
export function transformValue(field: AirtableField, value: unknown): unknown {
  if (value === null || value === undefined || value === '') return undefined;

  const mapping = mapField(field);

  switch (field.type) {
    case 'singleSelect': {
      // Airtable returns either a plain name or `{ id, name, color }` depending on the endpoint.
      if (typeof value === 'object') {
        const record = value as Record<string, unknown>;
        return String(record['id'] ?? record['name'] ?? '');
      }
      return String(value);
    }

    case 'multipleSelects': {
      const items = Array.isArray(value) ? value : [value];
      return items.map((item) =>
        typeof item === 'object' && item !== null
          ? String((item as Record<string, unknown>)['id'] ?? (item as Record<string, unknown>)['name'] ?? '')
          : String(item),
      );
    }

    case 'multipleAttachments': {
      const files = Array.isArray(value) ? value : [];
      // Metadata only. The bytes live behind expiring Airtable URLs; copying them is a separate
      // job with its own retry and virus-scan pipeline, not something to do inline in a schema
      // import where a failure would abort the whole load.
      return files.map((file, index) => {
        const record = file as Record<string, unknown>;
        return {
          id: String(record['id'] ?? `att_${index}`),
          filename: String(record['filename'] ?? 'file'),
          mimeType: String(record['type'] ?? 'application/octet-stream'),
          size: Number(record['size'] ?? 0),
          // Carried through only so the attachment-transfer pass can fetch the bytes. It is
          // replaced by the re-hosted id before the record is written, and never persisted:
          // Airtable's URLs are signed and expire within hours.
          ...(typeof record['url'] === 'string' ? { url: record['url'] } : {}),
        };
      });
    }

    case 'singleCollaborator':
    case 'createdBy':
    case 'lastModifiedBy': {
      if (typeof value !== 'object' || value === null) return String(value);
      const record = value as Record<string, unknown>;
      return String(record['name'] ?? record['email'] ?? record['id'] ?? '');
    }

    case 'multipleCollaborators': {
      const items = Array.isArray(value) ? value : [];
      return items
        .map((item) => {
          const record = item as Record<string, unknown>;
          return String(record['name'] ?? record['email'] ?? '');
        })
        .join(', ');
    }

    case 'multipleRecordLinks': {
      const items = Array.isArray(value) ? value : [];
      // Display text, not ids: a bare `recXXXX` in a text column tells the user nothing, and the
      // real relationship is recreated in Phase 3 from the source ids kept in the report.
      return items
        .map((item) =>
          typeof item === 'object' && item !== null
            ? String((item as Record<string, unknown>)['name'] ?? '')
            : String(item),
        )
        .filter(Boolean)
        .join(', ');
    }

    case 'button':
      return undefined;

    case 'formula':
    case 'rollup':
    case 'lookup':
    case 'multipleLookupValues': {
      if (Array.isArray(value)) return value.map(String).join(', ');
      if (typeof value === 'object') return JSON.stringify(value);
      return mapping.type === 'decimal' ? Number(value) : String(value);
    }

    case 'checkbox':
      return value === true;

    default:
      if (typeof value === 'object') return JSON.stringify(value);
      return value;
  }
}

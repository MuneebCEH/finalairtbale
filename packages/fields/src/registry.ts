import { AppError, type FieldType } from '@tessera/types';

import type { FieldContext, FieldTypeSpec, ParseResult } from './spec';
import { multipleSelect, singleSelect, status } from './types/choice';
import { checkbox, currency, decimal, duration, number, percent, progress, rating } from './types/numeric';
import { count, linkedRecord, lookup, rollup } from './types/relational';
import {
  attachment,
  autoNumber,
  createdBy,
  createdTime,
  json,
  lastModifiedBy,
  lastModifiedTime,
  multipleUsers,
  recordId,
  user,
} from './types/system';
import { date, dateTime } from './types/temporal';
import { barcode, email, longText, phone, singleLineText, url } from './types/text';

/**
 * The field-type registry.
 *
 * One lookup table, consulted by every layer. The `satisfies` clause is doing real work: it
 * forces the map to be exhaustive over the registered keys and each value to match its
 * declared type, so a spec whose `type` disagrees with its key is a compile error rather than a
 * runtime surprise on one code path.
 */
const SPECS = {
  linkedRecord,
  lookup,
  rollup,
  count,
  singleLineText,
  longText,
  email,
  url,
  phone,
  barcode,
  number,
  decimal,
  currency,
  percent,
  rating,
  progress,
  duration,
  checkbox,
  singleSelect,
  multipleSelect,
  status,
  date,
  dateTime,
  user,
  multipleUsers,
  attachment,
  json,
  autoNumber,
  recordId,
  createdTime,
  lastModifiedTime,
  createdBy,
  lastModifiedBy,
  /* eslint-disable-next-line @typescript-eslint/no-explicit-any -- heterogeneous value types by design */
} as const satisfies Partial<Record<FieldType, FieldTypeSpec<any>>>;

export type RegisteredFieldType = keyof typeof SPECS;

/** Field types that have a working implementation today. */
export const IMPLEMENTED_FIELD_TYPES = Object.keys(SPECS) as RegisteredFieldType[];

export function isImplemented(type: string): type is RegisteredFieldType {
  return type in SPECS;
}

/**
 * Looks up a spec.
 *
 * Throws rather than returning undefined: every caller would otherwise have to handle a case
 * that only arises from a corrupt row or a partially-deployed release, and most would forget.
 * A loud failure with the offending type named is more useful than a silent null.
 */
export function getFieldSpec(type: string): FieldTypeSpec<unknown> {
  const spec = (SPECS as Record<string, FieldTypeSpec<unknown> | undefined>)[type];
  if (!spec) {
    throw new AppError('NOT_IMPLEMENTED', `The field type "${type}" is not available yet.`, {
      details: { type, available: IMPLEMENTED_FIELD_TYPES },
    });
  }
  return spec;
}

export interface FieldDefinition {
  readonly id: string;
  readonly name: string;
  readonly type: string;
  readonly options: Record<string, unknown>;
  readonly isRequired?: boolean;
  readonly promotedSlot?: string | null;
}

export function contextFor(
  field: FieldDefinition,
  extra: Partial<FieldContext> = {},
): FieldContext {
  return {
    fieldId: field.id,
    name: field.name,
    options: field.options ?? {},
    ...extra,
  };
}

/**
 * Validates and coerces one cell value.
 *
 * Enforces `isRequired` here rather than in each spec, so "required" means the same thing for
 * every type: whatever that type considers empty is not acceptable.
 */
export function parseCell(
  field: FieldDefinition,
  input: unknown,
  extra: Partial<FieldContext> = {},
): ParseResult<unknown> {
  const spec = getFieldSpec(field.type);
  const ctx = contextFor(field, extra);
  const result = spec.parse(input, ctx);
  if (!result.ok) return result;

  if (field.isRequired && spec.isEmpty(result.value)) {
    return { ok: false, error: `${field.name} is required` };
  }
  return result;
}

/** Validates a whole record payload, collecting every field's error rather than only the first. */
export function parseRecord(
  fields: readonly FieldDefinition[],
  input: Readonly<Record<string, unknown>>,
  extra: Partial<FieldContext> = {},
): { ok: true; values: Record<string, unknown> } | { ok: false; issues: Array<{ path: string; message: string }> } {
  const values: Record<string, unknown> = {};
  const issues: Array<{ path: string; message: string }> = [];
  const byId = new Map(fields.map((field) => [field.id, field]));

  for (const [fieldId, raw] of Object.entries(input)) {
    const field = byId.get(fieldId);
    if (!field) {
      issues.push({ path: fieldId, message: 'unknown field' });
      continue;
    }

    const spec = getFieldSpec(field.type);
    if (spec.computed) {
      issues.push({ path: fieldId, message: `${field.name} is computed and cannot be set` });
      continue;
    }

    const result = parseCell(field, raw, extra);
    if (result.ok) values[fieldId] = result.value;
    else issues.push({ path: fieldId, message: result.error });
  }

  return issues.length > 0 ? { ok: false, issues } : { ok: true, values };
}

/** Serialises stored values into the API representation for a whole record. */
export function serializeRecord(
  fields: readonly FieldDefinition[],
  data: Readonly<Record<string, unknown>>,
  extra: Partial<FieldContext> = {},
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const field of fields) {
    const spec = getFieldSpec(field.type);
    out[field.id] = spec.serialize(data[field.id] ?? null, contextFor(field, extra));
  }
  return out;
}

/**
 * Lossless text for export, falling back to the display form where the two coincide.
 *
 * Every export path must use this rather than `toText`, or a round trip through CSV silently
 * mutates temporal values.
 */
export function exportText(
  field: FieldDefinition,
  value: unknown,
  extra: Partial<FieldContext> = {},
): string {
  const spec = getFieldSpec(field.type);
  const ctx = contextFor(field, extra);
  return (spec.toExportText ?? spec.toText).call(spec, value, ctx);
}

/** True when a change to this field's value should be recorded as an edit. */
export function valuesEqual(field: FieldDefinition, a: unknown, b: unknown): boolean {
  const spec = getFieldSpec(field.type);
  if (spec.equals) return spec.equals(a, b);
  return JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
}

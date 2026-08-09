import type { FieldType, FilterOperator } from '@tessera/types';
import type { ZodTypeAny } from 'zod';

/**
 * The field-type contract.
 *
 * Every field type in the platform implements this one interface, and every layer — API
 * validation, storage, the query builder, CSV import and export, the grid's cell renderer —
 * routes through it. That is the whole point: adding a field type must be a matter of writing
 * one spec, not of finding and amending fourteen switch statements scattered across the
 * codebase.
 *
 * The conformance suite (docs/10-testing-strategy.md §3.3) exercises every registered spec
 * against the same battery of cases, so a type cannot be registered half-implemented.
 */

export type ParseResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: string };

export const ok = <T>(value: T): ParseResult<T> => ({ ok: true, value });
export const fail = <T = never>(error: string): ParseResult<T> => ({ ok: false, error });

/** What a spec is allowed to know about the field it is operating on. */
export interface FieldContext {
  readonly fieldId: string;
  readonly name: string;
  readonly options: Record<string, unknown>;
  /** Resolves a user id to a display name, for text rendering and export. */
  readonly resolveUser?: (userId: string) => { id: string; name: string; email: string } | null;
  readonly timezone?: string;
  readonly locale?: string;
}

/**
 * The physical slot family a value can be promoted into.
 *
 * `null` means the type is never promoted: it is filtered through the JSONB GIN index, or (for
 * relational types) through the link table. See docs/02-database-design.md §1.5.
 */
export type SlotFamily = 'string' | 'number' | 'date' | 'boolean' | null;

/** The value written into a promoted column. */
export type SlotValue = string | number | Date | boolean | null;

export interface FieldTypeSpec<TValue = unknown> {
  readonly type: FieldType;
  /** Human label used in the field-type picker. */
  readonly label: string;
  readonly group: 'text' | 'number' | 'choice' | 'date' | 'contact' | 'file' | 'relation' | 'computed' | 'system';
  readonly slotFamily: SlotFamily;
  /** True when the value is derived and may not be written directly through the API. */
  readonly computed: boolean;
  /** Schema for this type's `options` blob. Validated whenever a field is created or altered. */
  readonly optionsSchema: ZodTypeAny;
  defaultOptions(): Record<string, unknown>;

  /**
   * Validates and coerces an incoming value into its canonical stored form.
   *
   * Coercion is deliberate but narrow: `"42"` becomes `42` for a number field because a CSV and
   * an HTML input both deliver strings, but `"banana"` is an error rather than `NaN` or `0`.
   * Silent coercion to a wrong value is how spreadsheets lose data.
   */
  parse(input: unknown, ctx: FieldContext): ParseResult<TValue | null>;

  /** Canonical stored form → the shape the API returns. */
  serialize(value: TValue | null, ctx: FieldContext): unknown;

  /**
   * Canonical stored form → a plain string for **display**: localised, formatted, human-facing.
   *
   * Deliberately not the same thing as export text. A date-time displayed as "4 Mar 2026, 14:00"
   * in the viewer's zone is right for a grid cell and lossy for a CSV — re-importing it would
   * reinterpret the wall-clock time in whatever zone the importer happens to run in, silently
   * shifting every timestamp. Use `exportText` for anything that will be read back.
   */
  toText(value: TValue | null, ctx: FieldContext): string;

  /**
   * Canonical stored form → a **lossless** string that `fromText` can reconstruct exactly.
   *
   * Defaults to `toText` for types where display and export coincide (most of them). Temporal
   * types override it to emit ISO-8601.
   */
  toExportText?(value: TValue | null, ctx: FieldContext): string;

  /** Canonical stored form → the value written into a promoted column. */
  toSlot(value: TValue | null, ctx: FieldContext): SlotValue;

  /**
   * Whether the promoted slot holds the value itself, or merely a sort key derived from it.
   *
   * Defaults to `true`, which is the case for almost every type: the slot is the value, so a
   * filter can compare against the indexed column directly.
   *
   * Single-select sets it to `false`. Its slot carries the option's *position*, because sorting a
   * status column alphabetically ("Blocked, Done, In progress") is useless and sorting by the
   * board order is what people mean. That makes the slot excellent for `ORDER BY` and wrong for
   * `=`, so the query compiler reads this flag and routes equality back through the JSONB value
   * while still ordering on the column. Without the distinction, a filter on a promoted select
   * silently matches nothing.
   */
  readonly slotPreservesValue?: boolean;

  /** A string from a CSV or a paste → canonical stored form. */
  fromText(text: string, ctx: FieldContext): ParseResult<TValue | null>;

  /** Filter operators this type accepts. Enforced at request validation, not just in the UI. */
  readonly operators: readonly FilterOperator[];

  /** True when the value counts as empty for `isEmpty` filters and required-field checks. */
  isEmpty(value: TValue | null): boolean;

  /**
   * Whether two values are equal, for change detection and conflict comparison.
   * Defaults to deep JSON equality; types with order-insensitive values override it.
   */
  equals?(a: TValue | null, b: TValue | null): boolean;
}

/** Shared operator sets, so types that behave alike cannot drift apart by accident. */
export const OPERATORS = {
  text: [
    'is', 'isNot', 'contains', 'doesNotContain', 'startsWith', 'endsWith',
    // "Name is any of [Acme, Globex]" is a legitimate and common filter. The compiler has
    // always handled it; the operator set simply failed to declare it, which made the API
    // reject a query the engine could serve.
    'isAnyOf', 'isNoneOf',
    'isEmpty', 'isNotEmpty',
  ],
  longText: ['contains', 'doesNotContain', 'isEmpty', 'isNotEmpty'],
  numeric: [
    'is', 'isNot', 'isGreater', 'isGreaterOrEqual', 'isLess', 'isLessOrEqual', 'isBetween',
    'isEmpty', 'isNotEmpty',
  ],
  boolean: ['is'],
  singleChoice: ['is', 'isNot', 'isAnyOf', 'isNoneOf', 'isEmpty', 'isNotEmpty'],
  multiChoice: ['hasAnyOf', 'hasAllOf', 'isNoneOf', 'isEmpty', 'isNotEmpty'],
  date: [
    'is', 'isNot', 'isBefore', 'isAfter', 'isOnOrBefore', 'isOnOrAfter', 'isWithin',
    'isEmpty', 'isNotEmpty',
  ],
  user: ['is', 'isNot', 'isAnyOf', 'isNoneOf', 'isCurrentUser', 'isEmpty', 'isNotEmpty'],
  link: ['hasAnyOf', 'hasAllOf', 'hasLinkedRecords', 'hasNoLinkedRecords', 'isEmpty', 'isNotEmpty'],
  presenceOnly: ['isEmpty', 'isNotEmpty'],
} as const satisfies Record<string, readonly FilterOperator[]>;

/** Trims a string input and treats blank as absent, which is what every text-ish type wants. */
export function normaliseText(input: unknown): string | null {
  if (input === null || input === undefined) return null;
  if (typeof input !== 'string') return String(input).trim() || null;
  const trimmed = input.trim();
  return trimmed.length > 0 ? trimmed : null;
}

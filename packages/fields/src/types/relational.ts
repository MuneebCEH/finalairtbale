import { z } from 'zod';

import { fail, ok, type FieldTypeSpec, type ParseResult } from '../spec';

/**
 * Relational and computed field types: links between tables, and the values derived across them.
 *
 * These four are the reason a base is a database and not a folder of spreadsheets. They share one
 * property that shapes their implementation: **the value lives somewhere else**. A linked-record
 * cell holds ids; a lookup, rollup or count holds nothing at all until the link is followed.
 *
 * That is why lookup, rollup and count are `computed: true` — they are refused on write, filled
 * by the recalculation pass, and a client that tries to set one is told so rather than having its
 * value silently discarded.
 */

const RECORD_ID = /^rec_[0-9A-HJKMNP-TV-Z]{26}$/;

/** How many links one cell may hold. Beyond this the grid stops being usable and the recalc cost stops being bounded. */
const MAX_LINKS = 10_000;

// ── Linked record ───────────────────────────────────────────────────────────

export type LinkedRecordValue = string[];

export const linkedRecord: FieldTypeSpec<LinkedRecordValue> = {
  type: 'linkedRecord',
  label: 'Link to another record',
  group: 'relation',
  // Never promoted: links live in the join table, and filtering goes through it rather than
  // through a slot. See docs/02 §1.5.
  slotFamily: null,
  computed: false,
  optionsSchema: z
    .object({
      /**
       * The table this field points at.
       *
       * Optional *in the schema* and mandatory in practice. A Zod schema cannot check that the
       * table exists, sits in the same base, and is not this table's own — so presence is
       * enforced where those checks already happen, at field creation, rather than being half
       * enforced in two places. See `requiresLinkTarget`.
       */
      linkedTableId: z.string().max(30).optional(),
      /**
       * The field on the other table that mirrors this one. Airtable calls these symmetric;
       * writing one side updates the other, which is why the id is stored rather than inferred.
       */
      symmetricFieldId: z.string().max(30).optional(),
      /** False restricts the cell to a single link, which the grid renders differently. */
      allowMultiple: z.boolean().optional(),
      /**
       * What happens to this record when a linked one is deleted.
       *
       *   'unlink'   — the reference is dropped, this record survives (the safe default)
       *   'restrict' — the delete is refused while references remain
       *   'cascade'  — this record is deleted too
       *
       * The default is `unlink` because the other two can destroy or block work from a distance,
       * and a default that surprises somebody at delete time is the wrong default.
       */
      onDelete: z.enum(['unlink', 'restrict', 'cascade']).optional(),
      /** Limits which records may be linked, by view. */
      filterByViewId: z.string().max(30).optional(),
    })
    .strict(),

  defaultOptions: () => ({ allowMultiple: true, onDelete: 'unlink' }),

  parse(input, ctx): ParseResult<LinkedRecordValue | null> {
    if (input === null || input === undefined || input === '') return ok(null);

    // A single id is accepted unwrapped: an HTML select and a CSV both deliver one value, and
    // requiring a list there would make the common case the awkward one.
    const raw = Array.isArray(input) ? input : [input];

    const ids: string[] = [];
    for (const item of raw) {
      // Objects are accepted so the API can take back what it handed out — the grid holds
      // `{ id, name }` for display and should not have to strip it before saving.
      const id =
        typeof item === 'string'
          ? item
          : typeof item === 'object' && item !== null && typeof (item as { id?: unknown }).id === 'string'
            ? ((item as { id: string }).id)
            : null;

      if (id === null) return fail('every link must be a record id');
      if (!RECORD_ID.test(id)) return fail(`"${id}" is not a record id`);
      // De-duplicated rather than rejected: linking the same record twice is a user slip, not an
      // error worth refusing a save over.
      if (!ids.includes(id)) ids.push(id);
    }

    if (ids.length === 0) return ok(null);
    if (ids.length > MAX_LINKS) return fail(`a cell can hold at most ${MAX_LINKS} links`);

    const allowMultiple = (ctx.options['allowMultiple'] as boolean | undefined) ?? true;
    if (!allowMultiple && ids.length > 1) return fail('this field links to a single record');

    return ok(ids);
  },

  serialize: (value) => value ?? [],

  toText: (value) => (value ?? []).join(', '),

  toSlot: () => null,

  fromText(text, ctx): ParseResult<LinkedRecordValue | null> {
    const trimmed = text.trim();
    if (trimmed === '') return ok(null);
    return linkedRecord.parse(
      trimmed.split(',').map((part) => part.trim()).filter(Boolean),
      ctx,
    );
  },

  operators: [
    'isEmpty',
    'isNotEmpty',
    'hasLinkedRecords',
    'hasNoLinkedRecords',
    'hasAnyOf',
    'hasAllOf',
    'isNoneOf',
  ],

  isEmpty: (value) => !value || value.length === 0,

  // Order-insensitive: two cells holding the same links in a different order are the same cell,
  // and treating them as different would write a revision on every reorder.
  equals: (a, b) => {
    if (!a || !b) return (a?.length ?? 0) === (b?.length ?? 0);
    if (a.length !== b.length) return false;
    const left = [...a].sort();
    const right = [...b].sort();
    return left.every((id, index) => id === right[index]);
  },
};

// ── Count ───────────────────────────────────────────────────────────────────

export const count: FieldTypeSpec<number> = {
  type: 'count',
  label: 'Count',
  group: 'computed',
  slotFamily: 'number',
  computed: true,
  optionsSchema: z
    .object({
      /** The linked-record field whose links are counted. */
      linkFieldId: z.string().max(30).optional(),
    })
    .strict(),

  defaultOptions: () => ({}),

  // Computed fields refuse writes rather than accepting and discarding them: a client that
  // believes it set a value and finds it unchanged has no way to tell that from a lost update.
  parse: () => fail('a count is calculated from its links and cannot be set directly'),

  // Null means "not computed yet", which is not the same fact as "computed, and the answer is
  // zero". Rendering the first as 0 would show a confident zero on a record whose links have
  // never been counted, and there would be no way to tell the two apart.
  serialize: (value) => value ?? null,
  toText: (value) => (value === null || value === undefined ? '' : String(value)),
  toSlot: (value) => value ?? null,
  fromText: () => fail('a count cannot be imported'),

  operators: ['is', 'isNot', 'isGreater', 'isGreaterOrEqual', 'isLess', 'isLessOrEqual', 'isBetween'],

  // Zero is a real count, not an absence — a filter for "empty" must not match records that
  // genuinely have no links but do have a computed zero.
  isEmpty: (value) => value === null || value === undefined,
};

// ── Lookup ──────────────────────────────────────────────────────────────────

export type LookupValue = unknown[];

export const lookup: FieldTypeSpec<LookupValue> = {
  type: 'lookup',
  label: 'Lookup',
  group: 'computed',
  slotFamily: null,
  computed: true,
  optionsSchema: z
    .object({
      linkFieldId: z.string().max(30).optional(),
      /** The field on the linked table whose values are pulled through. */
      targetFieldId: z.string().max(30).optional(),
    })
    .strict(),

  defaultOptions: () => ({}),

  parse: () => fail('a lookup is read from linked records and cannot be set directly'),

  serialize: (value) => value ?? [],

  toText: (value) =>
    (value ?? [])
      .filter((item) => item !== null && item !== undefined && item !== '')
      .map((item) => String(item))
      .join(', '),

  toSlot: () => null,
  fromText: () => fail('a lookup cannot be imported'),

  operators: ['isEmpty', 'isNotEmpty', 'contains', 'doesNotContain', 'hasAnyOf', 'hasAllOf', 'isNoneOf'],

  isEmpty: (value) => !value || value.length === 0,
};

// ── Rollup ──────────────────────────────────────────────────────────────────

/**
 * Aggregations a rollup can apply.
 *
 * `sum` and `count` return 0 over an empty link set; the rest return blank. That asymmetry is
 * deliberate and matches what the numbers mean: the sum of nothing is zero, but the *average* of
 * nothing is not zero — reporting it as zero would drag every downstream figure down and look
 * like real data.
 */
export const ROLLUP_FUNCTIONS = [
  'sum', 'average', 'min', 'max', 'count', 'countAll', 'and', 'or', 'concatenate', 'arrayUnique',
] as const;

export type RollupFunction = (typeof ROLLUP_FUNCTIONS)[number];

export type RollupValue = number | string | boolean | unknown[] | null;

export const rollup: FieldTypeSpec<RollupValue> = {
  type: 'rollup',
  label: 'Rollup',
  group: 'computed',
  slotFamily: 'number',
  computed: true,
  optionsSchema: z
    .object({
      linkFieldId: z.string().max(30).optional(),
      targetFieldId: z.string().max(30).optional(),
      function: z.enum(ROLLUP_FUNCTIONS),
      precision: z.number().int().min(0).max(8).optional(),
    })
    .strict(),

  defaultOptions: () => ({ function: 'sum' }),

  parse: () => fail('a rollup is calculated from linked records and cannot be set directly'),

  serialize: (value) => value ?? null,

  toText: (value) => {
    if (value === null || value === undefined) return '';
    if (Array.isArray(value)) return value.map((item) => String(item)).join(', ');
    return String(value);
  },

  // Only numeric rollups reach a slot; the others have no meaningful ordering as a number, and
  // writing a non-number here would corrupt the promoted column's type.
  toSlot: (value) => (typeof value === 'number' ? value : null),

  fromText: () => fail('a rollup cannot be imported'),

  operators: [
    'is', 'isNot', 'isGreater', 'isGreaterOrEqual',
    'isLess', 'isLessOrEqual', 'isBetween', 'isEmpty', 'isNotEmpty',
  ],

  isEmpty: (value) => value === null || value === undefined || (Array.isArray(value) && value.length === 0),
};

/**
 * Applies a rollup function to the values gathered from linked records.
 *
 * Kept here, beside the spec, rather than in the recalculation worker: the worker decides *when*
 * to compute, this decides *what the answer is*, and the two changing independently is how a
 * rollup and its own filter start disagreeing.
 */
export function applyRollup(
  fn: RollupFunction,
  values: readonly unknown[],
  options: { precision?: number } = {},
): RollupValue {
  // Blanks are dropped before aggregating. An unfilled cell is not a zero, and counting it as one
  // is the single most common way an average silently lies.
  const present = values.filter((value) => value !== null && value !== undefined && value !== '');

  switch (fn) {
    case 'countAll':
      return values.length;
    case 'count':
      return present.length;

    case 'sum':
    case 'average':
    case 'min':
    case 'max': {
      const numbers = present
        .map((value) => (typeof value === 'number' ? value : Number(value)))
        .filter((value) => Number.isFinite(value));

      if (fn === 'sum') return round(numbers.reduce((a, b) => a + b, 0), options.precision);
      // Blank, not zero: see the note on ROLLUP_FUNCTIONS.
      if (numbers.length === 0) return null;
      if (fn === 'average') {
        return round(numbers.reduce((a, b) => a + b, 0) / numbers.length, options.precision);
      }
      return fn === 'min' ? Math.min(...numbers) : Math.max(...numbers);
    }

    case 'and':
      // Vacuously true over an empty set, which is the conventional and the useful answer:
      // "are all the linked tasks done" with no linked tasks is not false.
      return present.every((value) => Boolean(value));
    case 'or':
      return present.some((value) => Boolean(value));

    case 'concatenate':
      return present.map((value) => String(value)).join(', ');

    case 'arrayUnique': {
      const seen = new Map<string, unknown>();
      for (const value of present) {
        const key = JSON.stringify(value);
        if (!seen.has(key)) seen.set(key, value);
      }
      return [...seen.values()];
    }
  }
}

function round(value: number, precision?: number): number {
  if (precision === undefined) return value;
  const factor = 10 ** precision;
  return Math.round(value * factor) / factor;
}

/** Flattens what a lookup gathers: a linked record's own multi-value field yields several. */
export function gatherLookup(values: readonly unknown[]): unknown[] {
  const out: unknown[] = [];
  for (const value of values) {
    if (Array.isArray(value)) out.push(...value);
    else out.push(value);
  }
  return out;
}

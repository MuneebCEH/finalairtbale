import { compileRegex, RegexSyntaxError } from './regex';
import { FormulaError, T, type ErrorCode, type FormulaType, type FormulaValue } from './types';

/**
 * The fixed function table.
 *
 * "Fixed" is the security property: the interpreter can only call what is registered here, so
 * there is no path from a user's formula to arbitrary code (docs/07 §1.1). Adding a function is
 * a code change that goes through review, not a runtime registration.
 *
 * Each entry declares enough for the type checker to validate a call *before* it is saved and for
 * the editor to describe it in autocomplete.
 */

export interface Parameter {
  readonly name: string;
  readonly type: FormulaType;
  readonly optional?: boolean;
}

export interface FunctionSpec {
  readonly name: string;
  readonly params: readonly Parameter[];
  /** When set, the function accepts any number of further arguments of this type. */
  readonly rest?: FormulaType;
  /** A fixed return type, or one derived from the argument types (e.g. IF, SUM over arrays). */
  readonly returns: FormulaType | ((args: readonly FormulaType[]) => FormulaType);
  /** Rough work per call, used to bound total cost. Most functions are 1. */
  readonly cost?: number;
  /**
   * When true the interpreter passes arguments unevaluated so the function can short-circuit.
   * Only IF, AND, OR, SWITCH and IFERROR need this.
   */
  readonly lazy?: boolean;
  readonly summary: string;
  readonly call: (args: readonly FormulaValue[], context: CallContext) => FormulaValue;
}

export interface CallContext {
  /** Fixed for the whole batch, so a recalculation of a million rows agrees on "now". */
  readonly now: Date;
  readonly timezone: string;
  readonly locale: string;
  readonly recordId: string | null;
  readonly createdTime: Date | null;
  readonly lastModifiedTime: Date | null;
  readonly currentUserId: string | null;
  readonly currentUserName: string | null;
  /** Evaluates a deferred argument. Present only for lazy functions. */
  readonly evaluate?: (index: number) => FormulaValue;
  readonly stringLimit: number;
  readonly arrayLimit: number;
}

const err = (code: ErrorCode, detail?: string): FormulaError => new FormulaError(code, detail);

// ── Coercion helpers ────────────────────────────────────────────────────────
// Blank coerces to 0 / "" / false in the positions where docs/07 §3 allows it, and nowhere else.

function asNumber(value: FormulaValue): number | FormulaError {
  if (value instanceof FormulaError) return value;
  if (value === null) return 0;
  if (typeof value === 'number') return value;
  if (typeof value === 'boolean') return value ? 1 : 0;
  if (value instanceof Date) return value.getTime();
  return err('#TYPE!', `expected a number, got ${describe(value)}`);
}

function asText(value: FormulaValue): string | FormulaError {
  if (value instanceof FormulaError) return value;
  if (value === null) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number') return formatNumber(value);
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) {
    const parts: string[] = [];
    for (const item of value) {
      const text = asText(item);
      if (text instanceof FormulaError) return text;
      parts.push(text);
    }
    return parts.join(', ');
  }
  return err('#TYPE!', 'expected text');
}

function asBoolean(value: FormulaValue): boolean | FormulaError {
  if (value instanceof FormulaError) return value;
  if (value === null) return false;
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return value !== 0;
  if (typeof value === 'string') return value !== '';
  if (Array.isArray(value)) return value.length > 0;
  return true;
}

function asDate(value: FormulaValue): Date | FormulaError {
  if (value instanceof FormulaError) return value;
  if (value instanceof Date) return value;
  if (typeof value === 'string') {
    const parsed = new Date(value);
    if (Number.isNaN(parsed.getTime())) return err('#VALUE!', `"${value}" is not a date`);
    return parsed;
  }
  if (typeof value === 'number') return new Date(value);
  return err('#TYPE!', 'expected a date');
}

/** Numbers render without exponent notation and without a trailing ".0". */
function formatNumber(value: number): string {
  if (!Number.isFinite(value)) return String(value);
  if (Number.isInteger(value)) return String(value);
  return String(Number(value.toFixed(10)));
}

function describe(value: FormulaValue): string {
  if (value === null) return 'a blank';
  if (Array.isArray(value)) return 'a list';
  if (value instanceof Date) return 'a date';
  return `a ${typeof value}`;
}

/** Flattens a value into a list, so aggregations accept both a lookup array and loose arguments. */
function toList(values: readonly FormulaValue[]): FormulaValue[] {
  const out: FormulaValue[] = [];
  for (const value of values) {
    if (Array.isArray(value)) out.push(...value);
    else out.push(value);
  }
  return out;
}

/** Collects the numeric members of a list, propagating the first error found. */
function numbersOf(values: readonly FormulaValue[]): number[] | FormulaError {
  const out: number[] = [];
  for (const value of toList(values)) {
    if (value instanceof FormulaError) return value;
    // Blanks are skipped by aggregations rather than counted as zero: AVERAGE of [2, blank] is 2,
    // not 1. Treating an unfilled cell as a zero silently drags every average down.
    if (value === null) continue;
    const number = asNumber(value);
    if (number instanceof FormulaError) return number;
    out.push(number);
  }
  return out;
}

const define = (spec: FunctionSpec): [string, FunctionSpec] => [spec.name, spec];

const MS = { second: 1000, minute: 60_000, hour: 3_600_000, day: 86_400_000 } as const;

const DURATION_UNITS: Readonly<Record<string, number>> = {
  milliseconds: 1, ms: 1,
  seconds: MS.second, s: MS.second,
  minutes: MS.minute, m: MS.minute,
  hours: MS.hour, h: MS.hour,
  days: MS.day, d: MS.day,
  weeks: MS.day * 7, w: MS.day * 7,
  months: 0, // handled specially: calendar arithmetic, not a fixed span
  quarters: 0,
  years: 0,
};

function shiftDate(base: Date, amount: number, unit: string): Date | FormulaError {
  const key = unit.toLowerCase();
  const shifted = new Date(base.getTime());

  // Months, quarters and years are calendar operations. Adding "one month" as 30 days is wrong
  // in eleven months of the year, so they go through the date parts instead of a millisecond sum.
  if (key === 'months' || key === 'quarters' || key === 'years') {
    const months = key === 'years' ? amount * 12 : key === 'quarters' ? amount * 3 : amount;
    const day = shifted.getUTCDate();
    shifted.setUTCDate(1);
    shifted.setUTCMonth(shifted.getUTCMonth() + months);
    // Clamp: 31 January plus one month is 28/29 February, not 3 March.
    const lastDay = new Date(Date.UTC(shifted.getUTCFullYear(), shifted.getUTCMonth() + 1, 0)).getUTCDate();
    shifted.setUTCDate(Math.min(day, lastDay));
    return shifted;
  }

  const span = DURATION_UNITS[key];
  if (span === undefined) return err('#VALUE!', `"${unit}" is not a unit of time`);
  return new Date(base.getTime() + amount * span);
}

export const FUNCTIONS: ReadonlyMap<string, FunctionSpec> = new Map([
  // ── Logical ───────────────────────────────────────────────────────────────
  define({
    name: 'IF',
    params: [
      { name: 'condition', type: T.any },
      { name: 'whenTrue', type: T.any },
      { name: 'whenFalse', type: T.any, optional: true },
    ],
    // The result is whichever branch type is present; blank when the false branch is omitted.
    returns: (args) => args[1] ?? T.blank,
    lazy: true,
    summary: 'Returns one value when the condition holds and another when it does not.',
    call: (_args, context) => {
      const condition = asBoolean(context.evaluate?.(0) ?? null);
      if (condition instanceof FormulaError) return condition;
      if (condition) return context.evaluate?.(1) ?? null;
      return context.evaluate?.(2) ?? null;
    },
  }),
  define({
    name: 'AND',
    params: [{ name: 'value', type: T.any }],
    rest: T.any,
    returns: T.boolean,
    lazy: true,
    summary: 'True when every argument is true. Stops at the first false.',
    call: (args, context) => {
      for (let index = 0; index < args.length; index += 1) {
        const value = asBoolean(context.evaluate?.(index) ?? null);
        if (value instanceof FormulaError) return value;
        if (!value) return false;
      }
      return true;
    },
  }),
  define({
    name: 'OR',
    params: [{ name: 'value', type: T.any }],
    rest: T.any,
    returns: T.boolean,
    lazy: true,
    summary: 'True when any argument is true. Stops at the first true.',
    call: (args, context) => {
      for (let index = 0; index < args.length; index += 1) {
        const value = asBoolean(context.evaluate?.(index) ?? null);
        if (value instanceof FormulaError) return value;
        if (value) return true;
      }
      return false;
    },
  }),
  define({
    name: 'NOT',
    params: [{ name: 'value', type: T.any }],
    returns: T.boolean,
    summary: 'Inverts a true/false value.',
    call: ([value]) => {
      const boolean = asBoolean(value as FormulaValue);
      return boolean instanceof FormulaError ? boolean : !boolean;
    },
  }),
  define({
    name: 'XOR',
    params: [{ name: 'value', type: T.any }],
    rest: T.any,
    returns: T.boolean,
    summary: 'True when an odd number of arguments are true.',
    call: (args) => {
      let count = 0;
      for (const arg of args) {
        const value = asBoolean(arg);
        if (value instanceof FormulaError) return value;
        if (value) count += 1;
      }
      return count % 2 === 1;
    },
  }),
  define({
    name: 'SWITCH',
    params: [
      { name: 'expression', type: T.any },
      { name: 'pattern', type: T.any },
      { name: 'result', type: T.any },
    ],
    rest: T.any,
    returns: T.any,
    lazy: true,
    summary: 'Compares a value against each pattern and returns the matching result.',
    call: (args, context) => {
      const subject = context.evaluate?.(0) ?? null;
      if (subject instanceof FormulaError) return subject;

      // Pairs after the subject; a lone trailing argument is the default.
      let index = 1;
      for (; index + 1 < args.length; index += 2) {
        const pattern = context.evaluate?.(index) ?? null;
        if (pattern instanceof FormulaError) return pattern;
        if (looseEquals(subject, pattern)) return context.evaluate?.(index + 1) ?? null;
      }
      return index < args.length ? (context.evaluate?.(index) ?? null) : null;
    },
  }),
  define({
    name: 'IFERROR',
    params: [
      { name: 'value', type: T.any },
      { name: 'fallback', type: T.any },
    ],
    returns: (args) => args[1] ?? T.any,
    lazy: true,
    summary: 'Returns the fallback when the first argument is an error.',
    call: (_args, context) => {
      const value = context.evaluate?.(0) ?? null;
      return value instanceof FormulaError ? (context.evaluate?.(1) ?? null) : value;
    },
  }),
  define({
    name: 'ISERROR',
    params: [{ name: 'value', type: T.any }],
    returns: T.boolean,
    lazy: true,
    summary: 'True when the argument evaluates to an error.',
    call: (_args, context) => (context.evaluate?.(0) ?? null) instanceof FormulaError,
  }),
  define({
    name: 'ISBLANK',
    params: [{ name: 'value', type: T.any }],
    returns: T.boolean,
    summary: 'True when the value is empty.',
    call: ([value]) => value === null || value === '' || (Array.isArray(value) && value.length === 0),
  }),
  define({
    name: 'BLANK',
    params: [],
    returns: T.blank,
    summary: 'The empty value.',
    call: () => null,
  }),
  define({
    name: 'TRUE',
    params: [],
    returns: T.boolean,
    summary: 'The value true.',
    call: () => true,
  }),
  define({
    name: 'FALSE',
    params: [],
    returns: T.boolean,
    summary: 'The value false.',
    call: () => false,
  }),
  define({
    name: 'ERROR',
    params: [],
    returns: T.error,
    summary: 'Produces an error value.',
    call: () => err('#N/A', 'raised by ERROR()'),
  }),

  // ── Text ──────────────────────────────────────────────────────────────────
  define({
    name: 'CONCATENATE',
    params: [{ name: 'value', type: T.any }],
    rest: T.any,
    returns: T.text,
    summary: 'Joins values into one piece of text.',
    call: (args, context) => {
      let out = '';
      for (const arg of args) {
        const text = asText(arg);
        if (text instanceof FormulaError) return text;
        out += text;
        if (out.length > context.stringLimit) return err('#LIMIT!', 'the result grew too long');
      }
      return out;
    },
  }),
  define({
    name: 'LEN',
    params: [{ name: 'text', type: T.text }],
    returns: T.number,
    summary: 'The number of characters in a piece of text.',
    call: ([value]) => {
      const text = asText(value as FormulaValue);
      // Counted by code point, not UTF-16 unit, so an emoji is one character rather than two.
      return text instanceof FormulaError ? text : [...text].length;
    },
  }),
  define({
    name: 'LEFT',
    params: [{ name: 'text', type: T.text }, { name: 'count', type: T.number }],
    returns: T.text,
    summary: 'The first N characters.',
    call: ([value, count]) => {
      const text = asText(value as FormulaValue);
      if (text instanceof FormulaError) return text;
      const n = asNumber(count as FormulaValue);
      if (n instanceof FormulaError) return n;
      return [...text].slice(0, Math.max(0, Math.trunc(n))).join('');
    },
  }),
  define({
    name: 'RIGHT',
    params: [{ name: 'text', type: T.text }, { name: 'count', type: T.number }],
    returns: T.text,
    summary: 'The last N characters.',
    call: ([value, count]) => {
      const text = asText(value as FormulaValue);
      if (text instanceof FormulaError) return text;
      const n = asNumber(count as FormulaValue);
      if (n instanceof FormulaError) return n;
      const chars = [...text];
      const take = Math.max(0, Math.trunc(n));
      return take === 0 ? '' : chars.slice(Math.max(0, chars.length - take)).join('');
    },
  }),
  define({
    name: 'MID',
    params: [
      { name: 'text', type: T.text },
      { name: 'start', type: T.number },
      { name: 'count', type: T.number, optional: true },
    ],
    returns: T.text,
    summary: 'Characters from a starting position. The first character is at 1.',
    call: ([value, start, count]) => {
      const text = asText(value as FormulaValue);
      if (text instanceof FormulaError) return text;
      const from = asNumber(start as FormulaValue);
      if (from instanceof FormulaError) return from;
      const chars = [...text];
      // 1-based, as every spreadsheet's MID is. Off-by-one here would be a silent data change.
      const begin = Math.max(0, Math.trunc(from) - 1);
      if (count === undefined || count === null) return chars.slice(begin).join('');
      const take = asNumber(count);
      if (take instanceof FormulaError) return take;
      return chars.slice(begin, begin + Math.max(0, Math.trunc(take))).join('');
    },
  }),
  define({
    name: 'LOWER',
    params: [{ name: 'text', type: T.text }],
    returns: T.text,
    summary: 'Converts text to lower case.',
    call: ([value]) => {
      const text = asText(value as FormulaValue);
      return text instanceof FormulaError ? text : text.toLowerCase();
    },
  }),
  define({
    name: 'UPPER',
    params: [{ name: 'text', type: T.text }],
    returns: T.text,
    summary: 'Converts text to upper case.',
    call: ([value]) => {
      const text = asText(value as FormulaValue);
      return text instanceof FormulaError ? text : text.toUpperCase();
    },
  }),
  define({
    name: 'TRIM',
    params: [{ name: 'text', type: T.text }],
    returns: T.text,
    summary: 'Removes leading and trailing whitespace.',
    call: ([value]) => {
      const text = asText(value as FormulaValue);
      return text instanceof FormulaError ? text : text.trim();
    },
  }),
  define({
    name: 'SUBSTITUTE',
    params: [
      { name: 'text', type: T.text },
      { name: 'find', type: T.text },
      { name: 'replace', type: T.text },
      { name: 'occurrence', type: T.number, optional: true },
    ],
    returns: T.text,
    cost: 2,
    summary: 'Replaces occurrences of one piece of text with another.',
    call: ([value, find, replace, occurrence]) => {
      const text = asText(value as FormulaValue);
      if (text instanceof FormulaError) return text;
      const needle = asText(find as FormulaValue);
      if (needle instanceof FormulaError) return needle;
      const replacement = asText(replace as FormulaValue);
      if (replacement instanceof FormulaError) return replacement;
      if (needle === '') return text;

      if (occurrence === undefined || occurrence === null) return text.split(needle).join(replacement);

      const which = asNumber(occurrence);
      if (which instanceof FormulaError) return which;

      let index = -1;
      for (let seen = 0; seen < Math.trunc(which); seen += 1) {
        index = text.indexOf(needle, index + 1);
        if (index === -1) return text;
      }
      return text.slice(0, index) + replacement + text.slice(index + needle.length);
    },
  }),
  define({
    name: 'REPLACE',
    params: [
      { name: 'text', type: T.text },
      { name: 'start', type: T.number },
      { name: 'count', type: T.number },
      { name: 'replacement', type: T.text },
    ],
    returns: T.text,
    summary: 'Replaces a run of characters by position.',
    call: ([value, start, count, replacement]) => {
      const text = asText(value as FormulaValue);
      if (text instanceof FormulaError) return text;
      const from = asNumber(start as FormulaValue);
      if (from instanceof FormulaError) return from;
      const take = asNumber(count as FormulaValue);
      if (take instanceof FormulaError) return take;
      const insert = asText(replacement as FormulaValue);
      if (insert instanceof FormulaError) return insert;

      const chars = [...text];
      const begin = Math.max(0, Math.trunc(from) - 1);
      return [...chars.slice(0, begin), ...[...insert], ...chars.slice(begin + Math.max(0, Math.trunc(take)))].join('');
    },
  }),
  define({
    name: 'SEARCH',
    params: [
      { name: 'find', type: T.text },
      { name: 'within', type: T.text },
      { name: 'start', type: T.number, optional: true },
    ],
    returns: T.number,
    summary: 'The position of one piece of text within another, ignoring case. Blank when absent.',
    call: ([find, within, start]) => {
      const needle = asText(find as FormulaValue);
      if (needle instanceof FormulaError) return needle;
      const haystack = asText(within as FormulaValue);
      if (haystack instanceof FormulaError) return haystack;
      const from = start === undefined || start === null ? 1 : asNumber(start);
      if (from instanceof FormulaError) return from;

      const index = haystack.toLowerCase().indexOf(needle.toLowerCase(), Math.max(0, Math.trunc(from) - 1));
      // Blank rather than 0: "not found" is an absence, and returning 0 makes it arithmetic.
      return index === -1 ? null : index + 1;
    },
  }),
  define({
    name: 'FIND',
    params: [
      { name: 'find', type: T.text },
      { name: 'within', type: T.text },
      { name: 'start', type: T.number, optional: true },
    ],
    returns: T.number,
    summary: 'The position of one piece of text within another, case-sensitively. 0 when absent.',
    call: ([find, within, start]) => {
      const needle = asText(find as FormulaValue);
      if (needle instanceof FormulaError) return needle;
      const haystack = asText(within as FormulaValue);
      if (haystack instanceof FormulaError) return haystack;
      const from = start === undefined || start === null ? 1 : asNumber(start);
      if (from instanceof FormulaError) return from;
      return haystack.indexOf(needle, Math.max(0, Math.trunc(from) - 1)) + 1;
    },
  }),
  define({
    name: 'REPT',
    params: [{ name: 'text', type: T.text }, { name: 'count', type: T.number }],
    returns: T.text,
    cost: 3,
    summary: 'Repeats text a number of times.',
    call: ([value, count], context) => {
      const text = asText(value as FormulaValue);
      if (text instanceof FormulaError) return text;
      const times = asNumber(count as FormulaValue);
      if (times instanceof FormulaError) return times;
      const n = Math.max(0, Math.trunc(times));
      // Checked before allocating: REPT("x", 1e9) must be an error, not an out-of-memory crash.
      if (text.length * n > context.stringLimit) return err('#LIMIT!', 'the result would be too long');
      return text.repeat(n);
    },
  }),
  define({
    name: 'T',
    params: [{ name: 'value', type: T.any }],
    returns: T.text,
    summary: 'The value as text, or blank when it is not text.',
    call: ([value]) => (typeof value === 'string' ? value : null),
  }),
  define({
    name: 'REGEX_MATCH',
    params: [{ name: 'text', type: T.text }, { name: 'pattern', type: T.text }],
    returns: T.boolean,
    cost: 5,
    summary: 'True when the text matches the pattern.',
    call: ([value, pattern]) =>
      withRegex(value as FormulaValue, pattern as FormulaValue, (regex, text) => regex.test(text)),
  }),
  define({
    name: 'REGEX_EXTRACT',
    params: [{ name: 'text', type: T.text }, { name: 'pattern', type: T.text }],
    returns: T.text,
    cost: 5,
    summary: 'The first part of the text that matches the pattern, or blank.',
    call: ([value, pattern]) =>
      withRegex(value as FormulaValue, pattern as FormulaValue, (regex, text) => regex.extract(text)),
  }),
  define({
    name: 'REGEX_REPLACE',
    params: [
      { name: 'text', type: T.text },
      { name: 'pattern', type: T.text },
      { name: 'replacement', type: T.text },
    ],
    returns: T.text,
    cost: 8,
    summary: 'Replaces every match of the pattern.',
    call: ([value, pattern, replacement]) => {
      const to = asText(replacement as FormulaValue);
      if (to instanceof FormulaError) return to;
      return withRegex(value as FormulaValue, pattern as FormulaValue, (regex, text) =>
        regex.replace(text, to),
      );
    },
  }),
  define({
    name: 'ENCODE_URL_COMPONENT',
    params: [{ name: 'text', type: T.text }],
    returns: T.text,
    summary: 'Escapes text for use inside a URL.',
    call: ([value]) => {
      const text = asText(value as FormulaValue);
      return text instanceof FormulaError ? text : encodeURIComponent(text);
    },
  }),
  define({
    name: 'SPLIT',
    params: [{ name: 'text', type: T.text }, { name: 'separator', type: T.text }],
    returns: T.array(T.text),
    summary: 'Splits text into a list.',
    call: ([value, separator], context) => {
      const text = asText(value as FormulaValue);
      if (text instanceof FormulaError) return text;
      const delimiter = asText(separator as FormulaValue);
      if (delimiter instanceof FormulaError) return delimiter;
      const parts = delimiter === '' ? [...text] : text.split(delimiter);
      if (parts.length > context.arrayLimit) return err('#LIMIT!', 'too many parts');
      return parts;
    },
  }),
  define({
    name: 'JOIN',
    params: [{ name: 'list', type: T.array(T.any) }, { name: 'separator', type: T.text, optional: true }],
    returns: T.text,
    summary: 'Joins a list into text.',
    call: ([list, separator]) => {
      const glue = separator === undefined || separator === null ? ', ' : asText(separator);
      if (glue instanceof FormulaError) return glue;
      const items = toList([list as FormulaValue]);
      const parts: string[] = [];
      for (const item of items) {
        if (item instanceof FormulaError) return item;
        if (item === null) continue;
        const text = asText(item);
        if (text instanceof FormulaError) return text;
        parts.push(text);
      }
      return parts.join(glue);
    },
  }),

  // ── Numeric ───────────────────────────────────────────────────────────────
  define({
    name: 'ABS',
    params: [{ name: 'number', type: T.number }],
    returns: T.number,
    summary: 'The absolute value.',
    call: ([value]) => mapNumber(value as FormulaValue, Math.abs),
  }),
  define({
    name: 'ROUND',
    params: [{ name: 'number', type: T.number }, { name: 'places', type: T.number, optional: true }],
    returns: T.number,
    summary: 'Rounds to a number of decimal places.',
    call: ([value, places]) => roundTo(value as FormulaValue, places as FormulaValue, 'nearest'),
  }),
  define({
    name: 'ROUNDUP',
    params: [{ name: 'number', type: T.number }, { name: 'places', type: T.number, optional: true }],
    returns: T.number,
    summary: 'Rounds away from zero.',
    call: ([value, places]) => roundTo(value as FormulaValue, places as FormulaValue, 'up'),
  }),
  define({
    name: 'ROUNDDOWN',
    params: [{ name: 'number', type: T.number }, { name: 'places', type: T.number, optional: true }],
    returns: T.number,
    summary: 'Rounds towards zero.',
    call: ([value, places]) => roundTo(value as FormulaValue, places as FormulaValue, 'down'),
  }),
  define({
    name: 'FLOOR',
    params: [{ name: 'number', type: T.number }],
    returns: T.number,
    summary: 'The largest whole number no greater than the value.',
    call: ([value]) => mapNumber(value as FormulaValue, Math.floor),
  }),
  define({
    name: 'CEILING',
    params: [{ name: 'number', type: T.number }],
    returns: T.number,
    summary: 'The smallest whole number no less than the value.',
    call: ([value]) => mapNumber(value as FormulaValue, Math.ceil),
  }),
  define({
    name: 'INT',
    params: [{ name: 'number', type: T.number }],
    returns: T.number,
    summary: 'The whole part of a number.',
    call: ([value]) => mapNumber(value as FormulaValue, Math.trunc),
  }),
  define({
    name: 'MOD',
    params: [{ name: 'number', type: T.number }, { name: 'divisor', type: T.number }],
    returns: T.number,
    summary: 'The remainder after division.',
    call: ([value, divisor]) => {
      const a = asNumber(value as FormulaValue);
      if (a instanceof FormulaError) return a;
      const b = asNumber(divisor as FormulaValue);
      if (b instanceof FormulaError) return b;
      if (b === 0) return err('#DIV/0!');
      return a % b;
    },
  }),
  define({
    name: 'POWER',
    params: [{ name: 'base', type: T.number }, { name: 'exponent', type: T.number }],
    returns: T.number,
    summary: 'Raises a number to a power.',
    call: ([base, exponent]) => {
      const a = asNumber(base as FormulaValue);
      if (a instanceof FormulaError) return a;
      const b = asNumber(exponent as FormulaValue);
      if (b instanceof FormulaError) return b;
      const result = a ** b;
      return Number.isFinite(result) ? result : err('#VALUE!', 'the result is not a finite number');
    },
  }),
  define({
    name: 'SQRT',
    params: [{ name: 'number', type: T.number }],
    returns: T.number,
    summary: 'The square root.',
    call: ([value]) => {
      const number = asNumber(value as FormulaValue);
      if (number instanceof FormulaError) return number;
      if (number < 0) return err('#VALUE!', 'a negative number has no real square root');
      return Math.sqrt(number);
    },
  }),
  define({
    name: 'EXP',
    params: [{ name: 'number', type: T.number }],
    returns: T.number,
    summary: 'e raised to a power.',
    call: ([value]) => mapNumber(value as FormulaValue, Math.exp),
  }),
  define({
    name: 'LOG',
    params: [{ name: 'number', type: T.number }, { name: 'base', type: T.number, optional: true }],
    returns: T.number,
    summary: 'The logarithm, base 10 unless another base is given.',
    call: ([value, base]) => {
      const number = asNumber(value as FormulaValue);
      if (number instanceof FormulaError) return number;
      if (number <= 0) return err('#VALUE!', 'the logarithm needs a positive number');
      if (base === undefined || base === null) return Math.log10(number);
      const b = asNumber(base);
      if (b instanceof FormulaError) return b;
      if (b <= 0 || b === 1) return err('#VALUE!', 'that is not a usable logarithm base');
      return Math.log(number) / Math.log(b);
    },
  }),
  define({
    name: 'VALUE',
    params: [{ name: 'text', type: T.text }],
    returns: T.number,
    summary: 'Reads a number out of text.',
    call: ([value]) => {
      if (typeof value === 'number') return value;
      const text = asText(value as FormulaValue);
      if (text instanceof FormulaError) return text;
      // Currency symbols, thousands separators and stray spaces are stripped: the point of VALUE
      // is to rescue a number from human-entered text.
      const cleaned = text.replace(/[^0-9eE+\-.]/g, '');
      if (cleaned === '' || !/^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/.test(cleaned)) {
        return err('#VALUE!', `"${text}" is not a number`);
      }
      return Number(cleaned);
    },
  }),
  define({
    name: 'EVEN',
    params: [{ name: 'number', type: T.number }],
    returns: T.number,
    summary: 'Rounds away from zero to the next even number.',
    call: ([value]) =>
      mapNumber(value as FormulaValue, (n) => {
        const away = n < 0 ? Math.floor(n) : Math.ceil(n);
        return away % 2 === 0 ? away : away + (n < 0 ? -1 : 1);
      }),
  }),
  define({
    name: 'ODD',
    params: [{ name: 'number', type: T.number }],
    returns: T.number,
    summary: 'Rounds away from zero to the next odd number.',
    call: ([value]) =>
      mapNumber(value as FormulaValue, (n) => {
        const away = n < 0 ? Math.floor(n) : Math.ceil(n);
        return Math.abs(away % 2) === 1 ? away : away + (n < 0 ? -1 : 1);
      }),
  }),
  define({
    name: 'SIGN',
    params: [{ name: 'number', type: T.number }],
    returns: T.number,
    summary: '-1, 0 or 1 depending on the sign.',
    call: ([value]) => mapNumber(value as FormulaValue, Math.sign),
  }),

  // ── Aggregation ───────────────────────────────────────────────────────────
  define({
    name: 'SUM',
    params: [{ name: 'value', type: T.any }],
    rest: T.any,
    returns: T.number,
    summary: 'Adds numbers together.',
    call: (args) => {
      const numbers = numbersOf(args);
      return numbers instanceof FormulaError ? numbers : numbers.reduce((a, b) => a + b, 0);
    },
  }),
  define({
    name: 'AVERAGE',
    params: [{ name: 'value', type: T.any }],
    rest: T.any,
    returns: T.number,
    summary: 'The mean of the numbers.',
    call: (args) => {
      const numbers = numbersOf(args);
      if (numbers instanceof FormulaError) return numbers;
      // Blank rather than #DIV/0!: an average of nothing is unknown, not an arithmetic fault.
      if (numbers.length === 0) return null;
      return numbers.reduce((a, b) => a + b, 0) / numbers.length;
    },
  }),
  define({
    name: 'MIN',
    params: [{ name: 'value', type: T.any }],
    rest: T.any,
    returns: T.number,
    summary: 'The smallest number.',
    call: (args) => {
      const numbers = numbersOf(args);
      if (numbers instanceof FormulaError) return numbers;
      return numbers.length === 0 ? null : Math.min(...numbers);
    },
  }),
  define({
    name: 'MAX',
    params: [{ name: 'value', type: T.any }],
    rest: T.any,
    returns: T.number,
    summary: 'The largest number.',
    call: (args) => {
      const numbers = numbersOf(args);
      if (numbers instanceof FormulaError) return numbers;
      return numbers.length === 0 ? null : Math.max(...numbers);
    },
  }),
  define({
    name: 'COUNT',
    params: [{ name: 'value', type: T.any }],
    rest: T.any,
    returns: T.number,
    summary: 'How many of the values are numbers.',
    call: (args) => toList(args).filter((v) => typeof v === 'number').length,
  }),
  define({
    name: 'COUNTA',
    params: [{ name: 'value', type: T.any }],
    rest: T.any,
    returns: T.number,
    summary: 'How many of the values are not empty.',
    call: (args) => toList(args).filter((v) => v !== null && v !== '').length,
  }),
  define({
    name: 'COUNTALL',
    params: [{ name: 'value', type: T.any }],
    rest: T.any,
    returns: T.number,
    summary: 'How many values there are, including empty ones.',
    call: (args) => toList(args).length,
  }),
  define({
    name: 'ARRAYJOIN',
    params: [{ name: 'list', type: T.array(T.any) }, { name: 'separator', type: T.text, optional: true }],
    returns: T.text,
    summary: 'Joins a list into text.',
    call: (args) => (FUNCTIONS.get('JOIN') as FunctionSpec).call(args, {} as CallContext),
  }),
  define({
    name: 'ARRAYUNIQUE',
    params: [{ name: 'list', type: T.array(T.any) }],
    rest: T.any,
    returns: (args) => args[0] ?? T.array(T.any),
    summary: 'Removes duplicate values from a list.',
    call: (args) => {
      const seen = new Map<string, FormulaValue>();
      for (const item of toList(args)) {
        const key = JSON.stringify(item instanceof Date ? item.toISOString() : item);
        if (!seen.has(key)) seen.set(key, item);
      }
      return [...seen.values()];
    },
  }),
  define({
    name: 'ARRAYCOMPACT',
    params: [{ name: 'list', type: T.array(T.any) }],
    rest: T.any,
    returns: (args) => args[0] ?? T.array(T.any),
    summary: 'Removes empty values from a list.',
    call: (args) => toList(args).filter((v) => v !== null && v !== ''),
  }),
  define({
    name: 'ARRAYFLATTEN',
    params: [{ name: 'list', type: T.array(T.any) }],
    rest: T.any,
    returns: T.array(T.any),
    summary: 'Flattens nested lists into one.',
    call: (args) => {
      const out: FormulaValue[] = [];
      const push = (value: FormulaValue): void => {
        if (Array.isArray(value)) value.forEach(push);
        else out.push(value);
      };
      args.forEach(push);
      return out;
    },
  }),
  define({
    name: 'ARRAYSLICE',
    params: [
      { name: 'list', type: T.array(T.any) },
      { name: 'start', type: T.number },
      { name: 'count', type: T.number, optional: true },
    ],
    returns: (args) => args[0] ?? T.array(T.any),
    summary: 'A section of a list. The first item is at 1.',
    call: ([list, start, count]) => {
      const items = toList([list as FormulaValue]);
      const from = asNumber(start as FormulaValue);
      if (from instanceof FormulaError) return from;
      const begin = Math.max(0, Math.trunc(from) - 1);
      if (count === undefined || count === null) return items.slice(begin);
      const take = asNumber(count);
      if (take instanceof FormulaError) return take;
      return items.slice(begin, begin + Math.max(0, Math.trunc(take)));
    },
  }),

  // ── Date and time ─────────────────────────────────────────────────────────
  define({
    name: 'TODAY',
    params: [],
    returns: T.date,
    summary: "Today's date.",
    call: (_args, context) => {
      const now = context.now;
      return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
    },
  }),
  define({
    name: 'NOW',
    params: [],
    returns: T.dateTime,
    // Fixed to the batch timestamp: a recalculation of a million rows must not produce a million
    // different "now"s, or the same formula disagrees with itself down the column (docs/07 §1.4).
    summary: 'The current date and time, fixed for the whole recalculation.',
    call: (_args, context) => context.now,
  }),
  define({
    name: 'DATEADD',
    params: [
      { name: 'date', type: T.date },
      { name: 'amount', type: T.number },
      { name: 'unit', type: T.text },
    ],
    returns: T.dateTime,
    summary: 'Shifts a date forward by an amount of time.',
    call: ([date, amount, unit]) => {
      const base = asDate(date as FormulaValue);
      if (base instanceof FormulaError) return base;
      const by = asNumber(amount as FormulaValue);
      if (by instanceof FormulaError) return by;
      const units = asText(unit as FormulaValue);
      if (units instanceof FormulaError) return units;
      return shiftDate(base, by, units);
    },
  }),
  define({
    name: 'DATESUB',
    params: [
      { name: 'date', type: T.date },
      { name: 'amount', type: T.number },
      { name: 'unit', type: T.text },
    ],
    returns: T.dateTime,
    summary: 'Shifts a date backward by an amount of time.',
    call: ([date, amount, unit]) => {
      const base = asDate(date as FormulaValue);
      if (base instanceof FormulaError) return base;
      const by = asNumber(amount as FormulaValue);
      if (by instanceof FormulaError) return by;
      const units = asText(unit as FormulaValue);
      if (units instanceof FormulaError) return units;
      return shiftDate(base, -by, units);
    },
  }),
  define({
    name: 'DATETIME_DIFF',
    params: [
      { name: 'later', type: T.date },
      { name: 'earlier', type: T.date },
      { name: 'unit', type: T.text, optional: true },
    ],
    returns: T.number,
    summary: 'The time between two dates, in the given unit.',
    call: ([later, earlier, unit]) => {
      const a = asDate(later as FormulaValue);
      if (a instanceof FormulaError) return a;
      const b = asDate(earlier as FormulaValue);
      if (b instanceof FormulaError) return b;

      const units = unit === undefined || unit === null ? 'days' : asText(unit);
      if (units instanceof FormulaError) return units;
      const key = units.toLowerCase();

      if (key === 'months' || key === 'years' || key === 'quarters') {
        const months =
          (a.getUTCFullYear() - b.getUTCFullYear()) * 12 + (a.getUTCMonth() - b.getUTCMonth());
        // Truncated towards zero, so a partial final month does not round up into a whole one.
        const partial = a.getUTCDate() < b.getUTCDate() ? (months > 0 ? -1 : 0) : 0;
        const whole = months + partial;
        return key === 'years' ? Math.trunc(whole / 12) : key === 'quarters' ? Math.trunc(whole / 3) : whole;
      }

      const span = DURATION_UNITS[key];
      if (!span) return err('#VALUE!', `"${units}" is not a unit of time`);
      return Math.trunc((a.getTime() - b.getTime()) / span);
    },
  }),
  define({
    name: 'DATETIME_PARSE',
    params: [{ name: 'text', type: T.text }],
    returns: T.dateTime,
    summary: 'Reads a date out of text.',
    call: ([value]) => asDate(value as FormulaValue),
  }),
  define({
    name: 'YEAR',
    params: [{ name: 'date', type: T.date }],
    returns: T.number,
    summary: 'The year.',
    call: ([value]) => datePart(value as FormulaValue, (d) => d.getUTCFullYear()),
  }),
  define({
    name: 'MONTH',
    params: [{ name: 'date', type: T.date }],
    returns: T.number,
    summary: 'The month, 1 to 12.',
    call: ([value]) => datePart(value as FormulaValue, (d) => d.getUTCMonth() + 1),
  }),
  define({
    name: 'DAY',
    params: [{ name: 'date', type: T.date }],
    returns: T.number,
    summary: 'The day of the month.',
    call: ([value]) => datePart(value as FormulaValue, (d) => d.getUTCDate()),
  }),
  define({
    name: 'HOUR',
    params: [{ name: 'date', type: T.date }],
    returns: T.number,
    summary: 'The hour, 0 to 23.',
    call: ([value]) => datePart(value as FormulaValue, (d) => d.getUTCHours()),
  }),
  define({
    name: 'MINUTE',
    params: [{ name: 'date', type: T.date }],
    returns: T.number,
    summary: 'The minute.',
    call: ([value]) => datePart(value as FormulaValue, (d) => d.getUTCMinutes()),
  }),
  define({
    name: 'SECOND',
    params: [{ name: 'date', type: T.date }],
    returns: T.number,
    summary: 'The second.',
    call: ([value]) => datePart(value as FormulaValue, (d) => d.getUTCSeconds()),
  }),
  define({
    name: 'WEEKDAY',
    params: [{ name: 'date', type: T.date }],
    returns: T.number,
    summary: 'The day of the week, 0 (Sunday) to 6.',
    call: ([value]) => datePart(value as FormulaValue, (d) => d.getUTCDay()),
  }),
  define({
    name: 'IS_AFTER',
    params: [{ name: 'a', type: T.date }, { name: 'b', type: T.date }],
    returns: T.boolean,
    summary: 'True when the first date is later than the second.',
    call: ([a, b]) => compareDates(a as FormulaValue, b as FormulaValue, (x, y) => x > y),
  }),
  define({
    name: 'IS_BEFORE',
    params: [{ name: 'a', type: T.date }, { name: 'b', type: T.date }],
    returns: T.boolean,
    summary: 'True when the first date is earlier than the second.',
    call: ([a, b]) => compareDates(a as FormulaValue, b as FormulaValue, (x, y) => x < y),
  }),
  define({
    name: 'IS_SAME',
    params: [{ name: 'a', type: T.date }, { name: 'b', type: T.date }],
    returns: T.boolean,
    summary: 'True when two dates are the same moment.',
    call: ([a, b]) => compareDates(a as FormulaValue, b as FormulaValue, (x, y) => x === y),
  }),
  define({
    name: 'DATETIME_FORMAT',
    params: [{ name: 'date', type: T.date }, { name: 'format', type: T.text, optional: true }],
    returns: T.text,
    summary: 'Renders a date as text. Supports YYYY, MM, DD, HH, mm, ss.',
    call: ([value, format]) => {
      const date = asDate(value as FormulaValue);
      if (date instanceof FormulaError) return date;
      const pattern = format === undefined || format === null ? 'YYYY-MM-DD' : asText(format);
      if (pattern instanceof FormulaError) return pattern;

      const pad = (n: number, width = 2): string => String(n).padStart(width, '0');
      // Longest tokens first so "YYYY" is not consumed as two "YY"s.
      return pattern
        .replace(/YYYY/g, String(date.getUTCFullYear()))
        .replace(/MM/g, pad(date.getUTCMonth() + 1))
        .replace(/DD/g, pad(date.getUTCDate()))
        .replace(/HH/g, pad(date.getUTCHours()))
        .replace(/mm/g, pad(date.getUTCMinutes()))
        .replace(/ss/g, pad(date.getUTCSeconds()));
    },
  }),

  // ── Formatting ────────────────────────────────────────────────────────────
  define({
    name: 'FORMAT_NUMBER',
    params: [{ name: 'number', type: T.number }, { name: 'places', type: T.number, optional: true }],
    returns: T.text,
    summary: 'Renders a number with a fixed number of decimal places.',
    call: ([value, places]) => {
      const number = asNumber(value as FormulaValue);
      if (number instanceof FormulaError) return number;
      const digits = places === undefined || places === null ? 0 : asNumber(places);
      if (digits instanceof FormulaError) return digits;
      return number.toFixed(Math.max(0, Math.min(20, Math.trunc(digits))));
    },
  }),
  define({
    name: 'FORMAT_PERCENT',
    params: [{ name: 'number', type: T.number }, { name: 'places', type: T.number, optional: true }],
    returns: T.text,
    summary: 'Renders a fraction as a percentage.',
    call: ([value, places]) => {
      const number = asNumber(value as FormulaValue);
      if (number instanceof FormulaError) return number;
      const digits = places === undefined || places === null ? 0 : asNumber(places);
      if (digits instanceof FormulaError) return digits;
      return `${(number * 100).toFixed(Math.max(0, Math.min(20, Math.trunc(digits))))}%`;
    },
  }),

  // ── Record ────────────────────────────────────────────────────────────────
  define({
    name: 'RECORD_ID',
    params: [],
    returns: T.text,
    summary: "The record's id.",
    call: (_args, context) => context.recordId,
  }),
  define({
    name: 'CREATED_TIME',
    params: [],
    returns: T.dateTime,
    summary: 'When the record was created.',
    call: (_args, context) => context.createdTime,
  }),
  define({
    name: 'LAST_MODIFIED_TIME',
    params: [],
    returns: T.dateTime,
    summary: 'When the record was last changed.',
    call: (_args, context) => context.lastModifiedTime,
  }),
  define({
    name: 'CURRENT_USER',
    params: [],
    returns: T.text,
    summary: 'The name of the person viewing the record.',
    call: (_args, context) => context.currentUserName,
  }),
  define({
    name: 'CURRENT_USER_ID',
    params: [],
    returns: T.text,
    summary: 'The id of the person viewing the record.',
    call: (_args, context) => context.currentUserId,
  }),
]);

/** Aliases. `LENGTH` is the same function as `LEN`. */
const ALIASES: Readonly<Record<string, string>> = { LENGTH: 'LEN' };

export function lookupFunction(name: string): FunctionSpec | undefined {
  const canonical = ALIASES[name] ?? name;
  return FUNCTIONS.get(canonical);
}

// ── Shared helpers ──────────────────────────────────────────────────────────

/**
 * Runs a regex operation, bounding the input and turning a bad pattern into a value.
 *
 * The engine has no catastrophic case, but the input is still capped: a formula runs once per
 * record, and a 100 KB cell scanned by a 500-character pattern is real work repeated a million
 * times. A malformed pattern is `#VALUE!` rather than an exception — the author sees it in the
 * cell they wrote it for, which is where they can fix it.
 */
const REGEX_INPUT_LIMIT = 1_000;

function withRegex(
  value: FormulaValue,
  pattern: FormulaValue,
  run: (regex: ReturnType<typeof compileRegex>, text: string) => FormulaValue,
): FormulaValue {
  const text = asText(value);
  if (text instanceof FormulaError) return text;
  const source = asText(pattern);
  if (source instanceof FormulaError) return source;

  if (text.length > REGEX_INPUT_LIMIT) {
    return err('#LIMIT!', `regular expressions apply to at most ${REGEX_INPUT_LIMIT} characters`);
  }

  try {
    return run(compileRegex(source), text);
  } catch (error) {
    if (error instanceof RegexSyntaxError) return err('#VALUE!', error.message);
    throw error;
  }
}

function mapNumber(value: FormulaValue, fn: (n: number) => number): FormulaValue {
  const number = asNumber(value);
  if (number instanceof FormulaError) return number;
  const result = fn(number);
  return Number.isFinite(result) ? result : err('#VALUE!', 'the result is not a finite number');
}

function roundTo(value: FormulaValue, places: FormulaValue, mode: 'nearest' | 'up' | 'down'): FormulaValue {
  const number = asNumber(value);
  if (number instanceof FormulaError) return number;
  const digits = places === undefined || places === null ? 0 : asNumber(places);
  if (digits instanceof FormulaError) return digits;

  const factor = 10 ** Math.trunc(digits);
  const scaled = number * factor;
  const rounded =
    mode === 'nearest'
      ? // Away from zero on a tie, which is what a spreadsheet user expects: Math.round would
        // send -0.5 to -0 and 0.5 to 1, treating the two signs differently.
        Math.sign(scaled) * Math.round(Math.abs(scaled))
      : mode === 'up'
        ? Math.sign(scaled) * Math.ceil(Math.abs(scaled))
        : Math.sign(scaled) * Math.floor(Math.abs(scaled));

  return rounded / factor;
}

function datePart(value: FormulaValue, part: (date: Date) => number): FormulaValue {
  const date = asDate(value);
  return date instanceof FormulaError ? date : part(date);
}

function compareDates(
  a: FormulaValue,
  b: FormulaValue,
  compare: (x: number, y: number) => boolean,
): FormulaValue {
  const left = asDate(a);
  if (left instanceof FormulaError) return left;
  const right = asDate(b);
  if (right instanceof FormulaError) return right;
  return compare(left.getTime(), right.getTime());
}

/** Equality as `=` and SWITCH use it: same type compares directly, blank equals blank. */
export function looseEquals(a: FormulaValue, b: FormulaValue): boolean {
  if (a === null || b === null) return a === b;
  if (a instanceof Date && b instanceof Date) return a.getTime() === b.getTime();
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((item, index) => looseEquals(item, b[index] as FormulaValue));
  }
  return a === b;
}

export { asNumber, asText, asBoolean, asDate, toList };

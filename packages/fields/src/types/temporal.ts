import { z } from 'zod';

import { OPERATORS, fail, normaliseText, ok, type FieldTypeSpec } from '../spec';

/**
 * Date and date-time.
 *
 * Both store a full ISO-8601 UTC instant. The difference is *interpretation*, and it matters:
 *
 *  - `date` is a calendar day. Somebody's birthday is the 4th of March everywhere on earth, so
 *    it is stored at midnight UTC and rendered without conversion. Applying a timezone to it is
 *    the bug that makes birthdays shift by a day for users in Auckland.
 *  - `dateTime` is a moment. A meeting at 14:00 in London is 09:00 in New York, so it is stored
 *    as an instant and rendered in the viewer's zone.
 *
 * Conflating the two is one of the most common and most annoying data bugs in this product
 * category, so they are separate types with separate rules rather than one type with a flag.
 */

const dateOptions = z
  .object({
    dateFormat: z.enum(['iso', 'us', 'european', 'friendly']).optional(),
    /** Only meaningful for dateTime. */
    timeFormat: z.enum(['12h', '24h']).optional(),
    /** Renders in this zone rather than the viewer's. For fixed-location events. */
    displayTimezone: z.string().max(64).optional(),
  })
  .strict();

const ISO_DATE_ONLY = /^(\d{4})-(\d{2})-(\d{2})$/;

/** Accepts ISO, US and European orderings, plus whatever Date can manage as a last resort. */
function parseToDate(text: string): Date | null {
  const isoMatch = ISO_DATE_ONLY.exec(text);
  if (isoMatch) {
    // Constructed as UTC explicitly. `new Date('2026-03-04')` is UTC but
    // `new Date('2026/03/04')` is local, and depending on that distinction is how off-by-one-day
    // bugs get in.
    return new Date(Date.UTC(Number(isoMatch[1]), Number(isoMatch[2]) - 1, Number(isoMatch[3])));
  }

  // dd/mm/yyyy and mm/dd/yyyy are genuinely ambiguous. Where the first component is > 12 the
  // reading is unambiguous; otherwise ISO order is assumed and the caller is expected to have
  // set an explicit format during import mapping.
  const slash = /^(\d{1,2})[/.](\d{1,2})[/.](\d{4})$/.exec(text);
  if (slash) {
    const first = Number(slash[1]);
    const second = Number(slash[2]);
    const year = Number(slash[3]);
    const [day, month] = first > 12 ? [first, second] : [second, first];
    if (month < 1 || month > 12 || day < 1 || day > 31) return null;
    return new Date(Date.UTC(year, month - 1, day));
  }

  const parsed = new Date(text);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

export const date: FieldTypeSpec<string> = {
  type: 'date',
  label: 'Date',
  group: 'date',
  slotFamily: 'date',
  computed: false,
  optionsSchema: dateOptions,
  defaultOptions: () => ({ dateFormat: 'iso' }),

  parse(input) {
    if (input === null || input === undefined || input === '') return ok(null);

    if (input instanceof Date) {
      return Number.isNaN(input.getTime()) ? fail('must be a valid date') : ok(truncate(input));
    }
    const text = normaliseText(input);
    if (text === null) return ok(null);

    const parsed = parseToDate(text);
    if (!parsed) return fail('must be a valid date');
    return ok(truncate(parsed));
  },

  serialize: (value) => value,
  toText(value, ctx) {
    if (value === null) return '';
    const format = (ctx.options['dateFormat'] as string | undefined) ?? 'iso';
    const iso = value.slice(0, 10);
    if (format === 'iso') return iso;
    const [year, month, day] = iso.split('-') as [string, string, string];
    if (format === 'us') return `${month}/${day}/${year}`;
    if (format === 'european') return `${day}/${month}/${year}`;
    return new Date(`${iso}T00:00:00Z`).toLocaleDateString(ctx.locale ?? 'en', {
      timeZone: 'UTC',
      day: 'numeric',
      month: 'short',
      year: 'numeric',
    });
  },
  // ISO for export: a localised "4/3/2026" is ambiguous the moment it crosses a locale boundary.
  toExportText: (value) => (value === null ? '' : value.slice(0, 10)),
  toSlot: (value) => (value === null ? null : new Date(value)),
  fromText(text, ctx) {
    return this.parse(text, ctx);
  },
  operators: OPERATORS.date,
  isEmpty: (value) => value === null,
};

/** Midnight UTC on the calendar day, so a date has exactly one representation. */
function truncate(value: Date): string {
  return `${value.toISOString().slice(0, 10)}T00:00:00.000Z`;
}

export const dateTime: FieldTypeSpec<string> = {
  type: 'dateTime',
  label: 'Date and time',
  group: 'date',
  slotFamily: 'date',
  computed: false,
  optionsSchema: dateOptions,
  defaultOptions: () => ({ dateFormat: 'iso', timeFormat: '24h' }),

  parse(input) {
    if (input === null || input === undefined || input === '') return ok(null);

    if (input instanceof Date) {
      return Number.isNaN(input.getTime()) ? fail('must be a valid date') : ok(input.toISOString());
    }
    const text = normaliseText(input);
    if (text === null) return ok(null);

    const parsed = parseToDate(text);
    if (!parsed) return fail('must be a valid date and time');
    return ok(parsed.toISOString());
  },

  serialize: (value) => value,
  toText(value, ctx) {
    if (value === null) return '';
    const zone = (ctx.options['displayTimezone'] as string | undefined) ?? ctx.timezone ?? 'UTC';
    const hour12 = (ctx.options['timeFormat'] as string | undefined) === '12h';
    try {
      return new Intl.DateTimeFormat(ctx.locale ?? 'en', {
        timeZone: zone,
        dateStyle: 'medium',
        timeStyle: 'short',
        hour12,
      }).format(new Date(value));
    } catch {
      return value;
    }
  },
  /**
   * ISO-8601 instant, always.
   *
   * The display form renders wall-clock time in some zone; re-importing that string would
   * reinterpret it in the importer's zone and shift every timestamp by the difference. Exporting
   * the instant makes the round trip exact regardless of where either end runs.
   */
  toExportText: (value) => value ?? '',
  toSlot: (value) => (value === null ? null : new Date(value)),
  fromText(text, ctx) {
    return this.parse(text, ctx);
  },
  operators: OPERATORS.date,
  isEmpty: (value) => value === null,
};

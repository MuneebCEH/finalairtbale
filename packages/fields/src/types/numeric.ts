import { z } from 'zod';

import { OPERATORS, fail, ok, type FieldTypeSpec } from '../spec';

/**
 * Numeric types.
 *
 * All of them share one parser, because the differences between "number", "currency" and
 * "percent" are presentation and constraint, not storage. Storing them differently would mean
 * three subtly different rounding behaviours and three chances to get the edge cases wrong.
 */

const numberOptions = z
  .object({
    precision: z.number().int().min(0).max(8).optional(),
    min: z.number().optional(),
    max: z.number().optional(),
    /** Renders as 1,234.56 rather than 1234.56. Display only. */
    thousandsSeparator: z.boolean().optional(),
    /** Negative values are refused rather than clamped, so the rejection is visible. */
    allowNegative: z.boolean().optional(),
  })
  .strict();

function parseNumber(
  input: unknown,
  options: Record<string, unknown>,
  { integer = false }: { integer?: boolean } = {},
): ReturnType<FieldTypeSpec<number>['parse']> {
  if (input === null || input === undefined || input === '') return ok(null);

  let value: number;
  if (typeof input === 'number') {
    value = input;
  } else if (typeof input === 'string') {
    // Strips grouping separators, currency symbols and whitespace, so a pasted "$1,234.50"
    // lands as 1234.5 rather than being rejected. Anything left over is a genuine error.
    const cleaned = input.replace(/[\s,\u00a0\u202f']/g, '').replace(/^[^\d+.-]+/, '');
    if (cleaned === '' || !/^[+-]?(\d+\.?\d*|\.\d+)$/.test(cleaned)) {
      return fail('must be a number');
    }
    value = Number(cleaned);
  } else {
    return fail('must be a number');
  }

  if (!Number.isFinite(value)) return fail('must be a finite number');

  if (integer) value = Math.trunc(value);

  const precision = options['precision'] as number | undefined;
  if (precision !== undefined) {
    const factor = 10 ** precision;
    // Rounds half away from zero, which is what a person filling in a spreadsheet expects.
    // JavaScript's Math.round rounds half up, so -0.5 would become -0 rather than -1.
    value = Math.sign(value) * Math.round(Math.abs(value) * factor) / factor;
  }

  const min = options['min'] as number | undefined;
  const max = options['max'] as number | undefined;
  if (min !== undefined && value < min) return fail(`must be at least ${min}`);
  if (max !== undefined && value > max) return fail(`must be at most ${max}`);
  if (options['allowNegative'] === false && value < 0) return fail('must not be negative');

  return ok(value);
}

function numericSpec(
  type: FieldTypeSpec<number>['type'],
  label: string,
  extra: Partial<FieldTypeSpec<number>> & { optionsSchema?: z.ZodTypeAny } = {},
): FieldTypeSpec<number> {
  return {
    type,
    label,
    group: 'number',
    slotFamily: 'number',
    computed: false,
    optionsSchema: extra.optionsSchema ?? numberOptions,
    defaultOptions: extra.defaultOptions ?? (() => ({ precision: 0 })),
    parse: extra.parse ?? ((input, ctx) => parseNumber(input, ctx.options)),
    serialize: (value) => value,
    toText: extra.toText ?? ((value) => (value === null ? '' : String(value))),
    toSlot: (value) => value,
    fromText(text, ctx) {
      return this.parse(text, ctx);
    },
    operators: OPERATORS.numeric,
    isEmpty: (value) => value === null,
  };
}

export const number = numericSpec('number', 'Number', {
  parse: (input, ctx) => parseNumber(input, ctx.options, { integer: true }),
  defaultOptions: () => ({ precision: 0 }),
});

export const decimal = numericSpec('decimal', 'Decimal', {
  defaultOptions: () => ({ precision: 2 }),
});

export const currency: FieldTypeSpec<number> = {
  ...numericSpec('currency', 'Currency'),
  optionsSchema: numberOptions.extend({ currencyCode: z.string().length(3).optional() }),
  defaultOptions: () => ({ precision: 2, currencyCode: 'USD' }),
  toText(value, ctx) {
    if (value === null) return '';
    const code = (ctx.options['currencyCode'] as string | undefined) ?? 'USD';
    try {
      return new Intl.NumberFormat(ctx.locale ?? 'en', { style: 'currency', currency: code }).format(value);
    } catch {
      return String(value);
    }
  },
};

export const percent: FieldTypeSpec<number> = {
  ...numericSpec('percent', 'Percent'),
  defaultOptions: () => ({ precision: 1 }),
  // Stored as the number the user typed (75 means 75%), not as 0.75. Storing the fraction
  // means every export, formula and API consumer has to remember to multiply, and half of them
  // will forget.
  toText: (value) => (value === null ? '' : `${value}%`),
};

export const rating: FieldTypeSpec<number> = {
  ...numericSpec('rating', 'Rating'),
  optionsSchema: z
    .object({ max: z.number().int().min(1).max(10).optional(), icon: z.string().max(32).optional() })
    .strict(),
  defaultOptions: () => ({ max: 5, icon: 'star' }),
  parse(input, ctx) {
    const parsed = parseNumber(input, {}, { integer: true });
    if (!parsed.ok || parsed.value === null) return parsed;
    const max = (ctx.options['max'] as number | undefined) ?? 5;
    if (parsed.value < 0) return fail('must not be negative');
    if (parsed.value > max) return fail(`must be at most ${max}`);
    return parsed;
  },
};

export const progress: FieldTypeSpec<number> = {
  ...numericSpec('progress', 'Progress'),
  optionsSchema: z.object({ showPercentage: z.boolean().optional() }).strict(),
  defaultOptions: () => ({ showPercentage: true }),
  parse(input) {
    const parsed = parseNumber(input, { precision: 2 });
    if (!parsed.ok || parsed.value === null) return parsed;
    if (parsed.value < 0 || parsed.value > 100) return fail('must be between 0 and 100');
    return parsed;
  },
  toText: (value) => (value === null ? '' : `${value}%`),
};

/**
 * Duration, stored as seconds.
 *
 * Seconds rather than milliseconds because durations in this product are human-scale (task
 * estimates, call lengths), and seconds keep the stored numbers small enough to read in a raw
 * database row — which matters more often than sub-second precision does.
 */
export const duration: FieldTypeSpec<number> = {
  type: 'duration',
  label: 'Duration',
  group: 'number',
  slotFamily: 'number',
  computed: false,
  optionsSchema: z
    .object({ format: z.enum(['h:mm', 'h:mm:ss', 'h:mm:ss.s']).optional() })
    .strict(),
  defaultOptions: () => ({ format: 'h:mm' }),

  parse(input) {
    if (input === null || input === undefined || input === '') return ok(null);
    if (typeof input === 'number') {
      return Number.isFinite(input) && input >= 0 ? ok(input) : fail('must be a positive duration');
    }
    if (typeof input !== 'string') return fail('must be a duration');

    const text = input.trim();
    // Accepts "90" (seconds), "1:30" (mm:ss), "1:30:00" (h:mm:ss).
    if (/^\d+$/.test(text)) return ok(Number(text));

    const parts = text.split(':');
    if (parts.length < 2 || parts.length > 3 || parts.some((p) => !/^\d+(\.\d+)?$/.test(p))) {
      return fail('must look like 1:30 or 1:30:00');
    }
    const numbers = parts.map(Number);
    const seconds =
      numbers.length === 2
        ? (numbers[0] as number) * 60 + (numbers[1] as number)
        : (numbers[0] as number) * 3600 + (numbers[1] as number) * 60 + (numbers[2] as number);
    return ok(seconds);
  },

  serialize: (value) => value,
  toText(value) {
    if (value === null) return '';
    const hours = Math.floor(value / 3600);
    const minutes = Math.floor((value % 3600) / 60);
    const seconds = Math.floor(value % 60);
    return `${hours}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
  },
  toSlot: (value) => value,
  fromText(text, ctx) {
    return this.parse(text, ctx);
  },
  operators: OPERATORS.numeric,
  isEmpty: (value) => value === null,
};

export const checkbox: FieldTypeSpec<boolean> = {
  type: 'checkbox',
  label: 'Checkbox',
  group: 'choice',
  slotFamily: 'boolean',
  computed: false,
  optionsSchema: z.object({ icon: z.string().max(32).optional() }).strict(),
  defaultOptions: () => ({ icon: 'check' }),

  parse(input) {
    if (input === null || input === undefined || input === '') return ok(false);
    if (typeof input === 'boolean') return ok(input);
    if (typeof input === 'number') return ok(input !== 0);
    if (typeof input === 'string') {
      const text = input.trim().toLowerCase();
      if (['true', 'yes', 'y', '1', 'checked', 'x'].includes(text)) return ok(true);
      if (['false', 'no', 'n', '0', '', 'unchecked'].includes(text)) return ok(false);
      return fail('must be true or false');
    }
    return fail('must be true or false');
  },

  // Never null: an unchecked box is `false`, not "unknown". A tri-state checkbox is a different
  // field type, and conflating them makes every filter ambiguous.
  serialize: (value) => value ?? false,
  toText: (value) => (value ? 'true' : 'false'),
  toSlot: (value) => value ?? false,
  fromText(text, ctx) {
    return this.parse(text, ctx);
  },
  operators: OPERATORS.boolean,
  isEmpty: (value) => value !== true,
};

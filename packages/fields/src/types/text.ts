import { z } from 'zod';

import { OPERATORS, fail, normaliseText, ok, type FieldTypeSpec } from '../spec';

const MAX_SINGLE_LINE = 4_000;
const MAX_LONG_TEXT = 100_000;

export const singleLineText: FieldTypeSpec<string> = {
  type: 'singleLineText',
  label: 'Single line text',
  group: 'text',
  slotFamily: 'string',
  computed: false,
  optionsSchema: z
    .object({
      defaultValue: z.string().max(MAX_SINGLE_LINE).optional(),
      maxLength: z.number().int().min(1).max(MAX_SINGLE_LINE).optional(),
    })
    .strict(),
  defaultOptions: () => ({}),

  parse(input, ctx) {
    if (input === null || input === undefined) return ok(null);
    if (typeof input === 'object') return fail('expected a string');

    // Newlines are stripped rather than rejected: pasting a multi-line cell into a single-line
    // field is common and the intent is obvious. Rejecting it would lose the whole paste.
    const value = String(input).replace(/[\r\n]+/g, ' ').trim();
    if (value.length === 0) return ok(null);

    const max = (ctx.options['maxLength'] as number | undefined) ?? MAX_SINGLE_LINE;
    if (value.length > max) return fail(`must be at most ${max} characters`);
    return ok(value);
  },

  serialize: (value) => value,
  toText: (value) => value ?? '',
  toSlot: (value) => value,
  fromText(text, ctx) {
    return this.parse(text, ctx);
  },
  operators: OPERATORS.text,
  isEmpty: (value) => value === null || value === '',
};

export const longText: FieldTypeSpec<string> = {
  type: 'longText',
  label: 'Long text',
  group: 'text',
  // Not promotable. Sorting a hundred-thousand-character column is not a thing anybody wants,
  // and a btree index on it would exceed Postgres's index row size limit anyway.
  slotFamily: null,
  computed: false,
  optionsSchema: z.object({ richText: z.boolean().optional() }).strict(),
  defaultOptions: () => ({ richText: false }),

  parse(input) {
    if (input === null || input === undefined) return ok(null);
    if (typeof input === 'object') return fail('expected a string');
    const value = String(input);
    if (value.length > MAX_LONG_TEXT) return fail(`must be at most ${MAX_LONG_TEXT} characters`);
    return ok(value.length > 0 ? value : null);
  },

  serialize: (value) => value,
  toText: (value) => value ?? '',
  toSlot: () => null,
  fromText(text, ctx) {
    return this.parse(text, ctx);
  },
  operators: OPERATORS.longText,
  isEmpty: (value) => value === null || value.trim() === '',
};

// ── Structured text ─────────────────────────────────────────────────────────

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export const email: FieldTypeSpec<string> = {
  type: 'email',
  label: 'Email',
  group: 'contact',
  slotFamily: 'string',
  computed: false,
  optionsSchema: z.object({}).strict(),
  defaultOptions: () => ({}),

  parse(input) {
    const value = normaliseText(input);
    if (value === null) return ok(null);
    // Stored lowercase so that filtering and grouping do not treat two spellings of the same
    // address as different values.
    const lower = value.toLowerCase();
    if (!EMAIL.test(lower)) return fail('must be a valid email address');
    if (lower.length > 254) return fail('must be at most 254 characters');
    return ok(lower);
  },

  serialize: (value) => value,
  toText: (value) => value ?? '',
  toSlot: (value) => value,
  fromText(text, ctx) {
    return this.parse(text, ctx);
  },
  operators: OPERATORS.text,
  isEmpty: (value) => value === null,
};

export const url: FieldTypeSpec<string> = {
  type: 'url',
  label: 'URL',
  group: 'contact',
  slotFamily: 'string',
  computed: false,
  optionsSchema: z.object({}).strict(),
  defaultOptions: () => ({}),

  parse(input) {
    const value = normaliseText(input);
    if (value === null) return ok(null);
    // A bare "example.com" is what people type; assume https rather than rejecting it.
    const candidate = /^[a-z][a-z0-9+.-]*:/i.test(value) ? value : `https://${value}`;
    try {
      const parsed = new URL(candidate);
      // Only web schemes are stored. `javascript:` and `data:` in a link field are an XSS
      // vector the moment the grid renders it as an anchor.
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
        return fail('must be an http or https URL');
      }
      if (candidate.length > 2_048) return fail('must be at most 2048 characters');
      return ok(candidate);
    } catch {
      return fail('must be a valid URL');
    }
  },

  serialize: (value) => value,
  toText: (value) => value ?? '',
  toSlot: (value) => value,
  fromText(text, ctx) {
    return this.parse(text, ctx);
  },
  operators: OPERATORS.text,
  isEmpty: (value) => value === null,
};

export const phone: FieldTypeSpec<string> = {
  type: 'phone',
  label: 'Phone number',
  group: 'contact',
  slotFamily: 'string',
  computed: false,
  optionsSchema: z.object({}).strict(),
  defaultOptions: () => ({}),

  parse(input) {
    const value = normaliseText(input);
    if (value === null) return ok(null);
    // Stored as typed. Normalising to E.164 requires knowing the caller's country, and guessing
    // it silently corrupts numbers for everyone whose guess is wrong.
    if (!/^[\d\s()+.\-x]{3,32}$/i.test(value)) return fail('must be a valid phone number');
    return ok(value);
  },

  serialize: (value) => value,
  toText: (value) => value ?? '',
  toSlot: (value) => value?.replace(/\D/g, '') ?? null,
  fromText(text, ctx) {
    return this.parse(text, ctx);
  },
  operators: OPERATORS.text,
  isEmpty: (value) => value === null,
};

export const barcode: FieldTypeSpec<{ text: string; format?: string }> = {
  type: 'barcode',
  label: 'Barcode',
  group: 'contact',
  slotFamily: 'string',
  computed: false,
  optionsSchema: z.object({}).strict(),
  defaultOptions: () => ({}),

  parse(input) {
    if (input === null || input === undefined) return ok(null);
    if (typeof input === 'string') {
      const text = input.trim();
      return text ? ok({ text }) : ok(null);
    }
    if (typeof input === 'object') {
      const record = input as Record<string, unknown>;
      const text = normaliseText(record['text']);
      if (text === null) return ok(null);
      const format = normaliseText(record['format']);
      return ok(format ? { text, format } : { text });
    }
    return fail('expected a barcode value');
  },

  serialize: (value) => value,
  toText: (value) => value?.text ?? '',
  toSlot: (value) => value?.text ?? null,
  fromText(text, ctx) {
    return this.parse(text, ctx);
  },
  operators: OPERATORS.text,
  isEmpty: (value) => value === null || value.text === '',
};

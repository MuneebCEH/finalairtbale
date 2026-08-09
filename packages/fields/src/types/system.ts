import { z } from 'zod';

import { OPERATORS, fail, normaliseText, ok, type FieldTypeSpec } from '../spec';

/**
 * People, files, structured blobs, and generated values.
 */

// ── Collaborators ───────────────────────────────────────────────────────────

export const user: FieldTypeSpec<string> = {
  type: 'user',
  label: 'User',
  group: 'contact',
  slotFamily: 'string',
  computed: false,
  optionsSchema: z.object({ notifyOnAssign: z.boolean().optional() }).strict(),
  defaultOptions: () => ({ notifyOnAssign: false }),

  parse(input) {
    if (input === null || input === undefined || input === '') return ok(null);
    // Accepts a bare id or the object shape the UI sends back unchanged.
    const value =
      typeof input === 'object' && input !== null
        ? normaliseText((input as Record<string, unknown>)['id'])
        : normaliseText(input);
    if (value === null) return ok(null);
    if (!/^usr_[0-9A-HJKMNP-TV-Z]{26}$/.test(value)) return fail('must be a user id');
    return ok(value);
  },

  serialize: (value) => value,
  toText(value, ctx) {
    if (value === null) return '';
    return ctx.resolveUser?.(value)?.name ?? value;
  },
  toSlot: (value) => value,
  fromText(text) {
    // A CSV carries an email address, not a user id. Resolving it needs a directory lookup the
    // spec has no access to, so the importer performs the mapping and this stays honest about
    // the limitation rather than guessing.
    if (normaliseText(text) === null) return ok(null);
    return fail('users must be imported by id; map this column during import');
  },
  operators: OPERATORS.user,
  isEmpty: (value) => value === null,
};

export const multipleUsers: FieldTypeSpec<string[]> = {
  type: 'multipleUsers',
  label: 'Multiple users',
  group: 'contact',
  slotFamily: null,
  computed: false,
  optionsSchema: z.object({ notifyOnAssign: z.boolean().optional() }).strict(),
  defaultOptions: () => ({ notifyOnAssign: false }),

  parse(input, ctx) {
    if (input === null || input === undefined || input === '') return ok(null);
    const items = Array.isArray(input) ? input : [input];
    const resolved: string[] = [];
    for (const item of items) {
      const single = user.parse(item, ctx);
      if (!single.ok) return fail(single.error);
      if (single.value && !resolved.includes(single.value)) resolved.push(single.value);
    }
    return ok(resolved.length > 0 ? resolved : null);
  },

  serialize: (value) => value ?? [],
  toText: (value, ctx) =>
    (value ?? []).map((id) => ctx.resolveUser?.(id)?.name ?? id).join(', '),
  toSlot: () => null,
  fromText: () => fail('users must be imported by id; map this column during import'),
  operators: OPERATORS.user,
  isEmpty: (value) => !value || value.length === 0,
  equals: (a, b) => JSON.stringify([...(a ?? [])].sort()) === JSON.stringify([...(b ?? [])].sort()),
};

// ── Attachments ─────────────────────────────────────────────────────────────

const attachmentSchema = z.object({
  id: z.string().min(1).max(40),
  filename: z.string().min(1).max(255),
  mimeType: z.string().max(128),
  size: z.number().int().min(0),
  url: z.string().max(2048).optional(),
  thumbnails: z.record(z.string()).optional(),
});

export type AttachmentValue = z.infer<typeof attachmentSchema>;

export const attachment: FieldTypeSpec<AttachmentValue[]> = {
  type: 'attachment',
  label: 'Attachment',
  group: 'file',
  slotFamily: null,
  computed: false,
  optionsSchema: z
    .object({
      maxFiles: z.number().int().min(1).max(100).optional(),
      allowedTypes: z.array(z.string().max(128)).max(50).optional(),
    })
    .strict(),
  defaultOptions: () => ({ maxFiles: 20 }),

  parse(input, ctx) {
    if (input === null || input === undefined || input === '') return ok(null);
    if (!Array.isArray(input)) return fail('must be a list of attachments');

    const max = (ctx.options['maxFiles'] as number | undefined) ?? 20;
    if (input.length > max) return fail(`must have at most ${max} files`);

    const parsed = z.array(attachmentSchema).safeParse(input);
    if (!parsed.success) return fail('one or more attachments are malformed');
    return ok(parsed.data.length > 0 ? parsed.data : null);
  },

  // The stored `url` is never returned as-is: attachment URLs are signed and short-lived, and
  // the record service replaces this field with a freshly signed URL on read. Emitting the
  // stored value here would hand out a permanent link to a private file.
  serialize: (value) =>
    (value ?? []).map(({ id, filename, mimeType, size, thumbnails }) => ({
      id,
      filename,
      mimeType,
      size,
      thumbnails,
    })),
  toText: (value) => (value ?? []).map((file) => file.filename).join(', '),
  toSlot: () => null,
  fromText: () => fail('attachments cannot be imported from text'),
  operators: OPERATORS.presenceOnly,
  isEmpty: (value) => !value || value.length === 0,
};

// ── Structured blob ─────────────────────────────────────────────────────────

export const json: FieldTypeSpec<unknown> = {
  type: 'json',
  label: 'JSON',
  group: 'text',
  slotFamily: null,
  computed: false,
  optionsSchema: z.object({}).strict(),
  defaultOptions: () => ({}),

  parse(input) {
    if (input === null || input === undefined || input === '') return ok(null);
    if (typeof input === 'string') {
      try {
        return ok(JSON.parse(input));
      } catch {
        return fail('must be valid JSON');
      }
    }
    // Guards against a payload that is valid JSON but pathologically large or deep, which would
    // otherwise become a slow query and a fat row for every reader.
    const encoded = JSON.stringify(input);
    if (encoded && encoded.length > 100_000) return fail('must be at most 100 KB');
    return ok(input);
  },

  serialize: (value) => value,
  toText: (value) => (value === null ? '' : JSON.stringify(value)),
  toSlot: () => null,
  fromText(text, ctx) {
    return this.parse(text, ctx);
  },
  operators: OPERATORS.presenceOnly,
  isEmpty: (value) => value === null || value === undefined,
};

// ── Generated values ────────────────────────────────────────────────────────

/**
 * Computed and system types share one shape: they reject direct writes.
 *
 * `parse` failing is the enforcement point. Without it, a client could PATCH `createdTime` and
 * the audit trail would quietly become fiction.
 */
function generated<T>(
  type: FieldTypeSpec<T>['type'],
  label: string,
  config: {
    slotFamily: FieldTypeSpec<T>['slotFamily'];
    operators: FieldTypeSpec<T>['operators'];
    toText: FieldTypeSpec<T>['toText'];
    toSlot: FieldTypeSpec<T>['toSlot'];
    group?: FieldTypeSpec<T>['group'];
  },
): FieldTypeSpec<T> {
  return {
    type,
    label,
    group: config.group ?? 'system',
    slotFamily: config.slotFamily,
    computed: true,
    optionsSchema: z.object({}).passthrough(),
    defaultOptions: () => ({}),
    parse: () => fail(`${label} is generated and cannot be set directly`),
    serialize: (value) => value,
    toText: config.toText,
    toSlot: config.toSlot,
    fromText: () => fail(`${label} is generated and cannot be imported`),
    operators: config.operators,
    isEmpty: (value) => value === null || value === undefined,
  };
}

export const autoNumber = generated<number>('autoNumber', 'Auto number', {
  slotFamily: 'number',
  operators: OPERATORS.numeric,
  toText: (value) => (value === null ? '' : String(value)),
  toSlot: (value) => value,
});

export const recordId = generated<string>('recordId', 'Record ID', {
  slotFamily: 'string',
  operators: OPERATORS.text,
  toText: (value) => value ?? '',
  toSlot: (value) => value,
});

export const createdTime = generated<string>('createdTime', 'Created time', {
  slotFamily: 'date',
  operators: OPERATORS.date,
  toText: (value) => value ?? '',
  toSlot: (value) => (value ? new Date(value) : null),
});

export const lastModifiedTime = generated<string>('lastModifiedTime', 'Last modified time', {
  slotFamily: 'date',
  operators: OPERATORS.date,
  toText: (value) => value ?? '',
  toSlot: (value) => (value ? new Date(value) : null),
});

export const createdBy = generated<string>('createdBy', 'Created by', {
  slotFamily: 'string',
  operators: OPERATORS.user,
  toText: (value) => value ?? '',
  toSlot: (value) => value,
});

export const lastModifiedBy = generated<string>('lastModifiedBy', 'Last modified by', {
  slotFamily: 'string',
  operators: OPERATORS.user,
  toText: (value) => value ?? '',
  toSlot: (value) => value,
});

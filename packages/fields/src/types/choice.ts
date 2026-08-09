import { z } from 'zod';

import { OPERATORS, fail, normaliseText, ok, type FieldTypeSpec } from '../spec';

/**
 * Select-style types.
 *
 * The stored value is the option **id**, never its label. Renaming "In progress" to "In review"
 * must not rewrite a million records, and must not silently break every filter that referenced
 * the old label. Labels live in the field's options and are resolved at render time.
 */

const optionSchema = z.object({
  id: z.string().min(1).max(64),
  label: z.string().min(1).max(255),
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional(),
  /** Explicit ordering, so options sort the way the author arranged them, not alphabetically. */
  position: z.number().int().optional(),
});

export type SelectOption = z.infer<typeof optionSchema>;

const selectOptions = z
  .object({
    choices: z.array(optionSchema).max(1_000),
    /** Import and paste may add unseen values instead of failing. Off by default. */
    allowNewOptions: z.boolean().optional(),
  })
  .strict();

function readChoices(options: Record<string, unknown>): SelectOption[] {
  const choices = options['choices'];
  return Array.isArray(choices) ? (choices as SelectOption[]) : [];
}

/** Resolves an input to an option id, accepting either the id or the label (as a paste would). */
function resolveChoice(input: string, choices: SelectOption[]): SelectOption | null {
  const byId = choices.find((c) => c.id === input);
  if (byId) return byId;
  const lower = input.toLowerCase();
  return choices.find((c) => c.label.toLowerCase() === lower) ?? null;
}

export const singleSelect: FieldTypeSpec<string> = {
  type: 'singleSelect',
  label: 'Single select',
  group: 'choice',
  slotFamily: 'string',
  computed: false,
  optionsSchema: selectOptions,
  defaultOptions: () => ({ choices: [], allowNewOptions: false }),

  parse(input, ctx) {
    const value = normaliseText(input);
    if (value === null) return ok(null);

    const choices = readChoices(ctx.options);
    const match = resolveChoice(value, choices);
    if (match) return ok(match.id);

    if (ctx.options['allowNewOptions'] === true) {
      // The caller is responsible for persisting the new option onto the field; returning the
      // label here would store a value the field does not know about.
      return fail(`"${value}" is not an existing option`);
    }
    return fail(
      choices.length === 0
        ? 'this field has no options configured yet'
        : `must be one of: ${choices.map((c) => c.label).join(', ')}`,
    );
  },

  serialize: (value) => value,
  toText(value, ctx) {
    if (value === null) return '';
    return readChoices(ctx.options).find((c) => c.id === value)?.label ?? value;
  },
  /**
   * Promoted as the option's position, not its id or label.
   *
   * Sorting a status column alphabetically ("Blocked, Done, In progress, To do") is useless.
   * Sorting by the author's arrangement is what people mean by "sort by status", so the slot
   * carries a sortable rank. It is a string slot to keep the slot budget simple; positions are
   * zero-padded so lexicographic order matches numeric order.
   */
  toSlot(value, ctx) {
    if (value === null) return null;
    const choice = readChoices(ctx.options).find((c) => c.id === value);
    const position = choice?.position ?? 9_999;
    return String(position).padStart(5, '0');
  },
  // The slot is a sort key, not the value — see `slotPreservesValue` in spec.ts. Filters on this
  // field compare the stored option id through JSONB; only ordering uses the column.
  slotPreservesValue: false,
  fromText(text, ctx) {
    return this.parse(text, ctx);
  },
  operators: OPERATORS.singleChoice,
  isEmpty: (value) => value === null,
};

export const multipleSelect: FieldTypeSpec<string[]> = {
  type: 'multipleSelect',
  label: 'Multiple select',
  group: 'choice',
  slotFamily: null,
  computed: false,
  optionsSchema: selectOptions,
  defaultOptions: () => ({ choices: [], allowNewOptions: false }),

  parse(input, ctx) {
    if (input === null || input === undefined || input === '') return ok(null);

    // A pasted cell arrives as "A, B"; the API sends an array. Both are accepted.
    const raw = Array.isArray(input)
      ? input.map((v) => normaliseText(v)).filter((v): v is string => v !== null)
      : String(input)
          .split(',')
          .map((v) => v.trim())
          .filter(Boolean);

    if (raw.length === 0) return ok(null);
    if (raw.length > 100) return fail('must have at most 100 selections');

    const choices = readChoices(ctx.options);
    const resolved: string[] = [];
    for (const item of raw) {
      const match = resolveChoice(item, choices);
      if (!match) return fail(`"${item}" is not an existing option`);
      // Deduplicated: selecting the same option twice is meaningless, and leaving duplicates in
      // makes every downstream count wrong.
      if (!resolved.includes(match.id)) resolved.push(match.id);
    }
    return ok(resolved);
  },

  serialize: (value) => value ?? [],
  toText(value, ctx) {
    if (!value?.length) return '';
    const choices = readChoices(ctx.options);
    return value.map((id) => choices.find((c) => c.id === id)?.label ?? id).join(', ');
  },
  toSlot: () => null,
  fromText(text, ctx) {
    return this.parse(text, ctx);
  },
  operators: OPERATORS.multiChoice,
  isEmpty: (value) => !value || value.length === 0,
  // Order is not meaningful for a set of selections, so two orderings of the same options are
  // the same value. Without this, reordering would register as an edit and create a revision.
  equals: (a, b) => {
    if (!a || !b) return (a?.length ?? 0) === (b?.length ?? 0);
    if (a.length !== b.length) return false;
    const sortedA = [...a].sort();
    const sortedB = [...b].sort();
    return sortedA.every((value, index) => value === sortedB[index]);
  },
};

/**
 * Status: a single select with lifecycle semantics layered on.
 *
 * Distinct from `singleSelect` because a status has a notion of "done", which automations,
 * progress rollups, and board views all need to ask about without hard-coding option names.
 */
export const status: FieldTypeSpec<string> = {
  ...singleSelect,
  type: 'status',
  label: 'Status',
  optionsSchema: selectOptions.extend({
    doneChoiceIds: z.array(z.string()).max(50).optional(),
  }),
  defaultOptions: () => ({
    choices: [
      { id: 'todo', label: 'To do', color: '#94a3b8', position: 0 },
      { id: 'in_progress', label: 'In progress', color: '#0d7377', position: 1 },
      { id: 'done', label: 'Done', color: '#168054', position: 2 },
    ],
    doneChoiceIds: ['done'],
    allowNewOptions: false,
  }),
};

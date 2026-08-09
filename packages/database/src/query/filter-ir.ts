import { FILTER_OPERATORS, type FilterOperator } from '@tessera/types';
import { z } from 'zod';

/**
 * The query intermediate representation.
 *
 * Both the structured filter the UI sends and the `filterByFormula` string the public API
 * accepts are parsed into this shape, and only this shape is compiled to SQL. Having exactly
 * one path into the compiler is what makes the injection surface auditable: there is one place
 * where a value can become part of a statement, and it binds parameters.
 */

export const filterConditionSchema = z.object({
  fieldId: z.string().min(1).max(40),
  operator: z.enum(FILTER_OPERATORS),
  /** Absent for presence operators (`isEmpty`, `hasLinkedRecords`). */
  value: z.unknown().optional(),
});

export type FilterCondition = z.infer<typeof filterConditionSchema>;

export interface FilterGroup {
  readonly conjunction: 'and' | 'or';
  readonly conditions: ReadonlyArray<FilterCondition | FilterGroup>;
}

/**
 * Nesting is capped at five levels.
 *
 * Not an arbitrary number: each level multiplies the planner's work and the UI's ability to
 * render the tree legibly, and a filter that needs six levels is a formula field waiting to be
 * created. The cap also bounds the recursive compiler, so a malicious payload cannot blow the
 * stack.
 */
export const MAX_FILTER_DEPTH = 5;
export const MAX_FILTER_CONDITIONS = 100;

export const filterGroupSchema: z.ZodType<FilterGroup> = z.lazy(() =>
  z.object({
    conjunction: z.enum(['and', 'or']),
    conditions: z
      .array(z.union([filterConditionSchema, filterGroupSchema]))
      .max(MAX_FILTER_CONDITIONS),
  }),
);

export function isGroup(node: FilterCondition | FilterGroup): node is FilterGroup {
  return 'conjunction' in node;
}

/** Rejects a filter tree that is too deep or too large before any SQL is generated. */
export function assertFilterBounds(group: FilterGroup, depth = 0): void {
  if (depth > MAX_FILTER_DEPTH) {
    throw new Error(`Filter nesting exceeds the maximum depth of ${MAX_FILTER_DEPTH}.`);
  }
  let count = 0;
  for (const node of group.conditions) {
    count += 1;
    if (count > MAX_FILTER_CONDITIONS) {
      throw new Error(`A filter group may hold at most ${MAX_FILTER_CONDITIONS} conditions.`);
    }
    if (isGroup(node)) assertFilterBounds(node, depth + 1);
  }
}

/** Every field referenced anywhere in the tree — used to validate against the table's schema. */
export function referencedFieldIds(group: FilterGroup, into = new Set<string>()): Set<string> {
  for (const node of group.conditions) {
    if (isGroup(node)) referencedFieldIds(node, into);
    else into.add(node.fieldId);
  }
  return into;
}

// ── Sorting ─────────────────────────────────────────────────────────────────

export const sortSchema = z.object({
  fieldId: z.string().min(1).max(40),
  direction: z.enum(['asc', 'desc']).default('asc'),
  /** Where nulls land. Defaults to last, which is what people expect for "empty". */
  nulls: z.enum(['first', 'last']).optional(),
});

export type SortSpec = z.infer<typeof sortSchema>;

export const MAX_SORTS = 5;

// ── Grouping ────────────────────────────────────────────────────────────────

export const groupSchema = z.object({
  fieldId: z.string().min(1).max(40),
  direction: z.enum(['asc', 'desc']).default('asc'),
});

export type GroupSpec = z.infer<typeof groupSchema>;

export const MAX_GROUPS = 3;

// ── The whole query ─────────────────────────────────────────────────────────

export const viewQuerySchema = z.object({
  filter: filterGroupSchema.optional(),
  sort: z.array(sortSchema).max(MAX_SORTS).optional(),
  group: z.array(groupSchema).max(MAX_GROUPS).optional(),
  /** Restricts the returned payload; the query still reads what filters and sorts require. */
  fieldIds: z.array(z.string().min(1).max(40)).max(500).optional(),
  search: z.string().max(500).optional(),
  limit: z.number().int().min(1).max(1_000).default(100),
  cursor: z.string().max(2_048).optional(),
});

export type ViewQuery = z.infer<typeof viewQuerySchema>;

/** Operators that take no value; supplying one is a client bug worth reporting. */
export const VALUELESS_OPERATORS: ReadonlySet<FilterOperator> = new Set<FilterOperator>([
  'isEmpty',
  'isNotEmpty',
  'isCurrentUser',
  'hasLinkedRecords',
  'hasNoLinkedRecords',
]);

/** Operators whose value is a list. */
export const LIST_OPERATORS: ReadonlySet<FilterOperator> = new Set<FilterOperator>([
  'isAnyOf',
  'isNoneOf',
  'hasAnyOf',
  'hasAllOf',
  'isBetween',
]);

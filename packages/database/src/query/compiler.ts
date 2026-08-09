import { getFieldSpec, type FieldDefinition } from '@tessera/fields';
import { AppError, type FilterOperator } from '@tessera/types';

import {
  VALUELESS_OPERATORS,
  isGroup,
  type FilterCondition,
  type FilterGroup,
} from './filter-ir';
import { type SqlBuilder, assertFieldId, ident, jsonPath } from './sql-builder';

/**
 * Compiles a filter tree into a SQL predicate.
 *
 * Two expressions can be produced for any field:
 *
 *   • **promoted** — the field has been assigned a typed slot column, so the predicate reads a
 *     real column with a real btree index and real planner statistics.
 *   • **unpromoted** — the predicate reads `data ->> 'fldX'`, casting where the comparison needs
 *     it, and leans on the GIN index for containment.
 *
 * The caller does not choose; the field's `promotedSlot` decides. That is the entire benefit of
 * the hybrid storage model: the same filter is correct either way, and gets faster when the
 * field is promoted, without the query builder or the API changing shape.
 *
 * See docs/02-database-design.md §1.5.
 */

export interface CompileContext {
  readonly fields: ReadonlyMap<string, FieldDefinition>;
  /** Resolves `isCurrentUser` and relative date filters. */
  readonly currentUserId: string | null;
  readonly now: Date;
  readonly timezone: string;
}

export function compileFilter(
  builder: SqlBuilder,
  group: FilterGroup,
  ctx: CompileContext,
): string {
  const parts: string[] = [];

  for (const node of group.conditions) {
    const sql = isGroup(node)
      ? compileFilter(builder, node, ctx)
      : compileCondition(builder, node, ctx);
    if (sql) parts.push(sql);
  }

  if (parts.length === 0) {
    // An empty group must not silently become "match everything" for an `and`, nor "match
    // nothing" for an `or`. Neutral elements keep the semantics honest.
    return group.conjunction === 'and' ? 'TRUE' : 'FALSE';
  }
  if (parts.length === 1) return parts[0] as string;

  return `(${parts.join(group.conjunction === 'and' ? ' AND ' : ' OR ')})`;
}

function compileCondition(
  builder: SqlBuilder,
  condition: FilterCondition,
  ctx: CompileContext,
): string {
  assertFieldId(condition.fieldId);

  const field = ctx.fields.get(condition.fieldId);
  if (!field) {
    throw new AppError('VALIDATION_FAILED', `Unknown field in filter: ${condition.fieldId}`);
  }

  const spec = getFieldSpec(field.type);
  if (!spec.operators.includes(condition.operator)) {
    throw new AppError(
      'FIELD_TYPE_MISMATCH',
      `The operator "${condition.operator}" cannot be used with the field "${field.name}".`,
      { details: { fieldId: field.id, type: field.type, allowed: spec.operators } },
    );
  }

  if (!VALUELESS_OPERATORS.has(condition.operator) && condition.value === undefined) {
    throw new AppError(
      'VALIDATION_FAILED',
      `The operator "${condition.operator}" requires a value.`,
    );
  }

  // A slot is only usable for comparison when it holds the value itself. Where it holds a
  // derived sort key instead (single-select stores the option's position), the predicate must
  // read the JSONB value or it compares against the wrong thing and matches nothing.
  const slot = spec.slotPreservesValue === false ? null : field.promotedSlot ?? null;
  const family = spec.slotFamily;

  switch (family) {
    case 'number':
      return numericPredicate(builder, condition, field, slot);
    case 'date':
      return temporalPredicate(builder, condition, field, slot, ctx);
    case 'boolean':
      return booleanPredicate(builder, condition, field, slot);
    case 'string':
    case null:
    default:
      return textPredicate(builder, condition, field, slot, spec.type, ctx);
  }
}

// ── Per-family predicates ───────────────────────────────────────────────────

function numericPredicate(
  builder: SqlBuilder,
  condition: FilterCondition,
  field: FieldDefinition,
  slot: string | null,
): string {
  // The cast is what makes an unpromoted numeric filter correct: `data ->> 'x'` is text, and
  // text comparison would order 10 before 9.
  const column = slot ? ident(slot) : `${jsonPath(builder, field.id)}::numeric`;
  const value = condition.value;

  switch (condition.operator) {
    case 'isEmpty':
      return `${column} IS NULL`;
    case 'isNotEmpty':
      return `${column} IS NOT NULL`;
    case 'is':
      return `${column} = ${builder.bind(toNumber(value))}`;
    case 'isNot':
      // NULL is not "not equal to 5" in SQL's three-valued logic, but a user filtering for
      // "status is not done" expects blank rows back. The explicit IS NULL branch is the
      // difference between a filter people trust and one they work around.
      return `(${column} IS NULL OR ${column} <> ${builder.bind(toNumber(value))})`;
    case 'isGreater':
      return `${column} > ${builder.bind(toNumber(value))}`;
    case 'isGreaterOrEqual':
      return `${column} >= ${builder.bind(toNumber(value))}`;
    case 'isLess':
      return `${column} < ${builder.bind(toNumber(value))}`;
    case 'isLessOrEqual':
      return `${column} <= ${builder.bind(toNumber(value))}`;
    case 'isBetween': {
      const [low, high] = expectPair(value);
      return `${column} BETWEEN ${builder.bind(toNumber(low))} AND ${builder.bind(toNumber(high))}`;
    }
    default:
      throw unsupported(condition.operator, field);
  }
}

function temporalPredicate(
  builder: SqlBuilder,
  condition: FilterCondition,
  field: FieldDefinition,
  slot: string | null,
  ctx: CompileContext,
): string {
  const column = slot ? ident(slot) : `(${jsonPath(builder, field.id)})::timestamptz`;

  switch (condition.operator) {
    case 'isEmpty':
      return `${column} IS NULL`;
    case 'isNotEmpty':
      return `${column} IS NOT NULL`;
    case 'is': {
      // "is 4 March" means anywhere in that day, not exactly midnight — comparing instants for
      // equality would match almost nothing.
      const { start, end } = dayBounds(resolveDate(condition.value, ctx));
      return `(${column} >= ${builder.bind(start)} AND ${column} < ${builder.bind(end)})`;
    }
    case 'isNot': {
      const { start, end } = dayBounds(resolveDate(condition.value, ctx));
      return `(${column} IS NULL OR ${column} < ${builder.bind(start)} OR ${column} >= ${builder.bind(end)})`;
    }
    case 'isBefore':
      return `${column} < ${builder.bind(resolveDate(condition.value, ctx))}`;
    case 'isAfter':
      return `${column} > ${builder.bind(resolveDate(condition.value, ctx))}`;
    case 'isOnOrBefore':
      return `${column} <= ${builder.bind(dayBounds(resolveDate(condition.value, ctx)).end)}`;
    case 'isOnOrAfter':
      return `${column} >= ${builder.bind(dayBounds(resolveDate(condition.value, ctx)).start)}`;
    case 'isWithin': {
      const [from, to] = expectPair(condition.value);
      return `(${column} >= ${builder.bind(resolveDate(from, ctx))} AND ${column} <= ${builder.bind(resolveDate(to, ctx))})`;
    }
    default:
      throw unsupported(condition.operator, field);
  }
}

function booleanPredicate(
  builder: SqlBuilder,
  condition: FilterCondition,
  field: FieldDefinition,
  slot: string | null,
): string {
  const column = slot ? ident(slot) : `(${jsonPath(builder, field.id)})::boolean`;
  if (condition.operator !== 'is') throw unsupported(condition.operator, field);

  // An unchecked checkbox may be stored as `false` or be absent entirely (a record created
  // before the field existed). Both must satisfy "is false", or the filter appears broken on
  // exactly the rows a user is most likely to be looking for.
  return condition.value === true
    ? `${column} IS TRUE`
    : `(${column} IS FALSE OR ${column} IS NULL)`;
}

function textPredicate(
  builder: SqlBuilder,
  condition: FilterCondition,
  field: FieldDefinition,
  slot: string | null,
  type: string,
  ctx: CompileContext,
): string {
  const isMulti = type === 'multipleSelect' || type === 'multipleUsers';
  const column = slot ? ident(slot) : jsonPath(builder, field.id);

  switch (condition.operator) {
    case 'isEmpty':
      return isMulti
        ? `(r.data -> ${builder.bind(field.id)} IS NULL OR jsonb_array_length(COALESCE(r.data -> ${builder.bind(field.id)}, '[]'::jsonb)) = 0)`
        : `(${column} IS NULL OR ${column} = '')`;
    case 'isNotEmpty':
      return isMulti
        ? `jsonb_array_length(COALESCE(r.data -> ${builder.bind(field.id)}, '[]'::jsonb)) > 0`
        : `(${column} IS NOT NULL AND ${column} <> '')`;

    case 'is':
      return `${column} = ${builder.bind(String(condition.value))}`;
    case 'isNot':
      return `(${column} IS NULL OR ${column} <> ${builder.bind(String(condition.value))})`;

    // ILIKE with the pattern metacharacters escaped: a user searching for "50%" means the
    // literal string, not "starts with 50".
    case 'contains':
      return `${column} ILIKE ${builder.bind(`%${escapeLike(String(condition.value))}%`)} ESCAPE '\\'`;
    case 'doesNotContain':
      return `(${column} IS NULL OR ${column} NOT ILIKE ${builder.bind(`%${escapeLike(String(condition.value))}%`)} ESCAPE '\\')`;
    case 'startsWith':
      return `${column} ILIKE ${builder.bind(`${escapeLike(String(condition.value))}%`)} ESCAPE '\\'`;
    case 'endsWith':
      return `${column} ILIKE ${builder.bind(`%${escapeLike(String(condition.value))}`)} ESCAPE '\\'`;

    case 'isAnyOf':
      return `${column} IN ${builder.bindList(expectList(condition.value).map(String))}`;
    case 'isNoneOf':
      return `(${column} IS NULL OR ${column} NOT IN ${builder.bindList(expectList(condition.value).map(String))})`;

    // Array containment on the JSONB value, which the GIN index serves directly.
    case 'hasAnyOf': {
      const values = expectList(condition.value).map(String);
      const clauses = values.map(
        (value) => `r.data -> ${builder.bind(field.id)} @> ${builder.bind(JSON.stringify([value]))}::jsonb`,
      );
      return clauses.length > 0 ? `(${clauses.join(' OR ')})` : 'FALSE';
    }
    case 'hasAllOf':
      return `r.data -> ${builder.bind(field.id)} @> ${builder.bind(JSON.stringify(expectList(condition.value).map(String)))}::jsonb`;

    case 'isCurrentUser':
      if (!ctx.currentUserId) return 'FALSE';
      return isMulti
        ? `r.data -> ${builder.bind(field.id)} @> ${builder.bind(JSON.stringify([ctx.currentUserId]))}::jsonb`
        : `${column} = ${builder.bind(ctx.currentUserId)}`;

    default:
      throw unsupported(condition.operator, field);
  }
}

// ── Helpers ─────────────────────────────────────────────────────────────────

function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (match) => `\\${match}`);
}

function toNumber(value: unknown): number {
  const parsed = typeof value === 'number' ? value : Number(String(value).replace(/[\s,]/g, ''));
  if (!Number.isFinite(parsed)) {
    throw new AppError('VALIDATION_FAILED', `"${String(value)}" is not a number.`);
  }
  return parsed;
}

function expectPair(value: unknown): [unknown, unknown] {
  if (!Array.isArray(value) || value.length !== 2) {
    throw new AppError('VALIDATION_FAILED', 'This operator needs exactly two values.');
  }
  return [value[0], value[1]];
}

function expectList(value: unknown): unknown[] {
  if (!Array.isArray(value)) {
    throw new AppError('VALIDATION_FAILED', 'This operator needs a list of values.');
  }
  if (value.length > 500) {
    throw new AppError('VALIDATION_FAILED', 'A filter list may hold at most 500 values.');
  }
  return value;
}

/**
 * Resolves a date filter value, including the relative tokens the UI offers.
 *
 * Relative dates are resolved at query time rather than stored as absolute instants, so a view
 * filtered to "today" is still correct tomorrow — which is the entire point of saving it.
 */
function resolveDate(value: unknown, ctx: CompileContext): Date {
  if (value instanceof Date) return value;

  const text = String(value ?? '').trim();
  const now = ctx.now;

  switch (text) {
    case 'today':
      return startOfDay(now);
    case 'tomorrow':
      return startOfDay(addDays(now, 1));
    case 'yesterday':
      return startOfDay(addDays(now, -1));
    case 'oneWeekAgo':
      return startOfDay(addDays(now, -7));
    case 'oneWeekFromNow':
      return startOfDay(addDays(now, 7));
    case 'oneMonthAgo':
      return startOfDay(addDays(now, -30));
    case 'oneMonthFromNow':
      return startOfDay(addDays(now, 30));
    default: {
      const parsed = new Date(text);
      if (Number.isNaN(parsed.getTime())) {
        throw new AppError('VALIDATION_FAILED', `"${text}" is not a date.`);
      }
      return parsed;
    }
  }
}

function startOfDay(value: Date): Date {
  return new Date(Date.UTC(value.getUTCFullYear(), value.getUTCMonth(), value.getUTCDate()));
}

function addDays(value: Date, days: number): Date {
  return new Date(value.getTime() + days * 86_400_000);
}

function dayBounds(value: Date): { start: Date; end: Date } {
  const start = startOfDay(value);
  return { start, end: addDays(start, 1) };
}

function unsupported(operator: FilterOperator, field: FieldDefinition): AppError {
  return new AppError(
    'FIELD_TYPE_MISMATCH',
    `The operator "${operator}" is not supported for "${field.name}".`,
    { details: { fieldId: field.id, type: field.type } },
  );
}

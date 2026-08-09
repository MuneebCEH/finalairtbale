import { createHash } from 'node:crypto';

import { getFieldSpec, type FieldDefinition } from '@tessera/fields';
import { AppError, decodeCursor, encodeCursor, type CursorPayload } from '@tessera/types';

import { compileFilter, type CompileContext } from './compiler';
import { assertFilterBounds, type GroupSpec, type SortSpec, type ViewQuery } from './filter-ir';
import { SqlBuilder, assertFieldId, ident, jsonPath } from './sql-builder';

/**
 * Builds the query behind every grid page.
 *
 * The rules encoded here are the ones from docs/09-scaling-strategy.md §3, and they are not
 * negotiable per call site:
 *
 *   • never `OFFSET` — cursor only, because offset both skips rows under concurrent writes and
 *     costs O(n) to reach page n;
 *   • never `COUNT(*)` on a view load — an exact count of a filtered million-row table is a
 *     sequential scan for a number nobody reads;
 *   • always a tiebreak on `id` — without it, rows with equal sort values come back in an
 *     unstable order and pagination silently drops or repeats them;
 *   • always a `LIMIT`.
 */

export interface ViewQueryInput {
  readonly organizationId: string;
  readonly tableId: string;
  readonly query: ViewQuery;
  readonly fields: readonly FieldDefinition[];
  readonly currentUserId: string | null;
  readonly now?: Date;
  readonly timezone?: string;
}

export interface CompiledQuery {
  readonly sql: string;
  readonly values: readonly unknown[];
  /** Fetched limit + 1, so `hasMore` is known without a second query. */
  readonly limit: number;
  readonly sorts: readonly SortSpec[];
  /** Identifies the query shape; a cursor from a different shape is rejected, not misread. */
  readonly shapeHash: string;
}

export function buildViewQuery(input: ViewQueryInput): CompiledQuery {
  const { query, fields } = input;
  const fieldMap = new Map(fields.map((field) => [field.id, field]));

  const ctx: CompileContext = {
    fields: fieldMap,
    currentUserId: input.currentUserId,
    now: input.now ?? new Date(),
    timezone: input.timezone ?? 'UTC',
  };

  const builder = new SqlBuilder();
  const limit = Math.min(Math.max(query.limit ?? 100, 1), 1_000);

  // Grouping is expressed as leading sort keys. A grid that groups by Status and sorts by Due
  // date is asking for `ORDER BY status, due_date`, so there is no separate mechanism — and
  // group boundaries fall out of the ordering the client already receives.
  const sorts = combineSorts(query.group ?? [], query.sort ?? [], fieldMap);
  const shapeHash = hashShape(input);

  builder.push('SELECT r.id, r.version, r.data, r.auto_number, r.created_at, r.updated_at,');
  builder.push('       r.created_by, r.updated_by');
  builder.push('FROM records r');
  builder.push(`WHERE r.organization_id = ${builder.bind(input.organizationId)}`);
  builder.push(`  AND r.table_id = ${builder.bind(input.tableId)}`);
  builder.push('  AND r.deleted_at IS NULL');

  if (query.filter) {
    assertFilterBounds(query.filter);
    const predicate = compileFilter(builder, query.filter, ctx);
    builder.push(`  AND ${predicate}`);
  }

  if (query.search) {
    // Cheap cross-field text match. Full-text search with ranking is the search service's job
    // (Phase 9); this is the grid's find-as-you-type, which only needs to be correct and fast
    // enough on one table.
    builder.push(
      `  AND jsonb_path_query_array(r.data, '$.*')::text ILIKE ${builder.bind(`%${query.search.replace(/[\\%_]/g, (m) => `\\${m}`)}%`)} ESCAPE '\\'`,
    );
  }

  const cursor = query.cursor ? decodeCursor(query.cursor) : null;
  if (query.cursor && !cursor) {
    throw new AppError('MALFORMED_REQUEST', 'The pagination cursor is not valid.');
  }
  if (cursor && cursor.q !== shapeHash) {
    // The filter or sort changed between pages. Continuing would return an arbitrary slice of a
    // different result set, which looks like data loss to the user.
    throw new AppError('MALFORMED_REQUEST', 'The query changed; restart from the first page.', {
      details: { reason: 'cursor_shape_mismatch' },
    });
  }
  if (cursor) {
    builder.push(`  AND ${cursorPredicate(builder, cursor, sorts, fieldMap)}`);
  }

  builder.push(`ORDER BY ${orderByClause(builder, sorts, fieldMap)}`);
  builder.push(`LIMIT ${builder.bind(limit + 1)}`);

  return { sql: builder.sql, values: builder.values, limit, sorts, shapeHash };
}

// ── Ordering ────────────────────────────────────────────────────────────────

function combineSorts(
  groups: readonly GroupSpec[],
  sorts: readonly SortSpec[],
  fields: ReadonlyMap<string, FieldDefinition>,
): SortSpec[] {
  const combined: SortSpec[] = [
    ...groups.map((group) => ({ fieldId: group.fieldId, direction: group.direction })),
    ...sorts,
  ];

  for (const sort of combined) {
    assertFieldId(sort.fieldId);
    if (!fields.has(sort.fieldId)) {
      throw new AppError('VALIDATION_FAILED', `Unknown field in sort: ${sort.fieldId}`);
    }
  }
  return combined;
}

function sortExpression(
  builder: SqlBuilder,
  sort: SortSpec,
  fields: ReadonlyMap<string, FieldDefinition>,
): string {
  const field = fields.get(sort.fieldId) as FieldDefinition;
  const spec = getFieldSpec(field.type);

  if (field.promotedSlot) return ident(field.promotedSlot);

  // Unpromoted: cast so the ordering matches the type's semantics rather than text order.
  // This is the path that field promotion exists to replace — it is correct but cannot use an
  // index, so a sort on a large unpromoted field is what triggers promotion.
  switch (spec.slotFamily) {
    case 'number':
      return `${jsonPath(builder, field.id)}::numeric`;
    case 'date':
      return `(${jsonPath(builder, field.id)})::timestamptz`;
    case 'boolean':
      return `(${jsonPath(builder, field.id)})::boolean`;
    default:
      // Locale-aware ordering so "Zoë" sorts next to "Zoe" rather than after "Zulu".
      return `${jsonPath(builder, field.id)} COLLATE "und-x-icu"`;
  }
}

function orderByClause(
  builder: SqlBuilder,
  sorts: readonly SortSpec[],
  fields: ReadonlyMap<string, FieldDefinition>,
): string {
  const parts = sorts.map((sort) => {
    const expression = sortExpression(builder, sort, fields);
    const direction = sort.direction === 'desc' ? 'DESC' : 'ASC';
    const nulls = sort.nulls === 'first' ? 'NULLS FIRST' : 'NULLS LAST';
    return `${expression} ${direction} ${nulls}`;
  });

  // The mandatory tiebreak. Ascending always, regardless of the user's sort direction, because
  // its only job is to make the order total and the cursor comparison well-defined.
  parts.push('r.id ASC');
  return parts.join(', ');
}

/**
 * The keyset predicate.
 *
 * For a single sort key this is the familiar `(k, id) > ($1, $2)` row comparison. Multiple keys
 * with mixed directions cannot use a row comparison — Postgres requires every column in a row
 * comparison to share a direction — so it is expanded into the standard lexicographic
 * disjunction instead.
 */
function cursorPredicate(
  builder: SqlBuilder,
  cursor: CursorPayload,
  sorts: readonly SortSpec[],
  fields: ReadonlyMap<string, FieldDefinition>,
): string {
  if (sorts.length === 0) {
    return `r.id > ${builder.bind(cursor.i)}`;
  }
  if (cursor.k.length !== sorts.length) {
    throw new AppError('MALFORMED_REQUEST', 'The pagination cursor does not match the sort.');
  }

  const clauses: string[] = [];

  for (let index = 0; index < sorts.length; index += 1) {
    const equalities: string[] = [];

    for (let prior = 0; prior < index; prior += 1) {
      const priorSort = sorts[prior] as SortSpec;
      const expression = sortExpression(builder, priorSort, fields);
      const value = cursor.k[prior] ?? null;
      equalities.push(
        value === null
          ? `${expression} IS NULL`
          : `${expression} = ${builder.bind(value)}`,
      );
    }

    const sort = sorts[index] as SortSpec;
    const expression = sortExpression(builder, sort, fields);
    const value = cursor.k[index] ?? null;
    const comparator = sort.direction === 'desc' ? '<' : '>';
    const nullsLast = sort.nulls !== 'first';

    let step: string;
    if (value === null) {
      // Past the null block: with NULLS LAST nothing follows a null except by the tiebreak, so
      // the only rows still to come are non-null ones when nulls come first.
      step = nullsLast ? 'FALSE' : `${expression} IS NOT NULL`;
    } else {
      step = nullsLast
        ? `(${expression} ${comparator} ${builder.bind(value)} OR ${expression} IS NULL)`
        : `${expression} ${comparator} ${builder.bind(value)}`;
    }

    clauses.push([...equalities, step].join(' AND '));
  }

  // Final clause: every sort key equal, so the tiebreak decides.
  const allEqual = sorts.map((sort, index) => {
    const expression = sortExpression(builder, sort, fields);
    const value = cursor.k[index] ?? null;
    return value === null ? `${expression} IS NULL` : `${expression} = ${builder.bind(value)}`;
  });
  clauses.push([...allEqual, `r.id > ${builder.bind(cursor.i)}`].join(' AND '));

  return `(${clauses.map((clause) => `(${clause})`).join(' OR ')})`;
}

// ── Cursor emission ─────────────────────────────────────────────────────────

export interface RecordRow {
  id: string;
  version: number;
  data: Record<string, unknown>;
  auto_number: bigint | number;
  created_at: Date;
  updated_at: Date;
  created_by: string | null;
  updated_by: string | null;
}

/** Builds the cursor for the last row of a page. */
export function cursorForRow(
  row: RecordRow,
  sorts: readonly SortSpec[],
  fields: ReadonlyMap<string, FieldDefinition>,
  shapeHash: string,
): string {
  const keys = sorts.map((sort) => {
    const field = fields.get(sort.fieldId);
    if (!field) return null;
    const spec = getFieldSpec(field.type);
    const slotValue = spec.toSlot(row.data[field.id] ?? null, {
      fieldId: field.id,
      name: field.name,
      options: field.options,
    });
    // Dates travel as ISO strings so the cursor survives JSON encoding intact.
    return slotValue instanceof Date ? slotValue.toISOString() : slotValue;
  });

  return encodeCursor({ v: 1, k: keys, i: row.id, q: shapeHash });
}

/**
 * Hashes the query shape.
 *
 * Only the parts that determine the result *ordering and membership* are included — the limit
 * and the cursor itself are not, so changing page size mid-scroll does not invalidate the
 * cursor, while changing a filter does.
 */
function hashShape(input: ViewQueryInput): string {
  const shape = JSON.stringify({
    table: input.tableId,
    filter: input.query.filter ?? null,
    sort: input.query.sort ?? [],
    group: input.query.group ?? [],
    search: input.query.search ?? null,
  });
  return createHash('sha256').update(shape).digest('hex').slice(0, 16);
}

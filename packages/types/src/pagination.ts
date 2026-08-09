/**
 * Cursor pagination.
 *
 * Offset pagination is not offered anywhere in this platform. With concurrent writes it silently
 * skips and duplicates rows, and `OFFSET n` costs O(n) in Postgres — both fatal on a table with
 * millions of records. See docs/09-scaling-strategy.md §3.
 */

export interface PageRequest {
  readonly limit: number;
  readonly cursor?: string;
}

export interface PageMeta {
  readonly hasMore: boolean;
  readonly nextCursor: string | null;
  readonly count: number;
}

export interface Page<T> {
  readonly data: readonly T[];
  readonly meta: PageMeta;
}

export const PAGE_LIMITS = {
  default: 50,
  max: 200,
  /** Grid pages are larger because the client windows them and prefetches neighbours. */
  records: { default: 100, max: 1000 },
} as const;

/**
 * A cursor encodes the sort key of the last row plus its id tiebreak. The id is mandatory:
 * without it, rows with equal sort values are returned in an unstable order and pagination
 * loses or repeats them.
 */
export interface CursorPayload {
  readonly v: 1;
  /** Values of the sort keys for the last row of the previous page, in sort order. */
  readonly k: readonly (string | number | boolean | null)[];
  /** Tiebreak id. */
  readonly i: string;
  /** Hash of the query shape; a cursor from a different query is rejected rather than misread. */
  readonly q: string;
}

export function encodeCursor(payload: CursorPayload): string {
  return Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
}

export function decodeCursor(cursor: string): CursorPayload | null {
  try {
    const parsed: unknown = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
    if (
      typeof parsed === 'object' &&
      parsed !== null &&
      (parsed as CursorPayload).v === 1 &&
      Array.isArray((parsed as CursorPayload).k) &&
      typeof (parsed as CursorPayload).i === 'string' &&
      typeof (parsed as CursorPayload).q === 'string'
    ) {
      return parsed as CursorPayload;
    }
    return null;
  } catch {
    return null;
  }
}

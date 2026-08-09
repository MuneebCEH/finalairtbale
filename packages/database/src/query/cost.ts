/**
 * Query cost estimation and admission control.
 *
 * A multi-tenant database is only as available as its most expensive query. One customer sorting
 * a million rows on an unindexed JSONB path can make every other customer's requests time out,
 * and nothing about that query is *wrong* — it is just far more expensive than the person who
 * wrote it realised.
 *
 * So cost is estimated before the query runs and expensive ones are refused with an explanation,
 * rather than accepted and left to a statement timeout. The difference matters: a timeout costs
 * the full timeout in database work and reports as an outage; a refusal costs nothing and reports
 * as "this filter needs an index".
 */

export interface QueryShape {
  /** Rows in the table, from the maintained counter rather than COUNT(*). */
  readonly tableRows: number;
  /** Filter conditions, split by whether each can use an index. */
  readonly indexedPredicates: number;
  readonly unindexedPredicates: number;
  /** Sort keys that resolve to a promoted column, and those that do not. */
  readonly indexedSorts: number;
  readonly unindexedSorts: number;
  readonly limit: number;
  /** True when the request asks for a page beyond the first via a cursor. */
  readonly deepPage: boolean;
  /** Joins across a link table, each of which multiplies the scanned set. */
  readonly linkJoins: number;
}

export interface CostEstimate {
  /** Rough row-touches. Not a real planner estimate — an order of magnitude, deliberately. */
  readonly cost: number;
  readonly admit: boolean;
  readonly reason?: string;
  /** What would make it cheap, phrased for the person who wrote the filter. */
  readonly remedy?: string;
}

/**
 * Above this, a query is refused.
 *
 * Chosen so a table of a million rows can be filtered and sorted on indexed columns without
 * trouble, while a full scan with an unindexed sort is refused. It is a blunt instrument on
 * purpose — a precise cost model would need the planner's statistics and would drift out of
 * agreement with them anyway.
 */
export const MAX_QUERY_COST = 5_000_000;

/** An unindexed predicate has to read every row it cannot exclude. */
const UNINDEXED_PREDICATE_FACTOR = 1;

/** An unindexed sort is worse than an unindexed filter: it cannot stop early. */
const UNINDEXED_SORT_FACTOR = 2;

/** Each index that applies cuts the candidate set. Conservative — real selectivity is unknown. */
const INDEX_SELECTIVITY = 0.1;

export function estimateCost(shape: QueryShape): CostEstimate {
  let candidates = Math.max(shape.tableRows, 1);

  // Indexed predicates narrow the set first. Compounding rather than multiplying by count keeps
  // three indexed filters from being treated as thirty times better than one.
  for (let index = 0; index < shape.indexedPredicates; index += 1) {
    candidates *= INDEX_SELECTIVITY;
  }
  candidates = Math.max(candidates, 1);

  let cost = candidates;

  // Unindexed predicates are applied to whatever survived, row by row.
  cost += candidates * shape.unindexedPredicates * UNINDEXED_PREDICATE_FACTOR;

  // An unindexed sort has to materialise and order the whole candidate set before the limit can
  // be applied — the limit buys nothing.
  if (shape.unindexedSorts > 0) {
    cost += candidates * shape.unindexedSorts * UNINDEXED_SORT_FACTOR;
  } else if (shape.unindexedPredicates === 0) {
    // The scan can stop once the page is filled — but *only* when nothing unindexed has to be
    // evaluated per row. An unindexed predicate that happens to match few rows scans the whole
    // table before finding a page, and the estimator cannot know its selectivity, so the
    // discount is not applied. Assuming early termination there is how a query that reads
    // twenty million rows gets admitted as cheap.
    cost = Math.min(cost, candidates * 0.1 + shape.limit);
  }

  // Each link join multiplies the set it is applied to.
  for (let index = 0; index < shape.linkJoins; index += 1) {
    cost *= 2;
  }

  // A deep page still has to walk to its offset unless the sort is indexed — which is precisely
  // why pagination here is cursor-based.
  if (shape.deepPage && shape.unindexedSorts > 0) cost *= 2;

  cost = Math.ceil(cost);

  if (cost <= MAX_QUERY_COST) return { cost, admit: true };

  // The remedy names the specific thing to change. "Too expensive" with no next step turns into
  // a support ticket.
  if (shape.unindexedSorts > 0) {
    return {
      cost,
      admit: false,
      reason: 'This view sorts on a field that is not indexed, so every matching row must be ordered before the first page can be returned.',
      remedy: 'Sort on a field with a promoted column, or narrow the filter first.',
    };
  }

  if (shape.unindexedPredicates > 0) {
    return {
      cost,
      admit: false,
      reason: 'This filter cannot use an index, so every row in the table has to be examined.',
      remedy: 'Add a condition on an indexed field, or filter to a smaller set first.',
    };
  }

  return {
    cost,
    admit: false,
    reason: 'This query would read more of the table than is safe to do in one request.',
    remedy: 'Narrow the filter, or read the table in pages.',
  };
}

/**
 * A per-tenant concurrency gate.
 *
 * Cost control alone does not stop one tenant issuing a thousand cheap queries at once and
 * consuming the whole connection pool. This bounds how many a single organization can have in
 * flight, so a busy tenant slows itself down rather than everybody else.
 */
export class TenantConcurrency {
  private readonly inFlight = new Map<string, number>();

  constructor(private readonly limit: number = 16) {}

  tryAcquire(organizationId: string): boolean {
    const current = this.inFlight.get(organizationId) ?? 0;
    if (current >= this.limit) return false;
    this.inFlight.set(organizationId, current + 1);
    return true;
  }

  release(organizationId: string): void {
    const current = this.inFlight.get(organizationId) ?? 0;
    // Deleting at zero rather than leaving it keeps the map from growing once per organization
    // that has ever issued a query.
    if (current <= 1) this.inFlight.delete(organizationId);
    else this.inFlight.set(organizationId, current - 1);
  }

  active(organizationId: string): number {
    return this.inFlight.get(organizationId) ?? 0;
  }

  get tracked(): number {
    return this.inFlight.size;
  }
}

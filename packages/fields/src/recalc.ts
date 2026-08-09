/**
 * Recalculation planning for computed fields.
 *
 * When something changes, the question is not "recompute everything" — on a base with a hundred
 * thousand records that is minutes of work for a one-cell edit — but **exactly which computed
 * cells can no longer be trusted**. This module answers that, and nothing else: it does no I/O,
 * so it can be reasoned about and tested directly.
 *
 * Three kinds of edge exist between fields:
 *
 *   formula → the fields it reads          (same table)
 *   lookup  → link field + target field    (crosses to the linked table)
 *   rollup  → link field + target field    (crosses to the linked table)
 *   count   → link field                   (crosses to the linked table)
 *
 * The direction that matters for invalidation is the reverse: given a field that changed, which
 * computed fields *depend on* it.
 */

export interface ComputedFieldRef {
  readonly fieldId: string;
  readonly tableId: string;
  readonly type: 'formula' | 'lookup' | 'rollup' | 'count';
  /** Fields in the same table this one reads. Formula dependencies. */
  readonly reads?: readonly string[];
  /** For lookup/rollup/count: the linked-record field this one travels through. */
  readonly linkFieldId?: string;
  /** For lookup/rollup: the field on the *linked* table whose values are pulled. */
  readonly targetFieldId?: string;
}

export interface FieldGraph {
  readonly computed: readonly ComputedFieldRef[];
}

/**
 * Which computed fields are invalidated by a change.
 *
 * `changedFieldIds` are fields whose *values* changed on some record in `tableId`. Returns the
 * computed fields that must be recomputed, split by whether they live in the same table (so the
 * same records are affected) or across a link (so the affected records must be found by following
 * the link backwards).
 */
export function invalidatedBy(
  graph: FieldGraph,
  tableId: string,
  changedFieldIds: readonly string[],
): { sameTable: ComputedFieldRef[]; acrossLink: ComputedFieldRef[] } {
  const changed = new Set(changedFieldIds);

  const sameTable: ComputedFieldRef[] = [];
  const acrossLink: ComputedFieldRef[] = [];

  for (const field of graph.computed) {
    // A formula in this table that reads one of the changed fields.
    if (field.tableId === tableId && (field.reads ?? []).some((id) => changed.has(id))) {
      sameTable.push(field);
      continue;
    }

    // A lookup/rollup/count in this table whose own link field changed: the set of linked
    // records is different, so the derived value is stale even though nothing on the other side
    // moved.
    if (field.tableId === tableId && field.linkFieldId && changed.has(field.linkFieldId)) {
      sameTable.push(field);
      continue;
    }

    // A lookup/rollup elsewhere that pulls a field which changed here. The records to recompute
    // are the ones linking *to* the changed records, which only the caller can resolve.
    if (field.targetFieldId && changed.has(field.targetFieldId) && field.tableId !== tableId) {
      acrossLink.push(field);
    }
  }

  return { sameTable, acrossLink };
}

/**
 * Orders computed fields so each is calculated after everything it reads.
 *
 * A formula may read a rollup, which reads a lookup, which reads a field on another table.
 * Computing them in declaration order produces a value derived from last cycle's inputs — wrong
 * in a way that looks right, and that corrects itself on the next unrelated edit, which is the
 * hardest kind of bug to be told about.
 *
 * Returns the cycle members instead of an order when one exists, so the caller can refuse the
 * field that closed the loop rather than recursing forever.
 */
export function planOrder(
  fields: readonly ComputedFieldRef[],
): { ok: true; order: ComputedFieldRef[] } | { ok: false; cycle: string[] } {
  const byId = new Map(fields.map((field) => [field.fieldId, field]));
  const pending = new Map<string, Set<string>>();
  const dependents = new Map<string, string[]>();

  for (const field of fields) {
    // Only edges to other *computed* fields constrain the order. A dependency on a plain data
    // column is always already satisfied, and treating it as an edge would deadlock the queue.
    const edges = [...(field.reads ?? []), field.linkFieldId, field.targetFieldId]
      .filter((id): id is string => typeof id === 'string')
      .filter((id) => byId.has(id) && id !== field.fieldId);

    pending.set(field.fieldId, new Set(edges));
    for (const edge of edges) {
      dependents.set(edge, [...(dependents.get(edge) ?? []), field.fieldId]);
    }
  }

  const queue = fields.filter((f) => (pending.get(f.fieldId) as Set<string>).size === 0).map((f) => f.fieldId);
  const order: ComputedFieldRef[] = [];

  while (queue.length > 0) {
    const id = queue.shift() as string;
    order.push(byId.get(id) as ComputedFieldRef);
    for (const dependent of dependents.get(id) ?? []) {
      const remaining = pending.get(dependent) as Set<string>;
      remaining.delete(id);
      if (remaining.size === 0) queue.push(dependent);
    }
  }

  if (order.length !== fields.length) {
    const placed = new Set(order.map((field) => field.fieldId));
    return { ok: false, cycle: fields.map((f) => f.fieldId).filter((id) => !placed.has(id)) };
  }

  return { ok: true, order };
}

/**
 * Whether adding a dependency would close a cycle.
 *
 * Called before a formula or rollup is saved. Refusing at that point gives the author an error
 * next to the field they are editing; discovering it during a recalculation gives everyone a
 * `#CYCLE!` in a column and no clue which field introduced it.
 */
export function wouldCycle(
  existing: readonly ComputedFieldRef[],
  candidate: ComputedFieldRef,
): boolean {
  // A field that reads itself is checked here rather than in planOrder, which drops self-edges
  // so that the queue can drain. `{Total} = {Total} + 1` is a cycle of length one and must be
  // refused at the point of writing, not discovered as a #CYCLE! in a column afterwards.
  const readsItself = [...(candidate.reads ?? []), candidate.linkFieldId, candidate.targetFieldId]
    .some((id) => id === candidate.fieldId);
  if (readsItself) return true;

  const withCandidate = [...existing.filter((f) => f.fieldId !== candidate.fieldId), candidate];
  return !planOrder(withCandidate).ok;
}

/**
 * Splits a set of records into batches for recalculation.
 *
 * Batching exists so a recalculation of a large table neither holds one transaction open for
 * minutes nor issues one statement per record. The size is a balance: large enough that the
 * per-statement overhead is amortised, small enough that a failure costs one batch and a lock is
 * never held long enough to block interactive writes.
 */
export const RECALC_BATCH_SIZE = 500;

export function batchRecords<T>(records: readonly T[], size = RECALC_BATCH_SIZE): T[][] {
  if (size < 1) throw new Error('a batch must hold at least one record');
  const batches: T[][] = [];
  for (let index = 0; index < records.length; index += size) {
    batches.push(records.slice(index, index + size));
  }
  return batches;
}

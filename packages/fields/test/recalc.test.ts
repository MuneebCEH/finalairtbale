import { describe, expect, it } from 'vitest';

import {
  batchRecords,
  invalidatedBy,
  planOrder,
  wouldCycle,
  type ComputedFieldRef,
} from '../src/recalc';

/**
 * The planner decides how much work a change causes. Getting it wrong is expensive in both
 * directions: too little and a column silently holds last cycle's numbers, too much and a
 * one-cell edit recomputes a hundred thousand records.
 */

const formula = (fieldId: string, tableId: string, reads: string[]): ComputedFieldRef => ({
  fieldId,
  tableId,
  type: 'formula',
  reads,
});

const rollup = (
  fieldId: string,
  tableId: string,
  linkFieldId: string,
  targetFieldId: string,
): ComputedFieldRef => ({ fieldId, tableId, type: 'rollup', linkFieldId, targetFieldId });

describe('invalidatedBy', () => {
  it('invalidates a formula that reads a changed field', () => {
    const graph = { computed: [formula('fld_total', 'tbl_orders', ['fld_price', 'fld_qty'])] };
    const result = invalidatedBy(graph, 'tbl_orders', ['fld_price']);

    expect(result.sameTable.map((f) => f.fieldId)).toEqual(['fld_total']);
    expect(result.acrossLink).toEqual([]);
  });

  it('leaves a formula alone when nothing it reads changed', () => {
    const graph = { computed: [formula('fld_total', 'tbl_orders', ['fld_price'])] };
    expect(invalidatedBy(graph, 'tbl_orders', ['fld_notes']).sameTable).toEqual([]);
  });

  it('invalidates a rollup when its own link field changed', () => {
    // The set of linked records is different, so the derived value is stale even though nothing
    // on the other side moved.
    const graph = { computed: [rollup('fld_sum', 'tbl_customers', 'fld_orders', 'fld_amount')] };
    const result = invalidatedBy(graph, 'tbl_customers', ['fld_orders']);

    expect(result.sameTable.map((f) => f.fieldId)).toEqual(['fld_sum']);
  });

  it('invalidates a rollup in another table when its target field changed', () => {
    // The records to recompute are the ones linking *to* the changed records — the caller
    // resolves those, but the planner has to say the field is affected at all.
    const graph = { computed: [rollup('fld_sum', 'tbl_customers', 'fld_orders', 'fld_amount')] };
    const result = invalidatedBy(graph, 'tbl_orders', ['fld_amount']);

    expect(result.acrossLink.map((f) => f.fieldId)).toEqual(['fld_sum']);
    expect(result.sameTable).toEqual([]);
  });

  it('does not invalidate a rollup for an unrelated field on the linked table', () => {
    const graph = { computed: [rollup('fld_sum', 'tbl_customers', 'fld_orders', 'fld_amount')] };
    expect(invalidatedBy(graph, 'tbl_orders', ['fld_shipping_notes']).acrossLink).toEqual([]);
  });

  it('invalidates a count only through its link field', () => {
    const graph = {
      computed: [
        { fieldId: 'fld_n', tableId: 'tbl_customers', type: 'count' as const, linkFieldId: 'fld_orders' },
      ],
    };

    expect(invalidatedBy(graph, 'tbl_customers', ['fld_orders']).sameTable).toHaveLength(1);
    // A count has no target field, so a change to any column on the linked table is irrelevant.
    expect(invalidatedBy(graph, 'tbl_orders', ['fld_amount']).acrossLink).toEqual([]);
  });

  it('reports each affected field once even when several inputs changed', () => {
    const graph = { computed: [formula('fld_total', 'tbl_orders', ['fld_price', 'fld_qty'])] };
    expect(invalidatedBy(graph, 'tbl_orders', ['fld_price', 'fld_qty']).sameTable).toHaveLength(1);
  });
});

describe('planOrder', () => {
  it('computes a chain in dependency order', () => {
    // A formula reads a rollup, which reads a lookup. Computing in declaration order would derive
    // each from last cycle's inputs — wrong in a way that looks right.
    const fields = [
      formula('fld_c', 'tbl', ['fld_b']),
      formula('fld_b', 'tbl', ['fld_a']),
      formula('fld_a', 'tbl', []),
    ];

    const result = planOrder(fields);
    expect(result.ok && result.order.map((f) => f.fieldId)).toEqual(['fld_a', 'fld_b', 'fld_c']);
  });

  it('ignores dependencies on plain data columns', () => {
    // Otherwise the queue deadlocks on an edge that is always already satisfied.
    const result = planOrder([formula('fld_a', 'tbl', ['fld_plain_column'])]);
    expect(result.ok && result.order).toHaveLength(1);
  });

  it('names the members of a cycle rather than recursing', () => {
    const result = planOrder([formula('fld_a', 'tbl', ['fld_b']), formula('fld_b', 'tbl', ['fld_a'])]);

    expect(result.ok).toBe(false);
    expect(!result.ok && result.cycle.sort()).toEqual(['fld_a', 'fld_b']);
  });

  it('detects a cycle that runs through a rollup', () => {
    const result = planOrder([
      rollup('fld_sum', 'tbl_a', 'fld_link', 'fld_derived'),
      formula('fld_derived', 'tbl_b', ['fld_sum']),
    ]);

    expect(result.ok).toBe(false);
  });

  it('handles an empty set', () => {
    expect(planOrder([])).toEqual({ ok: true, order: [] });
  });
});

describe('wouldCycle', () => {
  const existing = [formula('fld_a', 'tbl', [])];

  it('allows a field that introduces no loop', () => {
    expect(wouldCycle(existing, formula('fld_b', 'tbl', ['fld_a']))).toBe(false);
  });

  it('refuses a field that closes a loop', () => {
    // Caught while the author is editing the field, rather than as a #CYCLE! appearing in a
    // column later with no clue which field caused it.
    const withB = [...existing, formula('fld_b', 'tbl', ['fld_a'])];
    expect(wouldCycle(withB, formula('fld_a', 'tbl', ['fld_b']))).toBe(true);
  });

  it('replaces the candidate rather than duplicating it when editing an existing field', () => {
    // Editing fld_b to stop reading fld_a must be allowed even though the old fld_b did.
    const withB = [...existing, formula('fld_b', 'tbl', ['fld_a'])];
    expect(wouldCycle(withB, formula('fld_b', 'tbl', []))).toBe(false);
  });

  it('refuses a field that reads itself', () => {
    // `{Total} = {Total} + 1` is a cycle of length one. planOrder drops self-edges so its queue
    // can drain, so this case is checked separately — without it the field saves cleanly and
    // produces #CYCLE! in the column afterwards.
    expect(wouldCycle([], formula('fld_a', 'tbl', ['fld_a']))).toBe(true);
    expect(wouldCycle([], rollup('fld_a', 'tbl', 'fld_link', 'fld_a'))).toBe(true);
  });
});

describe('batchRecords', () => {
  it('splits into batches of the given size', () => {
    expect(batchRecords([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]]);
  });

  it('returns nothing for an empty list', () => {
    expect(batchRecords([], 10)).toEqual([]);
  });

  it('returns one batch when everything fits', () => {
    expect(batchRecords([1, 2], 10)).toEqual([[1, 2]]);
  });

  it('refuses a nonsensical batch size rather than looping forever', () => {
    expect(() => batchRecords([1, 2], 0)).toThrow(/at least one record/);
  });
});

import { describe, expect, it } from 'vitest';

import { applyRollup, gatherLookup } from '../src';
import type { FieldContext } from '../src/spec';
import { linkedRecord } from '../src/types/relational';

const REC_A = 'rec_01KZEQTA3K80Y2PKNWMYT9BBXW';
const REC_B = 'rec_01KZEQTZZR87DZB94MGCD2PX4P';

const ctx = (options: Record<string, unknown> = {}): FieldContext => ({
  fieldId: 'fld_01KZEQTA3K80Y2PKNWMYT9BBXW',
  name: 'Links',
  options: { allowMultiple: true, ...options },
});

describe('linkedRecord parsing', () => {
  it('accepts a list of record ids', () => {
    expect(linkedRecord.parse([REC_A, REC_B], ctx())).toEqual({ ok: true, value: [REC_A, REC_B] });
  });

  it('accepts a single id unwrapped', () => {
    // A select input and a CSV both deliver one value; requiring a list would make the common
    // case the awkward one.
    expect(linkedRecord.parse(REC_A, ctx())).toEqual({ ok: true, value: [REC_A] });
  });

  it('accepts the objects the API hands out', () => {
    // The grid holds { id, name } for display and should not have to strip it before saving.
    const parsed = linkedRecord.parse([{ id: REC_A, name: 'Ada' }], ctx());
    expect(parsed).toEqual({ ok: true, value: [REC_A] });
  });

  it('de-duplicates rather than refusing', () => {
    // Linking the same record twice is a slip, not something worth failing a save over.
    expect(linkedRecord.parse([REC_A, REC_A, REC_B], ctx())).toEqual({
      ok: true,
      value: [REC_A, REC_B],
    });
  });

  it('rejects anything that is not a record id', () => {
    for (const bad of ['nonsense', 'tbl_01KZEQTA3K80Y2PKNWMYT9BBXW', '', 42, null]) {
      const parsed = linkedRecord.parse([bad], ctx());
      expect(parsed.ok, JSON.stringify(bad)).toBe(false);
    }
  });

  it('enforces a single link when the field says so', () => {
    const parsed = linkedRecord.parse([REC_A, REC_B], ctx({ allowMultiple: false }));
    expect(parsed.ok).toBe(false);
  });

  it('treats an empty list as blank', () => {
    expect(linkedRecord.parse([], ctx())).toEqual({ ok: true, value: null });
    expect(linkedRecord.parse(null, ctx())).toEqual({ ok: true, value: null });
  });

  it('compares links without regard to order', () => {
    // Two cells holding the same links in a different order are the same cell; treating them as
    // different would write a revision on every reorder.
    expect(linkedRecord.equals?.([REC_A, REC_B], [REC_B, REC_A])).toBe(true);
    expect(linkedRecord.equals?.([REC_A], [REC_A, REC_B])).toBe(false);
    expect(linkedRecord.equals?.(null, [])).toBe(true);
  });

  it('defaults to unlinking on delete, not cascading', () => {
    // The other policies can destroy or block work from a distance; a default that surprises
    // somebody at delete time is the wrong default.
    expect(linkedRecord.defaultOptions()['onDelete']).toBe('unlink');
  });
});

describe('rollup aggregation', () => {
  it('sums, averages and bounds numbers', () => {
    expect(applyRollup('sum', [1, 2, 3])).toBe(6);
    expect(applyRollup('average', [2, 4])).toBe(3);
    expect(applyRollup('min', [5, 1, 3])).toBe(1);
    expect(applyRollup('max', [5, 1, 3])).toBe(5);
  });

  it('drops blanks before aggregating', () => {
    // An unfilled cell is not a zero. Counting it as one is the commonest way an average lies.
    expect(applyRollup('average', [2, null, 4])).toBe(3);
    expect(applyRollup('sum', [2, undefined, 4])).toBe(6);
    expect(applyRollup('average', [2, '', 4])).toBe(3);
  });

  describe('over an empty link set', () => {
    it('sums to zero, because the sum of nothing is zero', () => {
      expect(applyRollup('sum', [])).toBe(0);
    });

    it('counts to zero', () => {
      expect(applyRollup('count', [])).toBe(0);
      expect(applyRollup('countAll', [])).toBe(0);
    });

    it('averages to blank, because the average of nothing is not zero', () => {
      // Reporting 0 here would drag every downstream figure down and look like real data.
      expect(applyRollup('average', [])).toBeNull();
      expect(applyRollup('min', [])).toBeNull();
      expect(applyRollup('max', [])).toBeNull();
    });

    it('is vacuously true for AND', () => {
      // "Are all the linked tasks done" with no linked tasks is not false.
      expect(applyRollup('and', [])).toBe(true);
      expect(applyRollup('or', [])).toBe(false);
    });
  });

  it('counts present values and all values differently', () => {
    expect(applyRollup('count', [1, null, 3])).toBe(2);
    expect(applyRollup('countAll', [1, null, 3])).toBe(3);
  });

  it('combines booleans', () => {
    expect(applyRollup('and', [true, true])).toBe(true);
    expect(applyRollup('and', [true, false])).toBe(false);
    expect(applyRollup('or', [false, true])).toBe(true);
  });

  it('joins and de-duplicates', () => {
    expect(applyRollup('concatenate', ['a', 'b'])).toBe('a, b');
    expect(applyRollup('arrayUnique', ['a', 'b', 'a'])).toEqual(['a', 'b']);
  });

  it('ignores values that are not numbers in numeric rollups', () => {
    expect(applyRollup('sum', [1, 'banana', 2])).toBe(3);
  });

  it('rounds to the requested precision', () => {
    expect(applyRollup('average', [1, 2], { precision: 2 })).toBe(1.5);
    expect(applyRollup('average', [1, 1, 2], { precision: 2 })).toBe(1.33);
    expect(applyRollup('sum', [0.1, 0.2], { precision: 2 })).toBe(0.3);
  });
});

describe('gatherLookup', () => {
  it('flattens multi-value fields from linked records', () => {
    // One linked record's multi-select yields several values; the lookup shows them all.
    expect(gatherLookup([['a', 'b'], 'c'])).toEqual(['a', 'b', 'c']);
  });

  it('leaves single values alone', () => {
    expect(gatherLookup(['a', 'b'])).toEqual(['a', 'b']);
  });

  it('keeps blanks, because a lookup shows a gap where a linked record has none', () => {
    expect(gatherLookup(['a', null])).toEqual(['a', null]);
  });
});

import { describe, expect, it } from 'vitest';

import { idTimestamp, isValidId, newId, newIds } from '../src/ids';

describe('identifier generation', () => {
  it('produces a prefixed, well-formed id', () => {
    const id = newId('record');
    expect(id.startsWith('rec_')).toBe(true);
    expect(isValidId('record', id)).toBe(true);
    expect(isValidId('base', id)).toBe(false);
  });

  it('sorts in creation order even within a single millisecond', () => {
    // Regression. The plain `ulid()` re-randomises its 80-bit suffix on every call, so ids
    // created inside the same millisecond sort arbitrarily. A bulk insert produces hundreds of
    // rows per millisecond, which made a grid with no explicit sort display rows as 1, 3, 2, 6,
    // 4 — and, worse, made `ORDER BY id` a non-deterministic tiebreak for cursor pagination.
    const ids = Array.from({ length: 2_000 }, () => newId('record'));
    const sorted = [...ids].sort();
    expect(sorted).toEqual(ids);
  });

  it('keeps a batch monotonic too', () => {
    const ids = newIds('record', 500);
    expect([...ids].sort()).toEqual(ids);
    expect(new Set(ids).size).toBe(500);
  });

  it('encodes a recoverable creation timestamp', () => {
    const before = Date.now();
    const timestamp = idTimestamp(newId('record'));
    expect(timestamp).not.toBeNull();
    // Millisecond resolution, so allow a small window either side.
    expect(Math.abs((timestamp as Date).getTime() - before)).toBeLessThan(2_000);
  });

  it('rejects a malformed id rather than guessing', () => {
    expect(isValidId('record', 'rec_not-a-ulid')).toBe(false);
    expect(idTimestamp('rec_nonsense')).toBeNull();
  });
});

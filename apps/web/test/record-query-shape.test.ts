import { listRecordsSchema } from '@tessera/validation';
import { describe, expect, it } from 'vitest';

import type { RecordQuery } from '@/features/data/api';

/**
 * The client's query shape, checked against the server's own schema.
 *
 * The grid sent `sorts` where the server expects `sort`. Because `listRecordsSchema` is strict,
 * that did not degrade to "sorting is ignored" — it failed the entire request with a 422, so
 * turning on a sort also broke filtering, which travels in the same body. An `as never` cast at
 * the call site kept the typechecker quiet about all of it.
 *
 * Asserting against the real schema means a future rename on either side fails here rather than
 * in the product.
 */

describe('the record query the client sends', () => {
  it('is accepted by the server schema when fully populated', () => {
    const query: RecordQuery = {
      limit: 200,
      filter: { conjunction: 'and', conditions: [{ fieldId: 'fld_1', operator: 'isNotEmpty' }] },
      sort: [{ fieldId: 'fld_1', direction: 'asc' }],
      group: [{ fieldId: 'fld_2', direction: 'desc' }],
      search: 'anything',
    };

    expect(listRecordsSchema.safeParse(query).success).toBe(true);
  });

  it.each(['sorts', 'groups', 'orderBy'])('rejects %s, which is not a key the server knows', (key) => {
    // Stated explicitly because the failure mode is so misleading: an unknown key does not get
    // dropped, it takes the whole request with it.
    const result = listRecordsSchema.safeParse({ limit: 10, [key]: [] });

    expect(result.success).toBe(false);
  });

  it('accepts each parameter on its own', () => {
    const parts: RecordQuery[] = [
      { filter: { conjunction: 'or', conditions: [] } },
      { sort: [{ fieldId: 'fld_1', direction: 'desc' }] },
      { group: [{ fieldId: 'fld_1', direction: 'asc' }] },
      { search: 'x' },
      { cursor: 'abc' },
    ];

    for (const part of parts) {
      expect(listRecordsSchema.safeParse(part).success).toBe(true);
    }
  });
});

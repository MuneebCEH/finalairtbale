import type { FieldDefinition } from '@tessera/fields';
import { describe, expect, it } from 'vitest';

import { buildViewQuery } from '../src/query/view-query';
import { SqlBuilder, ident } from '../src/query/sql-builder';

/**
 * The query builder is the one place in the platform that assembles SQL from user-authored
 * input, so it is tested as a security control first and a feature second.
 */

const ORG = 'org_01HAAAAAAAAAAAAAAAAAAAAAAA';
const TABLE = 'tbl_01HTTTTTTTTTTTTTTTTTTTTTTT';

const F = {
  name: 'fld_01HAAAAAAAAAAAAAAAAAAAAAA1',
  amount: 'fld_01HAAAAAAAAAAAAAAAAAAAAAA2',
  due: 'fld_01HAAAAAAAAAAAAAAAAAAAAAA3',
  done: 'fld_01HAAAAAAAAAAAAAAAAAAAAAA4',
  tags: 'fld_01HAAAAAAAAAAAAAAAAAAAAAA5',
  owner: 'fld_01HAAAAAAAAAAAAAAAAAAAAAA6',
} as const;

const fields: FieldDefinition[] = [
  { id: F.name, name: 'Name', type: 'singleLineText', options: {}, promotedSlot: 's0' },
  { id: F.amount, name: 'Amount', type: 'currency', options: { precision: 2 }, promotedSlot: null },
  { id: F.due, name: 'Due', type: 'date', options: {}, promotedSlot: 'd0' },
  { id: F.done, name: 'Done', type: 'checkbox', options: {}, promotedSlot: null },
  { id: F.tags, name: 'Tags', type: 'multipleSelect', options: { choices: [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }] }, promotedSlot: null },
  { id: F.owner, name: 'Owner', type: 'user', options: {}, promotedSlot: 's1' },
];

function build(query: Parameters<typeof buildViewQuery>[0]['query'], currentUserId: string | null = null) {
  return buildViewQuery({
    organizationId: ORG,
    tableId: TABLE,
    query,
    fields,
    currentUserId,
    now: new Date('2026-03-04T12:00:00Z'),
  });
}

describe('non-negotiable query shape', () => {
  it('always scopes to the tenant and the table', () => {
    const { sql, values } = build({ limit: 50 });
    expect(sql).toContain('r.organization_id = $1');
    expect(sql).toContain('r.table_id = $2');
    expect(values[0]).toBe(ORG);
    expect(values[1]).toBe(TABLE);
  });

  it('excludes soft-deleted rows', () => {
    expect(build({ limit: 50 }).sql).toContain('r.deleted_at IS NULL');
  });

  it('never emits OFFSET', () => {
    // Offset pagination silently skips and duplicates rows under concurrent writes, and costs
    // O(n) to reach page n. It is banned outright, not merely discouraged.
    expect(build({ limit: 50 }).sql).not.toMatch(/\bOFFSET\b/i);
  });

  it('never emits COUNT(*)', () => {
    expect(build({ limit: 50 }).sql).not.toMatch(/COUNT\s*\(/i);
  });

  it('always applies a LIMIT, fetching one extra row to detect the next page', () => {
    const { sql, values, limit } = build({ limit: 50 });
    expect(sql).toMatch(/LIMIT \$\d+/);
    expect(limit).toBe(50);
    expect(values.at(-1)).toBe(51);
  });

  it('always ends the ordering with the id tiebreak', () => {
    // Without a total order, two rows with the same sort value can come back in either order on
    // successive pages — which loses one and repeats the other.
    const { sql } = build({ limit: 50, sort: [{ fieldId: F.name, direction: 'asc' }] });
    expect(sql).toMatch(/ORDER BY .*r\.id ASC/);
  });

  it('caps the limit at 1000 however large a value is requested', () => {
    expect(build({ limit: 999_999 }).limit).toBe(1_000);
  });
});

describe('injection resistance', () => {
  it('binds filter values rather than interpolating them', () => {
    const payload = "'; DROP TABLE records; --";
    const { sql, values } = build({
      limit: 10,
      filter: { conjunction: 'and', conditions: [{ fieldId: F.name, operator: 'is', value: payload }] },
    });

    expect(sql).not.toContain('DROP TABLE');
    expect(values).toContain(payload);
  });

  it('binds the field id even when reading an unpromoted JSONB path', () => {
    const { sql, values } = build({
      limit: 10,
      filter: { conjunction: 'and', conditions: [{ fieldId: F.amount, operator: 'isGreater', value: 100 }] },
    });

    // The field id appears as a parameter, never inside the statement text.
    expect(sql).not.toContain(F.amount);
    expect(values).toContain(F.amount);
  });

  it('rejects a malformed field id before any SQL is produced', () => {
    expect(() =>
      build({
        limit: 10,
        filter: {
          conjunction: 'and',
          conditions: [{ fieldId: "fld_x'; DROP TABLE records; --", operator: 'is', value: 'x' }],
        },
      }),
    ).toThrow(/Malformed field id/);
  });

  it('refuses to name a column outside the allowlist', () => {
    const builder = new SqlBuilder();
    expect(() => ident('pg_shadow')).toThrow(/unrecognised column/);
    expect(builder.parameterCount).toBe(0);
  });

  it('escapes LIKE metacharacters so a literal % is not a wildcard', () => {
    const { values } = build({
      limit: 10,
      filter: { conjunction: 'and', conditions: [{ fieldId: F.name, operator: 'contains', value: '50%' }] },
    });
    expect(values).toContain('%50\\%%');
  });
});

describe('promoted versus unpromoted access paths', () => {
  it('reads a promoted field from its typed column', () => {
    const { sql } = build({
      limit: 10,
      filter: { conjunction: 'and', conditions: [{ fieldId: F.name, operator: 'is', value: 'Acme' }] },
    });
    expect(sql).toContain('r.s0 =');
  });

  it('casts an unpromoted numeric field so ordering is numeric, not lexicographic', () => {
    const { sql } = build({
      limit: 10,
      filter: { conjunction: 'and', conditions: [{ fieldId: F.amount, operator: 'isGreater', value: 9 }] },
    });
    // Without the cast, '10' would sort before '9'.
    expect(sql).toContain('::numeric');
  });

  it('does not compare against a slot that holds a derived sort key', () => {
    // Regression. Single-select promotes the option's *position* so that a status column sorts
    // in board order rather than alphabetically. That makes the slot right for ORDER BY and
    // wrong for `=`: comparing 'open' against '00000' matched nothing, so every filter on a
    // promoted select silently returned an empty result. Equality must read the JSONB value.
    const selectField: FieldDefinition = {
      id: 'fld_01HAAAAAAAAAAAAAAAAAAAAAA7',
      name: 'Status',
      type: 'singleSelect',
      options: { choices: [{ id: 'open', label: 'Open', position: 0 }] },
      promotedSlot: 's2',
    };

    const { sql, values } = buildViewQuery({
      organizationId: ORG,
      tableId: TABLE,
      query: {
        limit: 10,
        filter: { conjunction: 'and', conditions: [{ fieldId: selectField.id, operator: 'is', value: 'open' }] },
      },
      fields: [...fields, selectField],
      currentUserId: null,
    });

    expect(sql).not.toContain('r.s2 =');
    expect(sql).toContain('data ->>');
    expect(values).toContain('open');
  });

  it('still orders a promoted select on its slot column', () => {
    const selectField: FieldDefinition = {
      id: 'fld_01HAAAAAAAAAAAAAAAAAAAAAA7',
      name: 'Status',
      type: 'singleSelect',
      options: { choices: [{ id: 'open', label: 'Open', position: 0 }] },
      promotedSlot: 's2',
    };

    const { sql } = buildViewQuery({
      organizationId: ORG,
      tableId: TABLE,
      query: { limit: 10, sort: [{ fieldId: selectField.id, direction: 'asc' }] },
      fields: [...fields, selectField],
      currentUserId: null,
    });

    // The whole point of the position-in-slot design: ordering uses the indexed column.
    expect(sql).toContain('r.s2 ASC');
  });

  it('sorts a promoted date on its column and an unpromoted one via a cast', () => {
    expect(build({ limit: 10, sort: [{ fieldId: F.due, direction: 'desc' }] }).sql).toContain('r.d0 DESC');
    expect(build({ limit: 10, sort: [{ fieldId: F.amount, direction: 'asc' }] }).sql).toContain('::numeric ASC');
  });
});

describe('filter semantics', () => {
  it('treats "is not" as including empty rows', () => {
    // SQL's three-valued logic excludes NULL from `<> 'x'`, but a user filtering "Status is not
    // Done" expects the blank rows back. The explicit null branch is the difference between a
    // filter people trust and one they route around.
    const { sql } = build({
      limit: 10,
      filter: { conjunction: 'and', conditions: [{ fieldId: F.name, operator: 'isNot', value: 'Acme' }] },
    });
    expect(sql).toMatch(/IS NULL OR .* <>/);
  });

  it('treats an absent checkbox as false', () => {
    const { sql } = build({
      limit: 10,
      filter: { conjunction: 'and', conditions: [{ fieldId: F.done, operator: 'is', value: false }] },
    });
    expect(sql).toMatch(/IS FALSE OR .* IS NULL/);
  });

  it('matches a date "is" against the whole day rather than an exact instant', () => {
    const { sql } = build({
      limit: 10,
      filter: { conjunction: 'and', conditions: [{ fieldId: F.due, operator: 'is', value: '2026-03-04' }] },
    });
    expect(sql).toMatch(/r\.d0 >= \$\d+ AND r\.d0 < \$\d+/);
  });

  it('resolves relative dates at query time', () => {
    const { values } = build({
      limit: 10,
      filter: { conjunction: 'and', conditions: [{ fieldId: F.due, operator: 'isBefore', value: 'today' }] },
    });
    const bound = values.find((v): v is Date => v instanceof Date);
    expect(bound?.toISOString()).toBe('2026-03-04T00:00:00.000Z');
  });

  it('uses JSONB containment for multi-select membership', () => {
    const { sql } = build({
      limit: 10,
      filter: { conjunction: 'and', conditions: [{ fieldId: F.tags, operator: 'hasAllOf', value: ['a', 'b'] }] },
    });
    expect(sql).toContain('@>');
  });

  it('resolves isCurrentUser to the caller, and to nothing when anonymous', () => {
    const withUser = build(
      { limit: 10, filter: { conjunction: 'and', conditions: [{ fieldId: F.owner, operator: 'isCurrentUser' }] } },
      'usr_01HUUUUUUUUUUUUUUUUUUUUUUU',
    );
    expect(withUser.values).toContain('usr_01HUUUUUUUUUUUUUUUUUUUUUUU');

    const anonymous = build({
      limit: 10,
      filter: { conjunction: 'and', conditions: [{ fieldId: F.owner, operator: 'isCurrentUser' }] },
    });
    expect(anonymous.sql).toContain('FALSE');
  });

  it('nests AND and OR groups correctly', () => {
    const { sql } = build({
      limit: 10,
      filter: {
        conjunction: 'and',
        conditions: [
          { fieldId: F.name, operator: 'contains', value: 'a' },
          {
            conjunction: 'or',
            conditions: [
              { fieldId: F.amount, operator: 'isGreater', value: 10 },
              { fieldId: F.done, operator: 'is', value: true },
            ],
          },
        ],
      },
    });
    expect(sql).toContain(' OR ');
    expect(sql).toContain(' AND ');
  });

  it('rejects an operator the field type does not support', () => {
    expect(() =>
      build({
        limit: 10,
        filter: { conjunction: 'and', conditions: [{ fieldId: F.done, operator: 'contains', value: 'x' }] },
      }),
    ).toThrow(/cannot be used with/);
  });

  it('rejects a filter on an unknown field', () => {
    expect(() =>
      build({
        limit: 10,
        filter: {
          conjunction: 'and',
          conditions: [{ fieldId: 'fld_01HZZZZZZZZZZZZZZZZZZZZZZ9', operator: 'is', value: 'x' }],
        },
      }),
    ).toThrow(/Unknown field/);
  });

  it('gives an empty group the neutral value for its conjunction', () => {
    expect(build({ limit: 10, filter: { conjunction: 'and', conditions: [] } }).sql).toContain('TRUE');
    expect(build({ limit: 10, filter: { conjunction: 'or', conditions: [] } }).sql).toContain('FALSE');
  });
});

describe('cursor pagination', () => {
  it('rejects a cursor from a different query shape', () => {
    const first = build({ limit: 10, sort: [{ fieldId: F.name, direction: 'asc' }] });
    const cursor = Buffer.from(
      JSON.stringify({ v: 1, k: ['Acme'], i: 'rec_01HAAAAAAAAAAAAAAAAAAAAAAA', q: 'differentshape' }),
    ).toString('base64url');

    expect(() =>
      build({ limit: 10, sort: [{ fieldId: F.name, direction: 'asc' }], cursor }),
    ).toThrow(/restart from the first page/);
    expect(first.shapeHash).not.toBe('differentshape');
  });

  it('rejects a corrupt cursor', () => {
    expect(() => build({ limit: 10, cursor: 'not-a-cursor' })).toThrow(/not valid/);
  });

  it('produces a keyset predicate that includes the id tiebreak', () => {
    const { shapeHash } = build({ limit: 10, sort: [{ fieldId: F.name, direction: 'asc' }] });
    const cursor = Buffer.from(
      JSON.stringify({ v: 1, k: ['Acme'], i: 'rec_01HAAAAAAAAAAAAAAAAAAAAAAA', q: shapeHash }),
    ).toString('base64url');

    const { sql } = build({ limit: 10, sort: [{ fieldId: F.name, direction: 'asc' }], cursor });
    expect(sql).toContain('r.id >');
    expect(sql).toContain('r.s0 >');
  });

  it('groups are compiled as leading sort keys', () => {
    const { sql, sorts } = build({
      limit: 10,
      group: [{ fieldId: F.due, direction: 'asc' }],
      sort: [{ fieldId: F.name, direction: 'desc' }],
    });
    expect(sorts.map((s) => s.fieldId)).toEqual([F.due, F.name]);
    expect(sql.indexOf('r.d0')).toBeLessThan(sql.indexOf('ORDER BY') + sql.slice(sql.indexOf('ORDER BY')).indexOf('DESC'));
  });
});

describe('bounds', () => {
  it('rejects a filter tree nested beyond the depth cap', () => {
    let node: never | { conjunction: 'and'; conditions: unknown[] } = {
      conjunction: 'and',
      conditions: [{ fieldId: F.name, operator: 'is', value: 'x' }],
    };
    for (let i = 0; i < 8; i += 1) node = { conjunction: 'and', conditions: [node] };

    expect(() => build({ limit: 10, filter: node as never })).toThrow(/nesting exceeds/);
  });

  it('rejects an over-long value list', () => {
    expect(() =>
      build({
        limit: 10,
        filter: {
          conjunction: 'and',
          conditions: [
            { fieldId: F.name, operator: 'isAnyOf', value: Array.from({ length: 501 }, (_, i) => String(i)) },
          ],
        },
      }),
    ).toThrow(/at most 500 values/);
  });
});

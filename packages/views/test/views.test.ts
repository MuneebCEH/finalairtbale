import { describe, expect, it } from 'vitest';

import {
  filterDepth,
  filterFieldIds,
  pruneDeletedField,
  requiredFieldIds,
  viewSchema,
  type FilterGroup,
  type View,
} from '../src';

const F = (n: number) => `fld_0000000000000000000000000${n}`;

const parse = (input: unknown) => viewSchema.safeParse(input);

const base = (config: unknown) => ({ name: 'A view', config });

describe('view configuration', () => {
  it('accepts a grid with no particular field', () => {
    expect(parse(base({ type: 'grid' })).success).toBe(true);
  });

  it('requires a kanban to name the field it stacks by', () => {
    expect(parse(base({ type: 'kanban' })).success).toBe(false);
    expect(parse(base({ type: 'kanban', stackFieldId: F(1) })).success).toBe(true);
  });

  it('requires a calendar to name its date field', () => {
    expect(parse(base({ type: 'calendar' })).success).toBe(false);
    expect(parse(base({ type: 'calendar', dateFieldId: F(1) })).success).toBe(true);
  });

  it('requires a timeline to name both ends', () => {
    expect(parse(base({ type: 'timeline', startFieldId: F(1) })).success).toBe(false);
    expect(parse(base({ type: 'timeline', startFieldId: F(1), endFieldId: F(2) })).success).toBe(true);
  });

  it('accepts a map with either a location field or a coordinate pair', () => {
    expect(parse(base({ type: 'map', locationFieldId: F(1) })).success).toBe(true);
    expect(parse(base({ type: 'map', latitudeFieldId: F(1), longitudeFieldId: F(2) })).success).toBe(true);
  });

  it('refuses a map with only one coordinate', () => {
    // Half a coordinate pair plots nothing, and the view would render an empty map with no
    // explanation of why.
    expect(parse(base({ type: 'map', latitudeFieldId: F(1) })).success).toBe(false);
    expect(parse(base({ type: 'map' })).success).toBe(false);
  });

  it('rejects an unknown view type', () => {
    expect(parse(base({ type: 'spreadsheet' })).success).toBe(false);
  });

  it('rejects unknown keys rather than ignoring them', () => {
    expect(parse(base({ type: 'grid', rowHeigth: 'tall' })).success).toBe(false);
  });
});

describe('filters', () => {
  const condition = (fieldId: string) => ({ fieldId, operator: 'is', value: 'x' });

  it('accepts a nested tree, which a flat list cannot express', () => {
    // `A AND (B OR C)` is the first thing anybody wants once they have three conditions.
    const filter = {
      conjunction: 'and',
      conditions: [
        condition(F(1)),
        { conjunction: 'or', conditions: [condition(F(2)), condition(F(3))] },
      ],
    };

    expect(parse({ ...base({ type: 'grid' }), filter }).success).toBe(true);
  });

  it('rejects an unknown operator', () => {
    const filter = { conjunction: 'and', conditions: [{ fieldId: F(1), operator: 'sortaLike' }] };
    expect(parse({ ...base({ type: 'grid' }), filter }).success).toBe(false);
  });

  it('refuses a tree nested past the depth limit', () => {
    // The compiler walks this per query; unbounded nesting is unbounded work per read.
    let filter: FilterGroup = { conjunction: 'and', conditions: [condition(F(1))] };
    for (let level = 0; level < 8; level += 1) {
      filter = { conjunction: 'and', conditions: [filter] };
    }
    expect(parse({ ...base({ type: 'grid' }), filter }).success).toBe(false);
  });

  it('measures depth', () => {
    const flat: FilterGroup = { conjunction: 'and', conditions: [condition(F(1))] };
    expect(filterDepth(flat)).toBe(1);
    expect(filterDepth({ conjunction: 'and', conditions: [flat] })).toBe(2);
  });

  it('lists the fields a tree references', () => {
    const filter: FilterGroup = {
      conjunction: 'and',
      conditions: [condition(F(1)), { conjunction: 'or', conditions: [condition(F(2))] }],
    };
    expect(filterFieldIds(filter).sort()).toEqual([F(1), F(2)].sort());
  });
});

describe('sorts and groups', () => {
  it('refuses sorting on the same field twice', () => {
    // The second one silently does nothing, which reads as the sort being broken.
    const sorts = [
      { fieldId: F(1), direction: 'asc' },
      { fieldId: F(1), direction: 'desc' },
    ];
    expect(parse({ ...base({ type: 'grid' }), sorts }).success).toBe(false);
  });

  it('refuses grouping on the same field twice', () => {
    const groups = [
      { fieldId: F(1), direction: 'asc' },
      { fieldId: F(1), direction: 'asc' },
    ];
    expect(parse({ ...base({ type: 'grid' }), groups }).success).toBe(false);
  });

  it('allows sorting and grouping on the same field', () => {
    // Legitimate: group by status, then sort within each group by the same field's order.
    const view = {
      ...base({ type: 'grid' }),
      sorts: [{ fieldId: F(1), direction: 'asc' }],
      groups: [{ fieldId: F(1), direction: 'asc' }],
    };
    expect(parse(view).success).toBe(true);
  });

  it('bounds how many sorts and groups a view can carry', () => {
    const many = Array.from({ length: 11 }, (_, i) => ({ fieldId: F(i), direction: 'asc' }));
    expect(parse({ ...base({ type: 'grid' }), sorts: many }).success).toBe(false);
  });
});

describe('a view cannot hide what it is built on', () => {
  it('refuses a kanban that hides its stack field', () => {
    // Otherwise the board renders empty with nothing to explain why.
    const view = {
      ...base({ type: 'kanban', stackFieldId: F(1) }),
      hiddenFieldIds: [F(1)],
    };
    expect(parse(view).success).toBe(false);
  });

  it('allows hiding a field the view does not need', () => {
    const view = {
      ...base({ type: 'kanban', stackFieldId: F(1) }),
      hiddenFieldIds: [F(2)],
    };
    expect(parse(view).success).toBe(true);
  });
});

describe('requiredFieldIds', () => {
  it('names what each view type depends on', () => {
    expect(requiredFieldIds({ type: 'grid' })).toEqual([]);
    expect(requiredFieldIds({ type: 'kanban', stackFieldId: F(1) })).toEqual([F(1)]);
    expect(requiredFieldIds({ type: 'gantt', startFieldId: F(1), endFieldId: F(2) })).toEqual([F(1), F(2)]);
  });
});

describe('pruneDeletedField', () => {
  const view: View = {
    name: 'Board',
    config: { type: 'kanban', stackFieldId: F(1) },
    filter: {
      conjunction: 'and',
      conditions: [
        { fieldId: F(1), operator: 'is', value: 'x' },
        { fieldId: F(2), operator: 'is', value: 'y' },
      ],
    },
    sorts: [{ fieldId: F(1), direction: 'asc' }],
    groups: [{ fieldId: F(2), direction: 'asc' }],
    hiddenFieldIds: [F(3)],
    fieldOrder: [F(1), F(2), F(3)],
  };

  it('degrades to a grid rather than deleting the view', () => {
    // A view whose kanban field is gone should not take the owner's filters and widths with it.
    const { view: pruned, changes } = pruneDeletedField(view, F(1));

    expect(pruned.config.type).toBe('grid');
    expect(changes).toContain('view type');
    expect(pruned.name).toBe('Board');
  });

  it('drops conditions on the deleted field and keeps the rest', () => {
    const { view: pruned } = pruneDeletedField(view, F(1));
    expect(filterFieldIds(pruned.filter as FilterGroup)).toEqual([F(2)]);
  });

  it('drops sorts and groups on the deleted field', () => {
    const { view: pruned } = pruneDeletedField(view, F(2));
    expect(pruned.groups).toEqual([]);
    expect(pruned.sorts).toEqual([{ fieldId: F(1), direction: 'asc' }]);
  });

  it('removes the field from ordering and hidden lists', () => {
    const { view: pruned } = pruneDeletedField(view, F(3));
    expect(pruned.fieldOrder).toEqual([F(1), F(2)]);
    expect(pruned.hiddenFieldIds).toEqual([]);
  });

  it('reports what it changed, so the owner can be told', () => {
    const { changes } = pruneDeletedField(view, F(1));
    expect(changes).toEqual(expect.arrayContaining(['filter', 'sort', 'view type']));
  });

  it('changes nothing when the deleted field was not used', () => {
    const { changes } = pruneDeletedField(view, F(9));
    expect(changes).toEqual([]);
  });

  it('leaves a view that still validates', () => {
    const { view: pruned } = pruneDeletedField(view, F(1));
    expect(viewSchema.safeParse(pruned).success).toBe(true);
  });
});

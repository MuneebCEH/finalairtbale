import { FILTER_OPERATORS } from '@tessera/types';
import { z } from 'zod';

export * from './forms';

/**
 * View configuration.
 *
 * Every view type is the same query with a different presentation: grid, kanban, calendar,
 * gallery, timeline, gantt, chart and map all read the same records through the same filters,
 * sorts and grouping. Modelling them as one entity with a discriminated `config` — rather than
 * eight tables — is what keeps "add a filter" from needing eight implementations, and it is why
 * switching a view's type preserves everything the new type still understands.
 */

export const VIEW_TYPES = [
  'grid', 'kanban', 'calendar', 'gallery', 'timeline', 'gantt', 'chart', 'map',
] as const;

export type ViewType = (typeof VIEW_TYPES)[number];

const FIELD_ID = z.string().max(30);

// ── Filters ─────────────────────────────────────────────────────────────────

/**
 * A filter tree, not a filter list.
 *
 * Airtable-style "where all/any of these match" nests, and a flat list cannot express
 * `A AND (B OR C)` — which is the first thing anybody wants once they have three conditions.
 * Depth is bounded because the compiler walks it per query.
 */
const MAX_FILTER_DEPTH = 5;

export interface FilterCondition {
  readonly fieldId: string;
  readonly operator: string;
  readonly value?: unknown;
}

export interface FilterGroup {
  readonly conjunction: 'and' | 'or';
  readonly conditions: ReadonlyArray<FilterCondition | FilterGroup>;
}

export const filterConditionSchema = z
  .object({
    fieldId: FIELD_ID,
    operator: z.enum(FILTER_OPERATORS as unknown as [string, ...string[]]),
    value: z.unknown().optional(),
  })
  .strict();

export const filterGroupSchema: z.ZodType<FilterGroup> = z.lazy(() =>
  z
    .object({
      conjunction: z.enum(['and', 'or']),
      conditions: z.array(z.union([filterConditionSchema, filterGroupSchema])).max(50),
    })
    .strict(),
);

export function filterDepth(group: FilterGroup, depth = 1): number {
  let deepest = depth;
  for (const condition of group.conditions) {
    if ('conjunction' in condition) {
      deepest = Math.max(deepest, filterDepth(condition, depth + 1));
    }
  }
  return deepest;
}

/** Every field a filter tree references. Used to reject filters on deleted fields. */
export function filterFieldIds(group: FilterGroup): string[] {
  const found = new Set<string>();
  const walk = (node: FilterGroup): void => {
    for (const condition of node.conditions) {
      if ('conjunction' in condition) walk(condition);
      else found.add(condition.fieldId);
    }
  };
  walk(group);
  return [...found];
}

// ── Sorting and grouping ────────────────────────────────────────────────────

export const sortSchema = z
  .object({ fieldId: FIELD_ID, direction: z.enum(['asc', 'desc']) })
  .strict();

export const groupSchema = z
  .object({
    fieldId: FIELD_ID,
    direction: z.enum(['asc', 'desc']),
    /** Whether the group starts collapsed in the UI. */
    collapsed: z.boolean().optional(),
  })
  .strict();

// ── Per-type configuration ──────────────────────────────────────────────────

const gridConfig = z
  .object({
    type: z.literal('grid'),
    rowHeight: z.enum(['short', 'medium', 'tall', 'extraTall']).optional(),
    /** Columns pinned to the left, in order. */
    frozenFieldIds: z.array(FIELD_ID).max(5).optional(),
  })
  .strict();

const kanbanConfig = z
  .object({
    type: z.literal('kanban'),
    /** The single-select or collaborator field whose values become columns. */
    stackFieldId: FIELD_ID,
    /** Stacks hidden from the board, by option id. */
    hiddenStackIds: z.array(z.string().max(64)).max(200).optional(),
    coverFieldId: FIELD_ID.optional(),
    showEmptyStack: z.boolean().optional(),
  })
  .strict();

const calendarConfig = z
  .object({
    type: z.literal('calendar'),
    dateFieldId: FIELD_ID,
    /** When set, records render as ranges rather than points. */
    endDateFieldId: FIELD_ID.optional(),
    colourFieldId: FIELD_ID.optional(),
  })
  .strict();

const galleryConfig = z
  .object({
    type: z.literal('gallery'),
    coverFieldId: FIELD_ID.optional(),
    coverFit: z.enum(['cover', 'contain']).optional(),
    cardSize: z.enum(['small', 'medium', 'large']).optional(),
  })
  .strict();

const timelineConfig = z
  .object({
    type: z.literal('timeline'),
    startFieldId: FIELD_ID,
    endFieldId: FIELD_ID,
    /** Records sharing a value here occupy one lane. */
    laneFieldId: FIELD_ID.optional(),
    scale: z.enum(['day', 'week', 'month', 'quarter', 'year']).optional(),
  })
  .strict();

const ganttConfig = z
  .object({
    type: z.literal('gantt'),
    startFieldId: FIELD_ID,
    endFieldId: FIELD_ID,
    /** A linked-record field expressing "this depends on that". */
    dependencyFieldId: FIELD_ID.optional(),
    progressFieldId: FIELD_ID.optional(),
  })
  .strict();

const chartConfig = z
  .object({
    type: z.literal('chart'),
    chartType: z.enum(['bar', 'line', 'pie', 'scatter', 'area']),
    xFieldId: FIELD_ID,
    yFieldId: FIELD_ID.optional(),
    aggregation: z.enum(['count', 'sum', 'average', 'min', 'max']).optional(),
    seriesFieldId: FIELD_ID.optional(),
  })
  .strict();

const mapConfig = z
  .object({
    type: z.literal('map'),
    /** Either a single address/geo field, or a latitude/longitude pair. */
    locationFieldId: FIELD_ID.optional(),
    latitudeFieldId: FIELD_ID.optional(),
    longitudeFieldId: FIELD_ID.optional(),
    colourFieldId: FIELD_ID.optional(),
  })
  // Deliberately not `.refine`d here: a discriminated union needs plain objects as members, and
  // refining one turns it into an effect that the union cannot discriminate on. The "location or
  // a coordinate pair" rule lives in viewSchema's superRefine instead.
  .strict();

export const viewConfigSchema = z.discriminatedUnion('type', [
  gridConfig,
  kanbanConfig,
  calendarConfig,
  galleryConfig,
  timelineConfig,
  ganttConfig,
  chartConfig,
  mapConfig,
]);

export type ViewConfig = z.infer<typeof viewConfigSchema>;

// ── The view ────────────────────────────────────────────────────────────────

export const viewSchema = z
  .object({
    name: z.string().min(1).max(120),
    config: viewConfigSchema,
    filter: filterGroupSchema.optional(),
    sorts: z.array(sortSchema).max(10).optional(),
    groups: z.array(groupSchema).max(3).optional(),
    /** Fields hidden in this view. Order is held separately so hiding does not lose position. */
    hiddenFieldIds: z.array(FIELD_ID).max(500).optional(),
    fieldOrder: z.array(FIELD_ID).max(500).optional(),
    fieldWidths: z.record(z.number().int().min(40).max(1200)).optional(),
  })
  .strict()
  .superRefine((view, ctx) => {
    if (view.filter && filterDepth(view.filter) > MAX_FILTER_DEPTH) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['filter'],
        message: `filters may nest at most ${MAX_FILTER_DEPTH} levels deep`,
      });
    }

    // Sorting by the same field twice is always a mistake, and the second one silently does
    // nothing — which looks like the sort being broken rather than duplicated.
    const sortFields = (view.sorts ?? []).map((sort) => sort.fieldId);
    if (new Set(sortFields).size !== sortFields.length) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['sorts'], message: 'a field can only be sorted on once' });
    }

    const groupFields = (view.groups ?? []).map((group) => group.fieldId);
    if (new Set(groupFields).size !== groupFields.length) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['groups'], message: 'a field can only be grouped on once' });
    }

    // Half a coordinate pair plots nothing, and the view would render an empty map without
    // saying why.
    if (view.config.type === 'map') {
      const hasPair = Boolean(view.config.latitudeFieldId) && Boolean(view.config.longitudeFieldId);
      if (!view.config.locationFieldId && !hasPair) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['config'],
          message: 'a map needs either a location field or both latitude and longitude',
        });
      }
    }

    // A hidden field that the view also depends on would render an empty board or a blank
    // calendar with no explanation.
    const required = requiredFieldIds(view.config);
    const hidden = new Set(view.hiddenFieldIds ?? []);
    for (const fieldId of required) {
      if (hidden.has(fieldId)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['hiddenFieldIds'],
          message: 'this view is built on a field it also hides',
        });
      }
    }
  });

export type View = z.infer<typeof viewSchema>;

/** The fields a view type cannot work without. */
export function requiredFieldIds(config: ViewConfig): string[] {
  switch (config.type) {
    case 'kanban':
      return [config.stackFieldId];
    case 'calendar':
      return [config.dateFieldId];
    case 'timeline':
    case 'gantt':
      return [config.startFieldId, config.endFieldId];
    case 'chart':
      return [config.xFieldId];
    case 'map':
      return config.locationFieldId
        ? [config.locationFieldId]
        : [config.latitudeFieldId, config.longitudeFieldId].filter((id): id is string => Boolean(id));
    default:
      return [];
  }
}

/**
 * Rewrites a view after a field is deleted.
 *
 * Called rather than cascading the delete: a view whose kanban field is gone should degrade to a
 * grid, not disappear along with the person's saved filters and column widths. Returning the
 * list of removals lets the caller tell them what changed instead of silently altering their view.
 */
export function pruneDeletedField(
  view: View,
  fieldId: string,
): { view: View; changes: string[] } {
  const changes: string[] = [];

  const filter = view.filter ? pruneFilter(view.filter, fieldId) : undefined;
  if (view.filter && filterFieldIds(view.filter).includes(fieldId)) changes.push('filter');

  const sorts = (view.sorts ?? []).filter((sort) => sort.fieldId !== fieldId);
  if (sorts.length !== (view.sorts ?? []).length) changes.push('sort');

  const groups = (view.groups ?? []).filter((group) => group.fieldId !== fieldId);
  if (groups.length !== (view.groups ?? []).length) changes.push('grouping');

  let config = view.config;
  if (requiredFieldIds(config).includes(fieldId)) {
    // Falls back to a grid, which needs no particular field and so can always render.
    config = { type: 'grid' };
    changes.push('view type');
  }

  return {
    view: {
      ...view,
      config,
      ...(filter ? { filter } : {}),
      sorts,
      groups,
      hiddenFieldIds: (view.hiddenFieldIds ?? []).filter((id) => id !== fieldId),
      fieldOrder: (view.fieldOrder ?? []).filter((id) => id !== fieldId),
    },
    changes,
  };
}

function pruneFilter(group: FilterGroup, fieldId: string): FilterGroup {
  const conditions = group.conditions
    .map((condition) =>
      'conjunction' in condition ? pruneFilter(condition, fieldId) : condition,
    )
    .filter((condition) =>
      'conjunction' in condition ? condition.conditions.length > 0 : condition.fieldId !== fieldId,
    );

  return { ...group, conditions };
}

/**
 * The field type catalogue.
 *
 * Behaviour for each type (validation, storage, filtering, sorting, grouping, import/export)
 * lives in the field-type registry in `@tessera/database`. This file declares only the vocabulary
 * and the static facts a type carries, so that every layer — API, UI, SDK, importer — agrees on
 * one list. Adding a member here without registering an implementation fails the conformance
 * suite (docs/10-testing-strategy.md §3.3).
 */

export const FIELD_TYPES = [
  // ── Text ──
  'singleLineText',
  'longText',
  'richText',
  // ── Numeric ──
  'number',
  'decimal',
  'currency',
  'percent',
  'rating',
  'progress',
  'duration',
  // ── Boolean ──
  'checkbox',
  // ── Choice ──
  'singleSelect',
  'multipleSelect',
  'status',
  // ── Temporal ──
  'date',
  'dateTime',
  // ── Contact / structured text ──
  'email',
  'phone',
  'url',
  'address',
  'geolocation',
  'barcode',
  'json',
  // ── People ──
  'user',
  'multipleUsers',
  // ── Files ──
  'attachment',
  // ── Relational ──
  'linkedRecord',
  'parentRecord',
  'childRecords',
  'dependency',
  // ── Computed ──
  'lookup',
  'rollup',
  'count',
  'formula',
  // ── System / generated ──
  'autoNumber',
  'recordId',
  'createdTime',
  'lastModifiedTime',
  'createdBy',
  'lastModifiedBy',
  // ── Interactive ──
  'button',
] as const;

export type FieldType = (typeof FIELD_TYPES)[number];

/** Types whose value is derived, never written directly by a user or the API. */
export const COMPUTED_FIELD_TYPES = [
  'lookup',
  'rollup',
  'count',
  'formula',
  'autoNumber',
  'recordId',
  'createdTime',
  'lastModifiedTime',
  'createdBy',
  'lastModifiedBy',
  'childRecords',
] as const satisfies readonly FieldType[];

export type ComputedFieldType = (typeof COMPUTED_FIELD_TYPES)[number];

export function isComputedFieldType(type: FieldType): type is ComputedFieldType {
  return (COMPUTED_FIELD_TYPES as readonly FieldType[]).includes(type);
}

/** Types that store their value as an edge in `record_links`, not in the record payload. */
export const RELATIONAL_FIELD_TYPES = [
  'linkedRecord',
  'parentRecord',
  'childRecords',
  'dependency',
] as const satisfies readonly FieldType[];

export function isRelationalFieldType(type: FieldType): boolean {
  return (RELATIONAL_FIELD_TYPES as readonly FieldType[]).includes(type);
}

/**
 * The physical slot family a field can be promoted into for indexed filtering and sorting.
 * `null` means the type is never promoted (it is filtered through the JSONB GIN index or,
 * for relational types, through `record_links`). See docs/02-database-design.md §1.5.
 */
export const FIELD_SLOT_FAMILY: Readonly<Record<FieldType, 'string' | 'number' | 'date' | 'boolean' | null>> = {
  singleLineText: 'string',
  longText: null,
  richText: null,
  number: 'number',
  decimal: 'number',
  currency: 'number',
  percent: 'number',
  rating: 'number',
  progress: 'number',
  duration: 'number',
  checkbox: 'boolean',
  singleSelect: 'string',
  multipleSelect: null,
  status: 'string',
  date: 'date',
  dateTime: 'date',
  email: 'string',
  phone: 'string',
  url: 'string',
  address: null,
  geolocation: null,
  barcode: 'string',
  json: null,
  user: 'string',
  multipleUsers: null,
  attachment: null,
  linkedRecord: null,
  parentRecord: 'string',
  childRecords: null,
  dependency: null,
  lookup: null,
  rollup: 'number',
  count: 'number',
  formula: null,
  autoNumber: 'number',
  recordId: 'string',
  createdTime: 'date',
  lastModifiedTime: 'date',
  createdBy: 'string',
  lastModifiedBy: 'string',
  button: null,
};

/** Filter operators, declared once so the API, the query builder, and the UI cannot disagree. */
export const FILTER_OPERATORS = [
  'is',
  'isNot',
  'contains',
  'doesNotContain',
  'startsWith',
  'endsWith',
  'isEmpty',
  'isNotEmpty',
  'isGreater',
  'isGreaterOrEqual',
  'isLess',
  'isLessOrEqual',
  'isBetween',
  'isBefore',
  'isAfter',
  'isOnOrBefore',
  'isOnOrAfter',
  'isWithin',
  'isAnyOf',
  'isNoneOf',
  'hasAllOf',
  'hasAnyOf',
  'isCurrentUser',
  'hasLinkedRecords',
  'hasNoLinkedRecords',
] as const;

export type FilterOperator = (typeof FILTER_OPERATORS)[number];

/** Which operators each field type accepts. Enforced at validation time, not just in the UI. */
export const FIELD_TYPE_OPERATORS: Readonly<Partial<Record<FieldType, readonly FilterOperator[]>>> = {
  singleLineText: ['is', 'isNot', 'contains', 'doesNotContain', 'startsWith', 'endsWith', 'isEmpty', 'isNotEmpty'],
  longText: ['contains', 'doesNotContain', 'isEmpty', 'isNotEmpty'],
  number: ['is', 'isNot', 'isGreater', 'isGreaterOrEqual', 'isLess', 'isLessOrEqual', 'isBetween', 'isEmpty', 'isNotEmpty'],
  checkbox: ['is'],
  singleSelect: ['is', 'isNot', 'isAnyOf', 'isNoneOf', 'isEmpty', 'isNotEmpty'],
  multipleSelect: ['hasAnyOf', 'hasAllOf', 'isNoneOf', 'isEmpty', 'isNotEmpty'],
  date: ['is', 'isNot', 'isBefore', 'isAfter', 'isOnOrBefore', 'isOnOrAfter', 'isWithin', 'isEmpty', 'isNotEmpty'],
  dateTime: ['is', 'isNot', 'isBefore', 'isAfter', 'isOnOrBefore', 'isOnOrAfter', 'isWithin', 'isEmpty', 'isNotEmpty'],
  user: ['is', 'isNot', 'isAnyOf', 'isNoneOf', 'isCurrentUser', 'isEmpty', 'isNotEmpty'],
  linkedRecord: ['hasAnyOf', 'hasAllOf', 'hasLinkedRecords', 'hasNoLinkedRecords', 'isEmpty', 'isNotEmpty'],
  attachment: ['isEmpty', 'isNotEmpty'],
};

export type SortDirection = 'asc' | 'desc';
export type NullOrdering = 'first' | 'last';

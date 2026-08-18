'use client';

import { useState } from 'react';

import { cn } from '@/lib/cn';

import type { Field } from '../data/api';

/**
 * The view toolbar.
 *
 * Every control here changes what the *view* holds, not what the request happens to ask for.
 * That distinction matters: a filter typed into a toolbar and lost on refresh is a demo, and the
 * moment two people look at the same view they must see the same rows. So each panel edits view
 * state and hands the whole thing back to be saved.
 *
 * Rendered as popovers rather than modals — a person adjusting a filter is looking at the rows
 * behind it, and a modal hides the thing they are adjusting.
 */

export interface ViewState {
  filter?: FilterGroup;
  sorts: Sort[];
  groups: Group[];
  hiddenFieldIds: string[];
  rowHeight: RowHeight;
  /** Airtable's "Color" — the first matching rule tints the whole row. */
  colorRules?: ColorRule[];
}

export interface ColorRule {
  fieldId: string;
  operator: string;
  value?: unknown;
  color: string;
}

/** The row tints on offer — light enough that black text stays readable on every one. */
export const ROW_COLORS = [
  { value: '#fee2e2', label: 'Red' },
  { value: '#ffedd5', label: 'Orange' },
  { value: '#fef9c3', label: 'Yellow' },
  { value: '#dcfce7', label: 'Green' },
  { value: '#ccfbf1', label: 'Teal' },
  { value: '#dbeafe', label: 'Blue' },
  { value: '#ede9fe', label: 'Purple' },
  { value: '#fce7f3', label: 'Pink' },
  { value: '#e5e7eb', label: 'Gray' },
] as const;

/**
 * The first rule the record matches decides its color — same first-wins semantics as Airtable,
 * so rule order is meaningful and predictable. Evaluated client-side over the loaded rows; the
 * operators mirror the filter vocabulary so what you can filter by, you can color by.
 */
export function rowColorFor(
  recordFields: Record<string, unknown>,
  rules: ColorRule[] | undefined,
): string | null {
  if (!rules || rules.length === 0) return null;
  for (const rule of rules) {
    if (rule.fieldId && ruleMatches(recordFields[rule.fieldId], rule.operator, rule.value)) {
      return rule.color;
    }
  }
  return null;
}

function ruleMatches(raw: unknown, operator: string, target: unknown): boolean {
  const isBlank =
    raw === null || raw === undefined || raw === '' || (Array.isArray(raw) && raw.length === 0);
  const text = isBlank ? '' : Array.isArray(raw) ? '' : String(raw);
  const lower = text.toLowerCase();
  const targetText = String(target ?? '').trim().toLowerCase();

  switch (operator) {
    case 'is': {
      // Checkbox rules accept the words people type for them.
      if (typeof raw === 'boolean') {
        return raw ? ['true', 'checked', 'yes', '1', '✓'].includes(targetText) : ['false', 'unchecked', 'no', '0', ''].includes(targetText);
      }
      const n = Number(text);
      const tn = Number(targetText);
      if (text !== '' && targetText !== '' && !Number.isNaN(n) && !Number.isNaN(tn)) return n === tn;
      return lower === targetText;
    }
    case 'isNot':
      return !ruleMatches(raw, 'is', target);
    case 'contains':
      return targetText !== '' && lower.includes(targetText);
    case 'doesNotContain':
      return !(targetText !== '' && lower.includes(targetText));
    case 'isGreater':
      return text !== '' && !Number.isNaN(Number(text)) && Number(text) > Number(targetText);
    case 'isLess':
      return text !== '' && !Number.isNaN(Number(text)) && Number(text) < Number(targetText);
    case 'isBefore':
      return text !== '' && Date.parse(text) < Date.parse(String(target ?? ''));
    case 'isAfter':
      return text !== '' && Date.parse(text) > Date.parse(String(target ?? ''));
    case 'isEmpty':
      return isBlank || raw === false;
    case 'isNotEmpty':
      return !(isBlank || raw === false);
    default:
      return false;
  }
}

export type RowHeight = 'short' | 'medium' | 'tall' | 'extraTall';

export interface FilterCondition {
  fieldId: string;
  operator: string;
  value?: unknown;
}

export interface FilterGroup {
  conjunction: 'and' | 'or';
  conditions: Array<FilterCondition | FilterGroup>;
}

export interface Sort {
  fieldId: string;
  direction: 'asc' | 'desc';
}

export interface Group {
  fieldId: string;
  direction: 'asc' | 'desc';
}

interface ToolbarProps {
  readonly fields: Field[];
  readonly state: ViewState;
  readonly onChange: (state: ViewState) => void;
  readonly onSearch: (query: string) => void;
  readonly searchQuery: string;
  readonly recordCount: number;
  readonly canEdit: boolean;
}

export function ViewToolbar({
  fields,
  state,
  onChange,
  onSearch,
  searchQuery,
  recordCount,
  canEdit,
}: ToolbarProps) {
  const [open, setOpen] = useState<string | null>(null);
  const toggle = (panel: string) => setOpen((current) => (current === panel ? null : panel));

  const hiddenCount = state.hiddenFieldIds.length;
  const filterCount = state.filter ? countConditions(state.filter) : 0;

  return (
    <div className="relative border-b border-line bg-surface text-sm">
      {/* The buttons scroll sideways on narrow screens rather than wrapping into a second row;
          the dropdown panels live outside this scroller so they are not clipped by it. */}
      <div className="flex items-center gap-1 overflow-x-auto whitespace-nowrap px-3 py-1.5 [&>*]:shrink-0">
      <ToolbarButton
        label={hiddenCount > 0 ? `${hiddenCount} hidden` : 'Hide fields'}
        icon="◫"
        active={hiddenCount > 0}
        onClick={() => toggle('fields')}
      />
      <ToolbarButton
        label={filterCount > 0 ? `Filtered by ${filterCount}` : 'Filter'}
        icon="⌗"
        active={filterCount > 0}
        onClick={() => toggle('filter')}
      />
      <ToolbarButton
        label={state.groups.length > 0 ? `Grouped by ${state.groups.length}` : 'Group'}
        icon="⊞"
        active={state.groups.length > 0}
        onClick={() => toggle('group')}
      />
      <ToolbarButton
        label={state.sorts.length > 0 ? `Sorted by ${state.sorts.length}` : 'Sort'}
        icon="⇅"
        active={state.sorts.length > 0}
        onClick={() => toggle('sort')}
      />
      <ToolbarButton
        label={state.colorRules?.length ? `Colored by ${state.colorRules.length}` : 'Color'}
        icon="🎨"
        active={(state.colorRules?.length ?? 0) > 0}
        onClick={() => toggle('color')}
      />
      <ToolbarButton label="Row height" icon="≡" onClick={() => toggle('height')} />

      <div className="ml-auto flex items-center gap-2">
        <span className="text-xs text-tertiary">{recordCount} records</span>
        <input
          type="search"
          value={searchQuery}
          onChange={(event) => onSearch(event.target.value)}
          placeholder="Search"
          aria-label="Search records"
          className="h-7 w-40 rounded border border-line bg-sunken px-2 text-sm outline-none focus:border-accent"
        />
      </div>
      </div>

      {open === 'fields' && (
        <Panel onClose={() => setOpen(null)} title="Fields">
          {fields.map((field) => {
            const hidden = state.hiddenFieldIds.includes(field.id);
            return (
              <label key={field.id} className="flex items-center gap-2 px-2 py-1 hover:bg-sunken">
                <input
                  type="checkbox"
                  checked={!hidden}
                  disabled={!canEdit || field.isPrimary}
                  onChange={() =>
                    onChange({
                      ...state,
                      hiddenFieldIds: hidden
                        ? state.hiddenFieldIds.filter((id) => id !== field.id)
                        : [...state.hiddenFieldIds, field.id],
                    })
                  }
                />
                <span className="truncate">{field.name}</span>
                {/* The primary field is what identifies a row; hiding it leaves a grid of
                    anonymous cells, so it is offered as disabled rather than absent. */}
                {field.isPrimary && <span className="ml-auto text-2xs text-tertiary">primary</span>}
              </label>
            );
          })}
        </Panel>
      )}

      {open === 'filter' && (
        <Panel onClose={() => setOpen(null)} title="Filter" wide>
          <FilterEditor
            fields={fields}
            group={state.filter ?? { conjunction: 'and', conditions: [] }}
            canEdit={canEdit}
            onChange={(filter) =>
              onChange({
                ...state,
                // An empty group is stored as no filter at all, so a view that filtered nothing
                // does not carry an empty condition list forever.
                filter: filter.conditions.length > 0 ? filter : undefined,
              })
            }
          />
        </Panel>
      )}

      {open === 'group' && (
        <Panel onClose={() => setOpen(null)} title="Group" wide>
          <FieldListEditor
            fields={fields}
            entries={state.groups}
            canEdit={canEdit}
            max={3}
            emptyLabel="Pick a field to group by"
            onChange={(groups) => onChange({ ...state, groups })}
          />
        </Panel>
      )}

      {open === 'sort' && (
        <Panel onClose={() => setOpen(null)} title="Sort" wide>
          <FieldListEditor
            fields={fields}
            entries={state.sorts}
            canEdit={canEdit}
            max={10}
            emptyLabel="Pick a field to sort by"
            onChange={(sorts) => onChange({ ...state, sorts })}
          />
        </Panel>
      )}

      {open === 'color' && (
        <Panel onClose={() => setOpen(null)} title="Color" wide>
          <ColorRulesEditor
            fields={fields}
            rules={state.colorRules ?? []}
            canEdit={canEdit}
            onChange={(colorRules) =>
              onChange({
                ...state,
                ...(colorRules.length > 0 ? { colorRules } : { colorRules: [] }),
              })
            }
          />
        </Panel>
      )}

      {open === 'height' && (
        <Panel onClose={() => setOpen(null)} title="Row height">
          {(['short', 'medium', 'tall', 'extraTall'] as const).map((height) => (
            <button
              key={height}
              type="button"
              disabled={!canEdit}
              onClick={() => onChange({ ...state, rowHeight: height })}
              className={cn(
                'flex w-full items-center gap-2 px-2 py-1 text-left hover:bg-sunken',
                state.rowHeight === height && 'text-accent-text',
              )}
            >
              <span aria-hidden="true">{state.rowHeight === height ? '✓' : ' '}</span>
              {height === 'extraTall' ? 'Extra tall' : height[0]?.toUpperCase() + height.slice(1)}
            </button>
          ))}
        </Panel>
      )}
    </div>
  );
}

function ToolbarButton({
  label,
  icon,
  active,
  onClick,
}: {
  label: string;
  icon: string;
  active?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'flex items-center gap-1.5 rounded px-2 py-1 hover:bg-sunken',
        active && 'bg-accent-subtle text-accent-text',
      )}
    >
      <span aria-hidden="true" className="text-xs">
        {icon}
      </span>
      {label}
    </button>
  );
}

function Panel({
  title,
  children,
  onClose,
  wide,
}: {
  title: string;
  children: React.ReactNode;
  onClose: () => void;
  wide?: boolean;
}) {
  return (
    <>
      {/* A click anywhere else closes the panel. Rendered before the panel so it sits beneath it. */}
      <button
        type="button"
        aria-label={`Close ${title}`}
        onClick={onClose}
        className="fixed inset-0 z-20 cursor-default"
      />
      <div
        role="dialog"
        aria-label={title}
        className={cn(
          'absolute left-3 top-full z-30 mt-1 max-h-96 overflow-auto rounded-md border border-line bg-surface p-1 shadow-lg',
          wide ? 'w-[32rem]' : 'w-64',
        )}
      >
        {children}
      </div>
    </>
  );
}

/** Operators offered per field type. Kept narrow so the list is usable rather than exhaustive. */
const OPERATORS: Record<string, Array<{ value: string; label: string }>> = {
  text: [
    { value: 'is', label: 'is' },
    { value: 'isNot', label: 'is not' },
    { value: 'contains', label: 'contains' },
    { value: 'doesNotContain', label: 'does not contain' },
    { value: 'isEmpty', label: 'is empty' },
    { value: 'isNotEmpty', label: 'is not empty' },
  ],
  number: [
    { value: 'is', label: '=' },
    { value: 'isNot', label: '≠' },
    { value: 'isGreater', label: '>' },
    { value: 'isLess', label: '<' },
    { value: 'isEmpty', label: 'is empty' },
    { value: 'isNotEmpty', label: 'is not empty' },
  ],
  date: [
    { value: 'is', label: 'is' },
    { value: 'isBefore', label: 'is before' },
    { value: 'isAfter', label: 'is after' },
    { value: 'isEmpty', label: 'is empty' },
    { value: 'isNotEmpty', label: 'is not empty' },
  ],
};

function operatorsFor(type: string) {
  if (['number', 'currency', 'percent', 'decimal', 'rating', 'count', 'duration'].includes(type)) {
    return OPERATORS['number'] as Array<{ value: string; label: string }>;
  }
  if (['date', 'dateTime', 'createdTime', 'lastModifiedTime'].includes(type)) {
    return OPERATORS['date'] as Array<{ value: string; label: string }>;
  }
  return OPERATORS['text'] as Array<{ value: string; label: string }>;
}

/** Operators that take no value; showing an input beside them invites a meaningless entry. */
const VALUELESS = new Set(['isEmpty', 'isNotEmpty']);

function FilterEditor({
  fields,
  group,
  onChange,
  canEdit,
}: {
  fields: Field[];
  group: FilterGroup;
  onChange: (group: FilterGroup) => void;
  canEdit: boolean;
}) {
  const conditions = group.conditions.filter((c): c is FilterCondition => !('conjunction' in c));

  const update = (index: number, patch: Partial<FilterCondition>) => {
    const next = [...group.conditions];
    next[index] = { ...(next[index] as FilterCondition), ...patch };
    onChange({ ...group, conditions: next });
  };

  return (
    <div className="space-y-1 p-1">
      {conditions.length === 0 && (
        <p className="px-1 py-2 text-sm text-tertiary">No filters. Rows are shown as they are.</p>
      )}

      {conditions.map((condition, index) => {
        const field = fields.find((f) => f.id === condition.fieldId);
        const operators = operatorsFor(field?.type ?? 'singleLineText');

        return (
          <div key={index} className="flex items-center gap-1">
            <span className="w-12 shrink-0 text-xs text-tertiary">
              {index === 0 ? 'Where' : group.conjunction}
            </span>

            <select
              value={condition.fieldId}
              disabled={!canEdit}
              onChange={(event) => update(index, { fieldId: event.target.value })}
              className="h-7 flex-1 rounded border border-line bg-surface px-1 text-sm"
            >
              {fields.map((f) => (
                <option key={f.id} value={f.id}>
                  {f.name}
                </option>
              ))}
            </select>

            <select
              value={condition.operator}
              disabled={!canEdit}
              onChange={(event) => update(index, { operator: event.target.value })}
              className="h-7 w-36 rounded border border-line bg-surface px-1 text-sm"
            >
              {operators.map((operator) => (
                <option key={operator.value} value={operator.value}>
                  {operator.label}
                </option>
              ))}
            </select>

            {!VALUELESS.has(condition.operator) && (
              <input
                value={String(condition.value ?? '')}
                disabled={!canEdit}
                onChange={(event) => update(index, { value: event.target.value })}
                placeholder="Value"
                className="h-7 w-32 rounded border border-line bg-surface px-1 text-sm"
              />
            )}

            <button
              type="button"
              disabled={!canEdit}
              aria-label="Remove filter"
              onClick={() =>
                onChange({ ...group, conditions: group.conditions.filter((_, i) => i !== index) })
              }
              className="px-1 text-tertiary hover:text-danger-text"
            >
              ✕
            </button>
          </div>
        );
      })}

      <div className="flex items-center gap-2 pt-1">
        <button
          type="button"
          disabled={!canEdit || fields.length === 0}
          onClick={() =>
            onChange({
              ...group,
              conditions: [
                ...group.conditions,
                { fieldId: fields[0]?.id as string, operator: 'is', value: '' },
              ],
            })
          }
          className="rounded px-2 py-1 text-sm text-accent-text hover:bg-sunken"
        >
          + Add condition
        </button>

        {conditions.length > 1 && (
          <select
            value={group.conjunction}
            disabled={!canEdit}
            onChange={(event) =>
              onChange({ ...group, conjunction: event.target.value as 'and' | 'or' })
            }
            className="h-7 rounded border border-line bg-surface px-1 text-sm"
          >
            <option value="and">match all</option>
            <option value="or">match any</option>
          </select>
        )}
      </div>
    </div>
  );
}

/** Shared by sort and group: both are a bounded, ordered list of field + direction. */
function FieldListEditor({
  fields,
  entries,
  onChange,
  canEdit,
  max,
  emptyLabel,
}: {
  fields: Field[];
  entries: Array<{ fieldId: string; direction: 'asc' | 'desc' }>;
  onChange: (entries: Array<{ fieldId: string; direction: 'asc' | 'desc' }>) => void;
  canEdit: boolean;
  max: number;
  emptyLabel: string;
}) {
  // A field already used cannot be picked again: the second entry silently does nothing, which
  // reads as the feature being broken rather than duplicated.
  const used = new Set(entries.map((entry) => entry.fieldId));
  const available = fields.filter((field) => !used.has(field.id));

  return (
    <div className="space-y-1 p-1">
      {entries.length === 0 && <p className="px-1 py-2 text-sm text-tertiary">{emptyLabel}</p>}

      {entries.map((entry, index) => (
        <div key={entry.fieldId} className="flex items-center gap-1">
          <select
            value={entry.fieldId}
            disabled={!canEdit}
            onChange={(event) => {
              const next = [...entries];
              next[index] = { ...entry, fieldId: event.target.value };
              onChange(next);
            }}
            className="h-7 flex-1 rounded border border-line bg-surface px-1 text-sm"
          >
            <option value={entry.fieldId}>
              {fields.find((f) => f.id === entry.fieldId)?.name ?? entry.fieldId}
            </option>
            {available.map((field) => (
              <option key={field.id} value={field.id}>
                {field.name}
              </option>
            ))}
          </select>

          <select
            value={entry.direction}
            disabled={!canEdit}
            onChange={(event) => {
              const next = [...entries];
              next[index] = { ...entry, direction: event.target.value as 'asc' | 'desc' };
              onChange(next);
            }}
            className="h-7 w-28 rounded border border-line bg-surface px-1 text-sm"
          >
            <option value="asc">A → Z</option>
            <option value="desc">Z → A</option>
          </select>

          <button
            type="button"
            disabled={!canEdit}
            aria-label="Remove"
            onClick={() => onChange(entries.filter((_, i) => i !== index))}
            className="px-1 text-tertiary hover:text-danger-text"
          >
            ✕
          </button>
        </div>
      ))}

      {entries.length < max && available.length > 0 && (
        <button
          type="button"
          disabled={!canEdit}
          onClick={() => onChange([...entries, { fieldId: available[0]?.id as string, direction: 'asc' }])}
          className="rounded px-2 py-1 text-sm text-accent-text hover:bg-sunken"
        >
          + Add
        </button>
      )}
    </div>
  );
}

/**
 * Airtable's color-rule editor: each rule reads "where <field> <operator> <value>, tint <color>".
 * First matching rule wins, so the list order is the priority order.
 */
function ColorRulesEditor({
  fields,
  rules,
  onChange,
  canEdit,
}: {
  fields: Field[];
  rules: ColorRule[];
  onChange: (rules: ColorRule[]) => void;
  canEdit: boolean;
}) {
  const update = (index: number, patch: Partial<ColorRule>) => {
    const next = [...rules];
    next[index] = { ...(next[index] as ColorRule), ...patch };
    onChange(next);
  };

  return (
    <div className="space-y-1.5 p-1">
      {rules.length === 0 && (
        <p className="px-1 py-2 text-sm text-tertiary">
          No color rules. Rows matching a rule get its color — the first match wins.
        </p>
      )}

      {rules.map((rule, index) => {
        const field = fields.find((f) => f.id === rule.fieldId);
        const operators = operatorsFor(field?.type ?? 'singleLineText');

        return (
          <div key={index} className="flex flex-wrap items-center gap-1">
            <span className="w-12 shrink-0 text-xs text-tertiary">
              {index === 0 ? 'Where' : 'or'}
            </span>

            <select
              value={rule.fieldId}
              disabled={!canEdit}
              aria-label="Color rule field"
              onChange={(event) => update(index, { fieldId: event.target.value })}
              className="h-7 min-w-28 flex-1 rounded border border-line bg-surface px-1 text-sm"
            >
              {fields.map((f) => (
                <option key={f.id} value={f.id}>
                  {f.name}
                </option>
              ))}
            </select>

            <select
              value={rule.operator}
              disabled={!canEdit}
              aria-label="Color rule operator"
              onChange={(event) => update(index, { operator: event.target.value })}
              className="h-7 w-32 rounded border border-line bg-surface px-1 text-sm"
            >
              {operators.map((operator) => (
                <option key={operator.value} value={operator.value}>
                  {operator.label}
                </option>
              ))}
            </select>

            {!VALUELESS.has(rule.operator) && (
              <input
                value={String(rule.value ?? '')}
                disabled={!canEdit}
                onChange={(event) => update(index, { value: event.target.value })}
                placeholder="Value"
                aria-label="Color rule value"
                className="h-7 w-28 rounded border border-line bg-surface px-1 text-sm"
              />
            )}

            <span className="flex items-center gap-0.5">
              {ROW_COLORS.map((color) => (
                <button
                  key={color.value}
                  type="button"
                  disabled={!canEdit}
                  title={color.label}
                  aria-label={`Color ${color.label}`}
                  onClick={() => update(index, { color: color.value })}
                  className={cn(
                    'h-5 w-5 rounded-full border',
                    rule.color === color.value ? 'border-2 border-accent' : 'border-line',
                  )}
                  style={{ backgroundColor: color.value }}
                />
              ))}
            </span>

            <button
              type="button"
              disabled={!canEdit}
              aria-label="Remove color rule"
              onClick={() => onChange(rules.filter((_, i) => i !== index))}
              className="px-1 text-tertiary hover:text-danger-text"
            >
              ✕
            </button>
          </div>
        );
      })}

      {rules.length < 5 && (
        <button
          type="button"
          disabled={!canEdit || fields.length === 0}
          onClick={() =>
            onChange([
              ...rules,
              {
                fieldId: fields[0]?.id as string,
                operator: 'is',
                value: '',
                color: ROW_COLORS[0].value,
              },
            ])
          }
          className="rounded px-2 py-1 text-sm text-accent-text hover:bg-sunken"
        >
          + Add color rule
        </button>
      )}
    </div>
  );
}

function countConditions(group: FilterGroup): number {
  return group.conditions.reduce<number>(
    (total, condition) => total + ('conjunction' in condition ? countConditions(condition) : 1),
    0,
  );
}

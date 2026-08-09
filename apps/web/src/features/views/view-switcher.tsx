'use client';

import { useState } from 'react';

import { cn } from '@/lib/cn';

import type { Field } from '../data/api';

/**
 * Switches a table between view types.
 *
 * Every type is offered, but one that cannot render with the fields the table actually has is
 * offered as unavailable with the reason attached — a kanban needs a single-select to stack by,
 * a calendar needs a date. Hiding them instead would leave people wondering why their table has
 * fewer options than the one next to it; letting them be chosen produces an empty board with no
 * explanation.
 */

export const VIEW_TYPES = [
  'grid', 'kanban', 'calendar', 'gallery', 'timeline', 'gantt', 'chart', 'map',
] as const;

export type ViewType = (typeof VIEW_TYPES)[number];

const LABELS: Record<ViewType, string> = {
  grid: 'Grid',
  kanban: 'Kanban',
  calendar: 'Calendar',
  gallery: 'Gallery',
  timeline: 'Timeline',
  gantt: 'Gantt',
  chart: 'Chart',
  map: 'Map',
};

const GLYPHS: Record<ViewType, string> = {
  grid: '▦', kanban: '▥', calendar: '▤', gallery: '▣',
  timeline: '▬', gantt: '▭', chart: '▧', map: '◉',
};

/** What each type needs from the table, and how to say so when it is missing. */
function availability(type: ViewType, fields: Field[]): { ok: true } | { ok: false; reason: string } {
  const has = (types: string[]) => fields.some((field) => types.includes(field.type));

  switch (type) {
    case 'kanban':
      return has(['singleSelect', 'status', 'user'])
        ? { ok: true }
        : { ok: false, reason: 'needs a single-select or collaborator field to stack by' };
    case 'calendar':
    case 'timeline':
    case 'gantt':
      return has(['date', 'dateTime'])
        ? { ok: true }
        : { ok: false, reason: 'needs a date field' };
    case 'map':
      return has(['singleLineText', 'longText'])
        ? { ok: true }
        : { ok: false, reason: 'needs an address or coordinate field' };
    default:
      return { ok: true };
  }
}

export function ViewSwitcher({
  active,
  fields,
  onChange,
}: {
  active: ViewType;
  fields: Field[];
  onChange: (type: ViewType) => void;
}) {
  const [open, setOpen] = useState(false);

  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        className="flex items-center gap-1.5 rounded px-2 py-1 text-sm hover:bg-sunken"
      >
        <span aria-hidden="true">{GLYPHS[active]}</span>
        {LABELS[active]} view
        <span aria-hidden="true" className="text-xs text-tertiary">
          ▾
        </span>
      </button>

      {open && (
        <>
          <button
            type="button"
            aria-label="Close view menu"
            onClick={() => setOpen(false)}
            className="fixed inset-0 z-20 cursor-default"
          />
          <div
            role="menu"
            aria-label="View type"
            className="absolute left-0 top-full z-30 mt-1 w-64 rounded-md border border-line bg-surface p-1 shadow-lg"
          >
            {VIEW_TYPES.map((type) => {
              const state = availability(type, fields);

              return (
                <button
                  key={type}
                  type="button"
                  role="menuitem"
                  disabled={!state.ok}
                  onClick={() => {
                    onChange(type);
                    setOpen(false);
                  }}
                  className={cn(
                    'flex w-full items-start gap-2 rounded px-2 py-1.5 text-left text-sm',
                    state.ok ? 'hover:bg-sunken' : 'cursor-not-allowed opacity-60',
                    type === active && 'text-accent-text',
                  )}
                >
                  <span aria-hidden="true" className="pt-0.5">
                    {GLYPHS[type]}
                  </span>
                  <span className="min-w-0">
                    <span className="block">{LABELS[type]}</span>
                    {/* The reason travels with the disabled option, so the answer to "why can't I
                        pick this" is right there rather than somewhere in documentation. */}
                    {!state.ok && (
                      <span className="block text-xs text-tertiary">{state.reason}</span>
                    )}
                  </span>
                  {type === active && <span className="ml-auto">✓</span>}
                </button>
              );
            })}
          </div>
        </>
      )}
    </div>
  );
}

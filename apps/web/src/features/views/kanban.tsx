'use client';

import { useMemo } from 'react';

import { cn } from '@/lib/cn';

import type { Field, RecordRow } from '../data/api';

/**
 * The kanban board.
 *
 * The same records the grid shows, stacked by one field's value. Two things this is careful about:
 *
 *  - **Every record appears exactly once.** A record whose stack value is empty, or is an option
 *    that has since been deleted, still has to land somewhere — otherwise the board silently holds
 *    fewer records than the table, and nobody can tell which are missing.
 *  - **Stacks come from the field's options, not from the data.** Deriving them from the values
 *    present means an empty column vanishes, so a board loses its "Done" stack the moment the last
 *    finished record is archived.
 */

interface Choice {
  id: string;
  label: string;
  color?: string;
}

export function KanbanBoard({
  fields,
  records,
  stackFieldId,
  onOpenRecord,
}: {
  fields: readonly Field[];
  records: readonly RecordRow[];
  stackFieldId: string;
  onOpenRecord?: (recordId: string) => void;
}) {
  const stackField = fields.find((field) => field.id === stackFieldId);
  const primaryField = fields.find((field) => field.isPrimary) ?? fields[0];

  const stacks = useMemo(() => {
    const choices = (stackField?.options?.['choices'] as Choice[] | undefined) ?? [];

    // The "no value" stack is first and always present: a board that hides unassigned records
    // makes them invisible rather than obviously waiting for someone.
    const columns: Array<{ id: string | null; label: string; color?: string; records: RecordRow[] }> = [
      { id: null, label: 'Unassigned', records: [] },
      ...choices.map((choice) => ({
        id: choice.id,
        label: choice.label,
        ...(choice.color ? { color: choice.color } : {}),
        records: [] as RecordRow[],
      })),
    ];

    const byId = new Map(columns.map((column) => [column.id, column]));
    // Values that match no known option — an option deleted after records were filed under it.
    // They get their own stack rather than disappearing. Typed identically to `columns` so the
    // two concatenate into one list the renderer can treat uniformly.
    const orphans: typeof columns = [];

    for (const record of records) {
      const value = record.fields[stackFieldId];
      const key = typeof value === 'string' && value !== '' ? value : null;

      const column = byId.get(key);
      if (column) {
        column.records.push(record);
        continue;
      }

      const existing = orphans.find((orphan) => orphan.id === key);
      if (existing) existing.records.push(record);
      else orphans.push({ id: key as string, label: `${key} (removed)`, records: [record] });
    }

    return [...columns, ...orphans];
  }, [records, stackField, stackFieldId]);

  if (!stackField) {
    return (
      <div className="p-6 text-sm text-secondary">
        This board is built on a field that is no longer in the table.
      </div>
    );
  }

  const total = stacks.reduce((sum, stack) => sum + stack.records.length, 0);

  return (
    <div className="flex h-full flex-col">
      {/* Asserted in the UI, not only in a test: if these ever disagree the board is dropping
          records, and the person looking at it should be the first to know. */}
      {total !== records.length && (
        <p role="alert" className="border-b border-line bg-danger-subtle px-3 py-1.5 text-xs text-danger-text">
          This board is showing {total} of {records.length} records.
        </p>
      )}

      <div className="flex min-h-0 flex-1 gap-3 overflow-x-auto p-3">
        {stacks.map((stack) => (
          <section
            key={stack.id ?? '__unassigned'}
            aria-label={stack.label}
            className="flex w-72 shrink-0 flex-col rounded-md bg-sunken"
          >
            <header className="flex items-center gap-2 px-3 py-2">
              <span
                className="truncate text-sm font-medium"
                style={stack.color ? { color: stack.color } : undefined}
              >
                {stack.label}
              </span>
              <span className="ml-auto text-xs text-tertiary">{stack.records.length}</span>
            </header>

            <div className="min-h-0 flex-1 space-y-2 overflow-y-auto px-2 pb-2">
              {stack.records.map((record) => (
                <button
                  key={record.id}
                  type="button"
                  onClick={() => onOpenRecord?.(record.id)}
                  className={cn(
                    'w-full rounded border border-line bg-surface p-2 text-left text-sm',
                    'hover:border-accent',
                  )}
                >
                  <p className="truncate font-medium text-primary">
                    {primaryField ? String(record.fields[primaryField.id] ?? 'Untitled') : 'Untitled'}
                  </p>

                  {/* Two more fields for context. More than that and the card stops being
                      scannable, which is the only reason to use a board over a grid. */}
                  {fields
                    .filter((field) => field.id !== primaryField?.id && field.id !== stackFieldId)
                    .slice(0, 2)
                    .map((field) => {
                      const value = record.fields[field.id];
                      if (value === null || value === undefined || value === '') return null;
                      return (
                        <p key={field.id} className="mt-0.5 truncate text-xs text-tertiary">
                          {String(value)}
                        </p>
                      );
                    })}
                </button>
              ))}

              {stack.records.length === 0 && (
                <p className="px-1 py-2 text-xs text-tertiary">Nothing here</p>
              )}
            </div>
          </section>
        ))}
      </div>
    </div>
  );
}

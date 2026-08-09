'use client';

import { useMemo, useState } from 'react';

import { cn } from '@/lib/cn';

import type { Field, RecordRow } from '../data/api';

/**
 * The calendar view.
 *
 * A month grid of the records that carry a date. Three things it is careful about:
 *
 *  - **Dates are read in UTC**, the way they are stored. Reading them in the browser's zone
 *    shifts a date-only value across midnight for anybody west of UTC, so a record filed on the
 *    1st shows on the 30th — a bug that only appears for some users and looks like bad data.
 *  - **Records with no date are counted, not dropped.** A calendar that silently omits them
 *    disagrees with the grid's record count and nobody can tell why.
 *  - **The grid always shows whole weeks**, so every month is a rectangle and the layout does not
 *    jump between months.
 */

const WEEKDAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

export function CalendarView({
  fields,
  records,
  dateFieldId,
  onOpenRecord,
}: {
  fields: readonly Field[];
  records: readonly RecordRow[];
  dateFieldId: string;
  onOpenRecord?: (recordId: string) => void;
}) {
  const [month, setMonth] = useState(() => {
    const now = new Date();
    return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  });

  const dateField = fields.find((field) => field.id === dateFieldId);
  const primaryField = fields.find((field) => field.isPrimary) ?? fields[0];

  const { byDay, undated } = useMemo(() => {
    const map = new Map<string, RecordRow[]>();
    const without: RecordRow[] = [];

    for (const record of records) {
      const raw = record.fields[dateFieldId];
      if (typeof raw !== 'string' || raw === '') {
        without.push(record);
        continue;
      }

      const parsed = new Date(raw);
      if (Number.isNaN(parsed.getTime())) {
        without.push(record);
        continue;
      }

      // Keyed on the UTC date parts, matching how the value is stored.
      const key = `${parsed.getUTCFullYear()}-${parsed.getUTCMonth()}-${parsed.getUTCDate()}`;
      map.set(key, [...(map.get(key) ?? []), record]);
    }

    return { byDay: map, undated: without };
  }, [records, dateFieldId]);

  const weeks = useMemo(() => {
    const first = new Date(month);
    // Monday-first: `getUTCDay()` is 0 for Sunday, so Sunday becomes 6 rather than -1.
    const offset = (first.getUTCDay() + 6) % 7;

    const start = new Date(first);
    start.setUTCDate(first.getUTCDate() - offset);

    // Six weeks always: a month that needs five and one that needs six would otherwise change
    // the page height as you page through, which is jarring.
    return Array.from({ length: 6 }, (_, week) =>
      Array.from({ length: 7 }, (_, day) => {
        const date = new Date(start);
        date.setUTCDate(start.getUTCDate() + week * 7 + day);
        return date;
      }),
    );
  }, [month]);

  if (!dateField) {
    return (
      <div className="p-6 text-sm text-secondary">
        This calendar is built on a field that is no longer in the table.
      </div>
    );
  }

  const shift = (delta: number) =>
    setMonth((current) => new Date(Date.UTC(current.getUTCFullYear(), current.getUTCMonth() + delta, 1)));

  const monthLabel = month.toLocaleString('en', { month: 'long', year: 'numeric', timeZone: 'UTC' });

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center gap-2 border-b border-line px-3 py-2">
        <button type="button" onClick={() => shift(-1)} aria-label="Previous month" className="px-2 hover:bg-sunken">
          ‹
        </button>
        <span className="text-sm font-medium">{monthLabel}</span>
        <button type="button" onClick={() => shift(1)} aria-label="Next month" className="px-2 hover:bg-sunken">
          ›
        </button>

        {undated.length > 0 && (
          // Reported rather than dropped: a calendar that silently omits them disagrees with the
          // grid's count and nobody can tell why.
          <span className="ml-auto text-xs text-tertiary">
            {undated.length} without a date
          </span>
        )}
      </div>

      <div className="grid grid-cols-7 border-b border-line text-xs text-tertiary">
        {WEEKDAYS.map((day) => (
          <div key={day} className="px-2 py-1">
            {day}
          </div>
        ))}
      </div>

      <div className="grid min-h-0 flex-1 grid-cols-7 grid-rows-6">
        {weeks.flat().map((date) => {
          const key = `${date.getUTCFullYear()}-${date.getUTCMonth()}-${date.getUTCDate()}`;
          const dayRecords = byDay.get(key) ?? [];
          const inMonth = date.getUTCMonth() === month.getUTCMonth();

          return (
            <div
              key={key}
              className={cn(
                'min-h-0 overflow-y-auto border-b border-r border-line p-1',
                !inMonth && 'bg-sunken/40',
              )}
            >
              <div className={cn('mb-1 text-xs', inMonth ? 'text-secondary' : 'text-tertiary')}>
                {date.getUTCDate()}
              </div>

              {dayRecords.map((record) => (
                <button
                  key={record.id}
                  type="button"
                  onClick={() => onOpenRecord?.(record.id)}
                  className="mb-1 block w-full truncate rounded bg-accent-subtle px-1 py-0.5 text-left text-xs text-accent-text hover:bg-accent hover:text-inverted"
                >
                  {primaryField ? String(record.fields[primaryField.id] ?? 'Untitled') : 'Untitled'}
                </button>
              ))}
            </div>
          );
        })}
      </div>
    </div>
  );
}

/**
 * The gallery view: one card per record, with an attachment as the cover when there is one.
 */
export function GalleryView({
  fields,
  records,
  onOpenRecord,
}: {
  fields: readonly Field[];
  records: readonly RecordRow[];
  onOpenRecord?: (recordId: string) => void;
}) {
  const primaryField = fields.find((field) => field.isPrimary) ?? fields[0];
  const coverField = fields.find((field) => field.type === 'attachment');

  return (
    <div className="grid h-full grid-cols-[repeat(auto-fill,minmax(14rem,1fr))] gap-3 overflow-y-auto p-3">
      {records.map((record) => {
        const attachments = coverField
          ? (record.fields[coverField.id] as Array<{ url?: string; mimeType?: string }> | undefined)
          : undefined;
        const image = attachments?.find((file) => file.mimeType?.startsWith('image/') && file.url);

        return (
          <button
            key={record.id}
            type="button"
            onClick={() => onOpenRecord?.(record.id)}
            className="flex flex-col overflow-hidden rounded border border-line bg-surface text-left hover:border-accent"
          >
            {image?.url ? (
              // A plain <img>: the URL is signed, expires within the hour, and lives on a
              // cookie-free origin the image optimiser cannot fetch through.
              <img src={image.url} alt="" className="h-32 w-full object-cover" loading="lazy" />
            ) : (
              <div className="flex h-32 w-full items-center justify-center bg-sunken text-2xl text-tertiary">
                ▣
              </div>
            )}

            <div className="p-2">
              <p className="truncate text-sm font-medium text-primary">
                {primaryField ? String(record.fields[primaryField.id] ?? 'Untitled') : 'Untitled'}
              </p>
              {fields
                .filter((field) => field.id !== primaryField?.id && field.id !== coverField?.id)
                .slice(0, 2)
                .map((field) => {
                  const value = record.fields[field.id];
                  if (value === null || value === undefined || value === '') return null;
                  return (
                    <p key={field.id} className="truncate text-xs text-tertiary">
                      {String(value)}
                    </p>
                  );
                })}
            </div>
          </button>
        );
      })}

      {records.length === 0 && (
        <p className="col-span-full p-6 text-center text-sm text-secondary">No records to show.</p>
      )}
    </div>
  );
}

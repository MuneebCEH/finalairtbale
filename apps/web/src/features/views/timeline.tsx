'use client';

import { useMemo } from 'react';

import { cn } from '@/lib/cn';

import type { Field, RecordRow } from '../data/api';

/**
 * Timeline and Gantt.
 *
 * The same rendering: records as bars across a date axis. Gantt adds dependency arrows; until
 * linked records are wired through the API it renders as a timeline and says so, rather than
 * drawing an empty dependency layer that suggests it found none.
 *
 * The axis is derived from the data, not from today. A project that ran last year should open on
 * last year — a timeline that always starts at the current month shows an empty band and leaves
 * people scrolling to find their own records.
 */

const DAY_MS = 86_400_000;

export function TimelineView({
  fields,
  records,
  startFieldId,
  endFieldId,
  showDependencyNote,
  onOpenRecord,
}: {
  fields: readonly Field[];
  records: readonly RecordRow[];
  startFieldId: string;
  endFieldId?: string;
  showDependencyNote?: boolean;
  onOpenRecord?: (recordId: string) => void;
}) {
  const primaryField = fields.find((field) => field.isPrimary) ?? fields[0];

  const { bars, undated, min, span } = useMemo(() => {
    const parsed: Array<{ record: RecordRow; start: number; end: number }> = [];
    const without: RecordRow[] = [];

    for (const record of records) {
      const startRaw = record.fields[startFieldId];
      const start = typeof startRaw === 'string' ? Date.parse(startRaw) : NaN;

      if (Number.isNaN(start)) {
        without.push(record);
        continue;
      }

      const endRaw = endFieldId ? record.fields[endFieldId] : null;
      const parsedEnd = typeof endRaw === 'string' ? Date.parse(endRaw) : NaN;
      // A record with a start and no end is a point in time, drawn as one day rather than
      // dropped — "started, not finished" is a real and common state.
      const end = Number.isNaN(parsedEnd) || parsedEnd < start ? start + DAY_MS : parsedEnd;

      parsed.push({ record, start, end });
    }

    if (parsed.length === 0) {
      return { bars: parsed, undated: without, min: Date.now(), span: DAY_MS * 30 };
    }

    const earliest = Math.min(...parsed.map((bar) => bar.start));
    const latest = Math.max(...parsed.map((bar) => bar.end));
    // A little padding either side so the first and last bars are not flush against the edge.
    const padding = Math.max((latest - earliest) * 0.05, DAY_MS);

    return {
      bars: parsed.sort((a, b) => a.start - b.start),
      undated: without,
      min: earliest - padding,
      span: latest - earliest + padding * 2,
    };
  }, [records, startFieldId, endFieldId]);

  const ticks = useMemo(() => {
    const out: Array<{ at: number; label: string }> = [];
    const start = new Date(min);
    const cursor = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), 1));

    // Month boundaries. Finer ticks on a multi-year span produce an unreadable ruler.
    while (cursor.getTime() < min + span) {
      if (cursor.getTime() >= min) {
        out.push({
          at: cursor.getTime(),
          label: cursor.toLocaleString('en', { month: 'short', year: '2-digit', timeZone: 'UTC' }),
        });
      }
      cursor.setUTCMonth(cursor.getUTCMonth() + 1);
    }
    return out;
  }, [min, span]);

  const percent = (at: number) => ((at - min) / span) * 100;

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center gap-3 border-b border-line px-3 py-1.5 text-xs text-tertiary">
        {showDependencyNote && (
          <span>Dependencies are not drawn yet; this renders as a timeline.</span>
        )}
        {undated.length > 0 && <span className="ml-auto">{undated.length} without a start date</span>}
      </div>

      <div className="relative border-b border-line" style={{ height: 24 }}>
        {ticks.map((tick) => (
          <span
            key={tick.at}
            className="absolute top-1 -translate-x-1/2 text-2xs text-tertiary"
            style={{ left: `${percent(tick.at)}%` }}
          >
            {tick.label}
          </span>
        ))}
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        {bars.map(({ record, start, end }) => (
          <div key={record.id} className="relative h-8 border-b border-line">
            {ticks.map((tick) => (
              <span
                key={tick.at}
                aria-hidden="true"
                className="absolute inset-y-0 w-px bg-line"
                style={{ left: `${percent(tick.at)}%` }}
              />
            ))}

            <button
              type="button"
              onClick={() => onOpenRecord?.(record.id)}
              title={primaryField ? String(record.fields[primaryField.id] ?? '') : ''}
              className={cn(
                'absolute top-1 h-6 truncate rounded bg-accent-subtle px-2 text-left text-xs text-accent-text',
                'hover:bg-accent hover:text-inverted',
              )}
              style={{
                left: `${percent(start)}%`,
                // A minimum width so a single-day bar is still clickable on a year-long axis.
                width: `max(${((end - start) / span) * 100}%, 1.5rem)`,
              }}
            >
              {primaryField ? String(record.fields[primaryField.id] ?? 'Untitled') : 'Untitled'}
            </button>
          </div>
        ))}

        {bars.length === 0 && (
          <p className="p-6 text-center text-sm text-secondary">
            No records have a date in this field.
          </p>
        )}
      </div>
    </div>
  );
}

/**
 * The chart view.
 *
 * Bars drawn with plain elements rather than a charting library: the page ships under a strict
 * CSP with no external scripts, and a bar chart of a grouped count is a few divs. A library would
 * buy interactivity nobody asked for at the cost of a dependency that cannot load.
 */
export function ChartView({
  fields,
  records,
  xFieldId,
}: {
  fields: readonly Field[];
  records: readonly RecordRow[];
  xFieldId: string;
}) {
  const xField = fields.find((field) => field.id === xFieldId);

  const buckets = useMemo(() => {
    const counts = new Map<string, number>();

    for (const record of records) {
      const value = record.fields[xFieldId];
      // Blank is its own bucket rather than being skipped: "how many have no category" is
      // usually the most interesting bar on the chart.
      const key =
        value === null || value === undefined || value === '' ? '(blank)' : String(value);
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }

    return [...counts.entries()]
      .map(([label, count]) => ({ label, count }))
      .sort((a, b) => b.count - a.count);
  }, [records, xFieldId]);

  const max = Math.max(1, ...buckets.map((bucket) => bucket.count));

  if (!xField) {
    return <div className="p-6 text-sm text-secondary">This chart is built on a field that is gone.</div>;
  }

  return (
    <div className="h-full overflow-y-auto p-4">
      <p className="mb-3 text-sm text-secondary">
        Records by <span className="font-medium text-primary">{xField.name}</span>
      </p>

      <div className="space-y-1.5">
        {buckets.map((bucket) => (
          <div key={bucket.label} className="flex items-center gap-2 text-sm">
            <span className="w-40 shrink-0 truncate text-right text-secondary">{bucket.label}</span>
            <div className="h-5 flex-1 rounded bg-sunken">
              <div
                className="h-full rounded bg-accent"
                style={{ width: `${(bucket.count / max) * 100}%` }}
              />
            </div>
            <span className="w-10 shrink-0 tabular-nums text-tertiary">{bucket.count}</span>
          </div>
        ))}
      </div>

      {buckets.length === 0 && <p className="text-sm text-secondary">No records to chart.</p>}
    </div>
  );
}

'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';

import { Button } from '@/components/ui/button';
import { LoadingState } from '@/components/ui/feedback';
import { apiRequest } from '@/lib/api-client';
import { cn } from '@/lib/cn';

import { dataApi, type Field } from '../data/api';

/**
 * Interfaces — the per-base dashboard designer.
 *
 * A dashboard is a list of widgets over the base's real data: stat tiles (count / sum / average),
 * bar charts (records grouped by a field's value), and record-list tiles. The layout is stored on
 * the base (one JSON blob, PUT on every change); the numbers are computed here from the ordinary
 * records API, so a dashboard can never disagree with the grid.
 */

export interface Widget {
  id: string;
  type: 'stat' | 'chart' | 'table';
  title: string;
  tableId: string;
  /** stat */
  agg?: 'count' | 'sum' | 'avg';
  fieldId?: string;
  /** chart */
  groupFieldId?: string;
}

const NUMERIC_TYPES = new Set(['number', 'decimal', 'currency', 'percent', 'rating', 'duration', 'rollup', 'count']);
const GROUPABLE_TYPES = new Set(['singleSelect', 'status', 'checkbox', 'singleLineText', 'email', 'user']);

async function fetchInterfaces(baseId: string): Promise<{ widgets: Widget[] }> {
  const result = await apiRequest<{ data: { widgets: Widget[] } }>(`/v1/bases/${baseId}/interfaces`);
  return result.data;
}

async function saveInterfaces(baseId: string, widgets: Widget[]): Promise<void> {
  await apiRequest(`/v1/bases/${baseId}/interfaces`, { method: 'PUT', body: { widgets } });
}

export function InterfacesSection({
  baseId,
  tables,
}: {
  baseId: string;
  tables: Array<{ id: string; name: string }>;
}) {
  const queryClient = useQueryClient();
  const [adding, setAdding] = useState(false);

  const config = useQuery({
    queryKey: ['interfaces', baseId],
    queryFn: () => fetchInterfaces(baseId),
  });

  const save = useMutation({
    mutationFn: (widgets: Widget[]) => saveInterfaces(baseId, widgets),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ['interfaces', baseId] }),
  });

  if (config.isPending) return <LoadingState label="Loading interfaces" />;

  const widgets = config.data?.widgets ?? [];

  return (
    <div className="p-4">
      <div className="mb-4 flex items-center justify-between">
        <div>
          <h2 className="text-sm font-semibold text-primary">Dashboard</h2>
          <p className="text-xs text-tertiary">
            Live numbers from this base — every tile recomputes from the records themselves.
          </p>
        </div>
        <Button size="sm" variant="primary" onClick={() => setAdding(true)} disabled={tables.length === 0}>
          + Add widget
        </Button>
      </div>

      {adding && (
        <WidgetForm
          tables={tables}
          onCancel={() => setAdding(false)}
          onAdd={(widget) => {
            save.mutate([...widgets, widget]);
            setAdding(false);
          }}
        />
      )}

      {widgets.length === 0 && !adding && (
        <div className="mx-auto max-w-md px-6 py-12 text-center">
          <p className="text-sm font-medium text-primary">No widgets yet</p>
          <p className="mt-1 text-sm text-secondary">
            Add a stat tile ("289 patients", "total revenue"), a bar chart by any field, or a
            recent-records list. Everything renders from live data.
          </p>
        </div>
      )}

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {widgets.map((widget) => (
          <WidgetCard
            key={widget.id}
            widget={widget}
            tableName={tables.find((table) => table.id === widget.tableId)?.name ?? 'Table'}
            onRemove={() => save.mutate(widgets.filter((item) => item.id !== widget.id))}
          />
        ))}
      </div>
    </div>
  );
}

/** The add-widget form: type → table → the per-type pickers. */
function WidgetForm({
  tables,
  onAdd,
  onCancel,
}: {
  tables: Array<{ id: string; name: string }>;
  onAdd: (widget: Widget) => void;
  onCancel: () => void;
}) {
  const [type, setType] = useState<Widget['type']>('stat');
  const [title, setTitle] = useState('');
  const [tableId, setTableId] = useState(tables[0]?.id ?? '');
  const [agg, setAgg] = useState<'count' | 'sum' | 'avg'>('count');
  const [fieldId, setFieldId] = useState('');
  const [groupFieldId, setGroupFieldId] = useState('');

  const fields = useQuery({
    queryKey: ['fields', tableId],
    queryFn: () => dataApi.listFields(tableId),
    enabled: tableId !== '',
  });
  const numericFields = (fields.data ?? []).filter((field) => NUMERIC_TYPES.has(field.type));
  const groupableFields = (fields.data ?? []).filter((field) => GROUPABLE_TYPES.has(field.type));

  const incomplete =
    !tableId ||
    (type === 'stat' && agg !== 'count' && !fieldId) ||
    (type === 'chart' && !groupFieldId);

  return (
    <form
      className="mb-4 flex flex-wrap items-end gap-2 rounded-md border border-line bg-sunken p-3"
      onSubmit={(event) => {
        event.preventDefault();
        if (incomplete) return;
        onAdd({
          id: `wgt_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`,
          type,
          title: title.trim(),
          tableId,
          ...(type === 'stat' ? { agg, ...(agg !== 'count' ? { fieldId } : {}) } : {}),
          ...(type === 'chart' ? { groupFieldId } : {}),
        });
      }}
    >
      <label className="flex flex-col gap-1">
        <span className="text-xs font-medium text-secondary">Widget</span>
        <select
          value={type}
          onChange={(event) => setType(event.target.value as Widget['type'])}
          aria-label="Widget type"
          className="h-8 rounded border border-line bg-surface px-2 text-sm text-primary"
        >
          <option value="stat">Stat tile</option>
          <option value="chart">Bar chart</option>
          <option value="table">Recent records</option>
        </select>
      </label>

      <label className="flex flex-col gap-1">
        <span className="text-xs font-medium text-secondary">Title (optional)</span>
        <input
          value={title}
          onChange={(event) => setTitle(event.target.value)}
          placeholder="e.g. Total revenue"
          className="h-8 w-44 rounded border border-line bg-surface px-2 text-sm text-primary"
        />
      </label>

      <label className="flex flex-col gap-1">
        <span className="text-xs font-medium text-secondary">Table</span>
        <select
          value={tableId}
          onChange={(event) => {
            setTableId(event.target.value);
            setFieldId('');
            setGroupFieldId('');
          }}
          aria-label="Widget table"
          className="h-8 rounded border border-line bg-surface px-2 text-sm text-primary"
        >
          {tables.map((table) => (
            <option key={table.id} value={table.id}>
              {table.name}
            </option>
          ))}
        </select>
      </label>

      {type === 'stat' && (
        <>
          <label className="flex flex-col gap-1">
            <span className="text-xs font-medium text-secondary">Show</span>
            <select
              value={agg}
              onChange={(event) => setAgg(event.target.value as 'count' | 'sum' | 'avg')}
              aria-label="Stat aggregation"
              className="h-8 rounded border border-line bg-surface px-2 text-sm text-primary"
            >
              <option value="count">Record count</option>
              <option value="sum">Sum of a field</option>
              <option value="avg">Average of a field</option>
            </select>
          </label>
          {agg !== 'count' && (
            <label className="flex flex-col gap-1">
              <span className="text-xs font-medium text-secondary">Field</span>
              <select
                value={fieldId}
                onChange={(event) => setFieldId(event.target.value)}
                aria-label="Stat field"
                className="h-8 rounded border border-line bg-surface px-2 text-sm text-primary"
              >
                <option value="">Pick a field…</option>
                {numericFields.map((field) => (
                  <option key={field.id} value={field.id}>
                    {field.name}
                  </option>
                ))}
              </select>
            </label>
          )}
        </>
      )}

      {type === 'chart' && (
        <label className="flex flex-col gap-1">
          <span className="text-xs font-medium text-secondary">Group by</span>
          <select
            value={groupFieldId}
            onChange={(event) => setGroupFieldId(event.target.value)}
            aria-label="Chart group field"
            className="h-8 rounded border border-line bg-surface px-2 text-sm text-primary"
          >
            <option value="">Pick a field…</option>
            {groupableFields.map((field) => (
              <option key={field.id} value={field.id}>
                {field.name}
              </option>
            ))}
          </select>
        </label>
      )}

      <Button type="submit" size="sm" variant="primary" disabled={incomplete}>
        Add
      </Button>
      <Button type="button" size="sm" variant="ghost" onClick={onCancel}>
        Cancel
      </Button>
    </form>
  );
}

/** One widget: loads its records and renders by type. */
function WidgetCard({
  widget,
  tableName,
  onRemove,
}: {
  widget: Widget;
  tableName: string;
  onRemove: () => void;
}) {
  const records = useQuery({
    queryKey: ['iface-records', widget.tableId],
    queryFn: () => dataApi.queryRecords(widget.tableId, { limit: 1000 }),
    // Dashboards stay live the same way the grid does.
    refetchInterval: 60_000,
  });
  const fields = useQuery({
    queryKey: ['fields', widget.tableId],
    queryFn: () => dataApi.listFields(widget.tableId),
  });

  const rows = records.data?.data ?? [];
  const title = widget.title || defaultTitle(widget, fields.data ?? [], tableName);

  return (
    <div
      className={cn(
        'rounded-md border border-line bg-surface p-4',
        widget.type === 'table' && 'sm:col-span-2',
      )}
    >
      <div className="mb-2 flex items-start justify-between gap-2">
        <div className="min-w-0">
          <h3 className="truncate text-xs font-semibold uppercase tracking-wide text-tertiary">{title}</h3>
          <p className="text-2xs text-tertiary">{tableName}</p>
        </div>
        <button
          type="button"
          aria-label={`Remove widget ${title}`}
          onClick={onRemove}
          className="shrink-0 rounded px-1.5 py-0.5 text-xs text-tertiary hover:bg-sunken hover:text-danger-text"
        >
          ✕
        </button>
      </div>

      {records.isPending ? (
        <p className="text-sm text-tertiary">Loading…</p>
      ) : widget.type === 'stat' ? (
        <StatBody widget={widget} rows={rows} fields={fields.data ?? []} />
      ) : widget.type === 'chart' ? (
        <ChartBody widget={widget} rows={rows} />
      ) : (
        <TableBody rows={rows} fields={fields.data ?? []} />
      )}
    </div>
  );
}

function defaultTitle(widget: Widget, fields: Field[], tableName: string): string {
  if (widget.type === 'stat') {
    const fieldName = fields.find((field) => field.id === widget.fieldId)?.name ?? '';
    return widget.agg === 'count' ? `${tableName} count` : `${widget.agg === 'avg' ? 'Average' : 'Total'} ${fieldName}`;
  }
  if (widget.type === 'chart') {
    return `By ${fields.find((field) => field.id === widget.groupFieldId)?.name ?? 'field'}`;
  }
  return `Recent ${tableName}`;
}

function StatBody({
  widget,
  rows,
  fields,
}: {
  widget: Widget;
  rows: ReadonlyArray<{ fields: Record<string, unknown> }>;
  fields: Field[];
}) {
  let value: string;
  if (widget.agg === 'count' || !widget.fieldId) {
    value = String(rows.length);
  } else {
    const numbers = rows
      .map((row) => {
        const raw = row.fields[widget.fieldId as string];
        return typeof raw === 'number' ? raw : typeof raw === 'string' && raw.trim() !== '' ? Number(raw) : NaN;
      })
      .filter((n) => !Number.isNaN(n));
    const sum = numbers.reduce((total, n) => total + n, 0);
    const result = widget.agg === 'avg' ? (numbers.length ? sum / numbers.length : 0) : sum;
    const isCurrency = fields.find((field) => field.id === widget.fieldId)?.type === 'currency';
    value =
      (isCurrency ? '$' : '') +
      result.toLocaleString(undefined, { maximumFractionDigits: 2, ...(isCurrency ? { minimumFractionDigits: 2 } : {}) });
  }

  return <p className="text-3xl font-bold tabular-nums text-primary">{value}</p>;
}

/** A dependency-free bar chart: counts per value, widths proportional to the leader. */
function ChartBody({
  widget,
  rows,
}: {
  widget: Widget;
  rows: ReadonlyArray<{ fields: Record<string, unknown> }>;
}) {
  const counts = new Map<string, number>();
  for (const row of rows) {
    const raw = widget.groupFieldId ? row.fields[widget.groupFieldId] : null;
    const key =
      raw === null || raw === undefined || raw === ''
        ? '(empty)'
        : typeof raw === 'boolean'
          ? raw
            ? 'Checked'
            : 'Unchecked'
          : String(raw);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  const top = [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8);
  const max = top[0]?.[1] ?? 1;

  if (top.length === 0) return <p className="text-sm text-tertiary">No records.</p>;

  return (
    <ul className="space-y-1.5">
      {top.map(([label, count]) => (
        <li key={label} className="flex items-center gap-2">
          <span className="w-28 shrink-0 truncate text-xs text-secondary" title={label}>
            {label}
          </span>
          <span className="h-4 min-w-[2px] rounded-sm bg-accent" style={{ width: `${(count / max) * 100}%` }} />
          <span className="shrink-0 text-xs tabular-nums text-tertiary">{count}</span>
        </li>
      ))}
    </ul>
  );
}

function TableBody({
  rows,
  fields,
}: {
  rows: ReadonlyArray<{ id?: string; fields: Record<string, unknown> }>;
  fields: Field[];
}) {
  const shown = fields.slice(0, 4);
  const recent = rows.slice(0, 6);

  if (recent.length === 0) return <p className="text-sm text-tertiary">No records.</p>;

  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr>
            {shown.map((field) => (
              <th key={field.id} className="border-b border-line pb-1 pr-3 text-left text-xs font-medium text-tertiary">
                {field.name}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {recent.map((row, index) => (
            <tr key={row.id ?? index}>
              {shown.map((field) => (
                <td key={field.id} className="max-w-40 truncate border-b border-line py-1 pr-3 text-primary">
                  {plainText(row.fields[field.id])}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function plainText(value: unknown): string {
  if (value === null || value === undefined || value === '') return '';
  if (typeof value === 'boolean') return value ? '✓' : '';
  if (Array.isArray(value)) {
    return value
      .map((item) =>
        item && typeof item === 'object'
          ? String((item as { label?: unknown; filename?: unknown }).label ?? (item as { filename?: unknown }).filename ?? '')
          : String(item),
      )
      .filter(Boolean)
      .join(', ');
  }
  if (typeof value === 'object') return '…';
  return String(value);
}

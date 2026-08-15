'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { Suspense, useEffect, useState } from 'react';

import { Button } from '@/components/ui/button';
import { Alert, ErrorState, LoadingState } from '@/components/ui/feedback';
import { BaseTabs, type BaseSection } from '@/features/base/base-tabs';
import { AutomationsSection, FormsSection, InterfacesSection } from '@/features/base/sections';
import { TableMenu } from '@/features/base/table-menu';
import { dataApi } from '@/features/data/api';
import { GridView } from '@/features/grid/grid-view';
import { ApiError } from '@/lib/api-client';
import { cn } from '@/lib/cn';

const FIELD_TYPES = [
  { value: 'singleLineText', label: 'Single line text' },
  { value: 'longText', label: 'Long text' },
  { value: 'number', label: 'Number' },
  { value: 'decimal', label: 'Decimal' },
  { value: 'currency', label: 'Currency' },
  { value: 'percent', label: 'Percent' },
  { value: 'checkbox', label: 'Checkbox' },
  { value: 'singleSelect', label: 'Single select' },
  { value: 'multipleSelect', label: 'Multiple select' },
  { value: 'date', label: 'Date' },
  { value: 'dateTime', label: 'Date and time' },
  { value: 'email', label: 'Email' },
  { value: 'url', label: 'URL' },
  { value: 'phone', label: 'Phone' },
  { value: 'rating', label: 'Rating' },
] as const;

/**
 * A base: its tables as tabs, and the selected table's grid.
 *
 * The grid takes the whole remaining viewport height rather than growing with the content — a
 * data grid that pushes the page taller cannot have a sticky header or its own scroll context,
 * and both are load-bearing.
 */
export default function BasePage() {
  return (
    <Suspense fallback={null}>
      <BasePageInner />
    </Suspense>
  );
}

function BasePageInner() {
  const searchParams = useSearchParams();
  const orgSlug = searchParams.get('org') ?? '';
  const baseId = searchParams.get('base') ?? '';
  const queryClient = useQueryClient();
  const [activeTableId, setActiveTableId] = useState<string | null>(null);
  const [addingField, setAddingField] = useState(false);
  const [section, setSection] = useState<BaseSection>('data');
  const [tableMenuFor, setTableMenuFor] = useState<string | null>(null);

  const base = useQuery({
    queryKey: ['base', baseId],
    queryFn: () => dataApi.getBase(baseId),
  });

  const tables = useQuery({
    queryKey: ['tables', baseId],
    queryFn: () => dataApi.listTables(baseId),
  });

  // Selects the first table once they load, so the page is never a blank frame.
  useEffect(() => {
    if (!activeTableId && tables.data?.length) setActiveTableId(tables.data[0]?.id ?? null);
  }, [tables.data, activeTableId]);

  const createTable = useMutation({
    mutationFn: () => dataApi.createTable(baseId, `Table ${(tables.data?.length ?? 0) + 1}`),
    onSuccess: async (created) => {
      await queryClient.invalidateQueries({ queryKey: ['tables', baseId] });
      setActiveTableId(created.id);
    },
  });

  const createField = useMutation({
    mutationFn: (input: { name: string; type: string; options?: Record<string, unknown> }) =>
      dataApi.createField(activeTableId as string, input),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['fields', activeTableId] });
      await queryClient.invalidateQueries({ queryKey: ['records', activeTableId] });
      setAddingField(false);
    },
  });

  if (base.isPending || tables.isPending) {
    return (
      <main id="main" className="mx-auto max-w-5xl px-6 py-10">
        <LoadingState label="Loading base" />
      </main>
    );
  }

  if (base.isError || tables.isError) {
    const error = base.error ?? tables.error;
    return (
      <main id="main" className="mx-auto max-w-5xl px-6 py-10">
        <ErrorState
          message={error instanceof ApiError ? error.message : 'Could not load this base.'}
          {...(error instanceof ApiError ? { requestId: error.requestId } : {})}
        />
      </main>
    );
  }

  const activeTable = tables.data?.find((table) => table.id === activeTableId);

  return (
    // Pinned below the 3rem app header: the page body then can never scroll — only the grid
    // does — so the base header, tabs and toolbar hold still exactly like Airtable's.
    <main id="main" className="fixed inset-x-0 bottom-0 top-12 flex flex-col overflow-hidden">
      {/* One slim header row, Airtable-style: back-link + base name on the left, the base's
          sections beside it. A stacked breadcrumb + title + tab rows ate three lines of grid. */}
      <div className="flex shrink-0 items-center gap-4 border-b border-line px-4 py-1.5">
        <nav aria-label="Breadcrumb" className="flex min-w-0 items-center gap-2 text-sm">
          <Link
            href={`/app/w?org=${orgSlug}&ws=${base.data?.workspaceId}`}
            className="shrink-0 text-secondary hover:text-primary"
            aria-label="Back to bases"
          >
            ‹
          </Link>
          <h1 className="truncate text-base font-semibold tracking-tight text-primary">
            {base.data?.name}
          </h1>
        </nav>
        <BaseTabs active={section} onChange={setSection} />
      </div>

      {section !== 'data' ? (
        <div className="min-h-0 flex-1 overflow-auto">
          {section === 'automations' && <AutomationsSection baseId={baseId} />}
          {section === 'forms' && (
            <FormsSection tables={(tables.data ?? []).map((t) => ({ id: t.id, name: t.name }))} />
          )}
          {section === 'interfaces' && <InterfacesSection />}
        </div>
      ) : (
        <>
      {/* Table tabs — Airtable's strip: a tinted band where the active table reads as a white
          card fused to the grid below, and long tab lists scroll sideways instead of wrapping
          into a second row that pushes the grid down. */}
      <div className="flex items-end gap-1 bg-sunken px-3 pt-1.5">
        <div
          role="tablist"
          aria-label="Tables"
          className="flex min-w-0 items-end gap-0.5 overflow-x-auto"
        >
          {tables.data?.map((table) => (
            <div key={table.id} className="relative shrink-0">
              <button
                role="tab"
                aria-selected={table.id === activeTableId}
                onClick={() => {
                  // Airtable's gesture: first click selects the table, a click on the
                  // already-active tab opens its menu. Opening only (never toggling closed)
                  // means a double-click still leaves the menu open instead of flashing it.
                  if (table.id === activeTableId) {
                    setTableMenuFor(table.id);
                  } else {
                    setActiveTableId(table.id);
                    setTableMenuFor(null);
                  }
                }}
                className={cn(
                  'whitespace-nowrap rounded-t-md border border-b-0 px-3 py-1.5 text-sm transition-colors duration-fast',
                  table.id === activeTableId
                    ? 'border-line bg-surface font-medium text-primary'
                    : 'border-transparent text-secondary hover:bg-surface/60 hover:text-primary',
                )}
              >
                {table.name}
                {table.id === activeTableId && (
                  <span aria-hidden="true" className="ml-1.5 text-xs text-tertiary">
                    ▾
                  </span>
                )}
              </button>
              {tableMenuFor === table.id && (
                <TableMenu
                  tableId={table.id}
                  tableName={table.name}
                  baseId={baseId}
                  onDeleted={() => setActiveTableId(null)}
                  onClose={() => setTableMenuFor(null)}
                />
              )}
            </div>
          ))}
        </div>
        <Button
          size="sm"
          variant="ghost"
          onClick={() => createTable.mutate()}
          loading={createTable.isPending}
          aria-label="Add table"
          className="shrink-0"
        >
          +
        </Button>

        <div className="ml-auto shrink-0 pb-1">
          <Button size="sm" variant="secondary" onClick={() => setAddingField((v) => !v)}>
            Add field
          </Button>
        </div>
      </div>

      {addingField && activeTableId && (
        <AddFieldRow
          pending={createField.isPending}
          error={createField.error}
          onCancel={() => setAddingField(false)}
          onSubmit={(input) => createField.mutate(input)}
        />
      )}

      <div className="min-h-0 flex-1">
        {activeTable ? (
          <GridView
            key={activeTable.id}
            tableId={activeTable.id}
            tableName={activeTable.name}
            baseId={activeTable.baseId}
          />
        ) : (
          <div className="p-6 text-sm text-secondary">This base has no tables yet.</div>
        )}
      </div>
        </>
      )}
    </main>
  );
}

function AddFieldRow({
  pending,
  error,
  onCancel,
  onSubmit,
}: {
  pending: boolean;
  error: unknown;
  onCancel: () => void;
  onSubmit: (input: { name: string; type: string; options?: Record<string, unknown> }) => void;
}) {
  const [name, setName] = useState('');
  const [type, setType] = useState<string>('singleLineText');

  return (
    <div className="border-b border-line bg-sunken px-4 py-3">
      {error instanceof ApiError && (
        <Alert tone="danger" className="mb-3">
          {error.message}
        </Alert>
      )}

      <form
        className="flex flex-wrap items-end gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          if (!name.trim()) return;
          onSubmit({
            name: name.trim(),
            type,
            // Select fields need at least one option or they cannot hold a value; seeding two
            // sensible defaults is friendlier than an empty dropdown the user must go and fix.
            ...(type === 'singleSelect' || type === 'multipleSelect'
              ? {
                  options: {
                    choices: [
                      { id: 'option_a', label: 'Option A', position: 0, color: '#0d7377' },
                      { id: 'option_b', label: 'Option B', position: 1, color: '#b46a0c' },
                    ],
                  },
                }
              : {}),
          });
          setName('');
        }}
      >
        <label className="flex flex-col gap-1">
          <span className="text-xs font-medium text-secondary">Field name</span>
          <input
            autoFocus
            value={name}
            onChange={(event) => setName(event.target.value)}
            className="h-8 w-56 rounded border border-line bg-surface px-2 text-sm text-primary"
          />
        </label>

        <label className="flex flex-col gap-1">
          <span className="text-xs font-medium text-secondary">Type</span>
          <select
            value={type}
            onChange={(event) => setType(event.target.value)}
            className="h-8 rounded border border-line bg-surface px-2 text-sm text-primary"
          >
            {FIELD_TYPES.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </label>

        <Button type="submit" size="sm" variant="primary" loading={pending} disabled={!name.trim()}>
          Add
        </Button>
        <Button type="button" size="sm" variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
      </form>
    </div>
  );
}

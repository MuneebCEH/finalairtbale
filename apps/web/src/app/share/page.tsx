'use client';

import { useQuery } from '@tanstack/react-query';
import { useSearchParams } from 'next/navigation';
import { Suspense } from 'react';

import { dataApi } from '@/features/data/api';

/**
 * The public face of a share link: /share/?s=<slug>. No login, no chrome — a clean read-only
 * table, the way Airtable's shared views look to someone outside the workspace. The slug alone
 * authorizes the read; a revoked or mistyped slug gets a friendly dead-end, never a login wall.
 */
export default function SharePage() {
  return (
    <Suspense fallback={null}>
      <ShareInner />
    </Suspense>
  );
}

function ShareInner() {
  const params = useSearchParams();
  const slug = params.get('s') ?? '';

  const shared = useQuery({
    queryKey: ['shared', slug],
    queryFn: () => dataApi.getSharedView(slug),
    enabled: slug !== '',
    retry: false,
    // A share link left open in a tab keeps itself fresh.
    refetchInterval: 60_000,
  });

  if (!slug || shared.isError) {
    return (
      <main className="flex min-h-screen items-center justify-center bg-sunken p-6">
        <div className="max-w-md rounded-lg border border-line bg-surface p-8 text-center">
          <p aria-hidden="true" className="text-3xl">🔗</p>
          <h1 className="mt-3 text-lg font-semibold text-primary">This link is not available</h1>
          <p className="mt-2 text-sm text-secondary">
            The share link is invalid or its owner has stopped sharing this view.
          </p>
        </div>
      </main>
    );
  }

  if (shared.isPending) {
    return (
      <main className="flex min-h-screen items-center justify-center bg-sunken">
        <p className="text-sm text-tertiary">Loading shared view…</p>
      </main>
    );
  }

  const { view, table, fields, records, truncated } = shared.data;

  return (
    <main className="flex min-h-screen flex-col bg-sunken">
      <header className="flex items-center gap-3 border-b border-line bg-surface px-4 py-3">
        <span
          aria-hidden="true"
          className="flex h-8 w-8 items-center justify-center rounded bg-accent text-sm font-bold text-inverted"
        >
          {table.name.slice(0, 1).toUpperCase()}
        </span>
        <div className="min-w-0">
          <h1 className="truncate text-sm font-semibold text-primary">{table.name}</h1>
          <p className="truncate text-xs text-tertiary">
            {view.name} · shared view · {records.length} record{records.length === 1 ? '' : 's'}
            {truncated ? ' (first 1000)' : ''}
          </p>
        </div>
        <span className="ml-auto shrink-0 rounded bg-sunken px-2 py-1 text-2xs font-medium uppercase tracking-wide text-tertiary">
          Read only
        </span>
      </header>

      <div className="min-h-0 flex-1 overflow-auto p-4">
        <table className="w-full min-w-max border-collapse overflow-hidden rounded-md bg-surface text-sm">
          <thead>
            <tr>
              {fields.map((field) => (
                <th
                  key={field.id}
                  className="sticky top-0 border border-line bg-sunken px-3 py-2 text-left text-xs font-semibold text-secondary"
                >
                  {field.name}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {records.map((record) => (
              <tr key={record.id} className="hover:bg-sunken/50">
                {fields.map((field) => (
                  <td key={field.id} className="max-w-xs truncate border border-line px-3 py-1.5 text-primary">
                    {cellText(record.fields[field.id], field.type)}
                  </td>
                ))}
              </tr>
            ))}
            {records.length === 0 && (
              <tr>
                <td colSpan={fields.length} className="border border-line px-3 py-8 text-center text-tertiary">
                  No records in this view.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      <footer className="border-t border-line bg-surface px-4 py-2 text-center text-2xs text-tertiary">
        Powered by Tessera
      </footer>
    </main>
  );
}

/** Flatten any cell value to display text; structures summarise rather than dump JSON. */
function cellText(value: unknown, type: string): string {
  if (value === null || value === undefined || value === '') return '';
  if (type === 'checkbox') return value ? '✓' : '';
  if (Array.isArray(value)) {
    return value
      .map((item) =>
        item && typeof item === 'object'
          ? String(
              (item as { label?: unknown; filename?: unknown }).label ??
                (item as { filename?: unknown }).filename ??
                '',
            )
          : String(item),
      )
      .filter(Boolean)
      .join(', ');
  }
  if (typeof value === 'object') return '…';
  return String(value);
}

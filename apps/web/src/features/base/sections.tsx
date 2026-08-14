'use client';

import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';

import { LoadingState } from '@/components/ui/feedback';
import { apiPost, apiRequest } from '@/lib/api-client';

import { FormBuilder } from './form-builder';

/**
 * The Automations, Interfaces and Forms sections.
 *
 * Each lists what the base holds and says plainly when it holds nothing. An empty section that
 * renders as a blank panel is indistinguishable from one that failed to load, so every empty
 * state here says what the thing is and what would put something in it.
 */

interface AutomationSummary {
  id: string;
  name: string;
  enabled: boolean;
  isLive: boolean;
  latestVersion: { version: number; status: string } | null;
  updatedAt: string;
}

interface FormSummary {
  id: string;
  name: string;
  title: string;
  slug: string;
  isPublished: boolean;
  submissionCount: number;
}

export function AutomationsSection({ baseId }: { baseId: string }) {
  const query = useQuery({
    queryKey: ['automations', baseId],
    queryFn: () => apiRequest<{ data: AutomationSummary[] }>(`/v1/bases/${baseId}/automations`),
  });

  if (query.isPending) return <LoadingState label="Loading automations" />;

  const automations = query.data?.data ?? [];

  if (automations.length === 0) {
    return (
      <Empty
        title="No automations yet"
        body="An automation watches for something happening in this base — a record created, a field changed, a form submitted — and runs steps in response."
      />
    );
  }

  return (
    <ul className="divide-y divide-line">
      {automations.map((automation) => (
        <li key={automation.id} className="flex items-center gap-3 px-4 py-3">
          <div className="min-w-0 flex-1">
            <p className="truncate text-sm font-medium text-primary">{automation.name}</p>
            <p className="text-xs text-tertiary">
              {automation.latestVersion
                ? `Version ${automation.latestVersion.version} · ${automation.latestVersion.status}`
                : 'No version yet'}
            </p>
          </div>

          {/* `enabled` alone is misleading — an automation can be enabled and still not run
              because nothing is published, so the badge reports the combined truth. */}
          <span
            className={
              automation.isLive
                ? 'rounded-full bg-success-subtle px-2 py-0.5 text-2xs text-success-text'
                : 'rounded-full bg-sunken px-2 py-0.5 text-2xs text-tertiary'
            }
          >
            {automation.isLive ? 'Live' : automation.enabled ? 'Not published' : 'Off'}
          </span>
        </li>
      ))}
    </ul>
  );
}

export function FormsSection({ tables }: { tables: { id: string; name: string }[] }) {
  const tableIds = tables.map((t) => t.id);
  const [openForm, setOpenForm] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);

  const query = useQuery({
    queryKey: ['forms', tableIds],
    queryFn: async () => {
      // Forms belong to a table, so the base's list is the union across its tables.
      const perTable = await Promise.all(
        tableIds.map((tableId) =>
          apiRequest<{ data: FormSummary[] }>(`/v1/tables/${tableId}/forms`).catch(() => ({
            data: [] as FormSummary[],
          })),
        ),
      );
      return perTable.flatMap((result) => result.data);
    },
    enabled: tableIds.length > 0,
  });

  const create = async (tableId: string) => {
    setCreating(true);
    try {
      const result = await apiPost<{ id: string }>(`/v1/tables/${tableId}/forms`, {});
      await query.refetch();
      setOpenForm(result.id);
    } finally {
      setCreating(false);
    }
  };

  if (openForm) {
    return (
      <FormBuilder
        formId={openForm}
        onClose={() => setOpenForm(null)}
        onChanged={() => void query.refetch()}
      />
    );
  }

  if (query.isPending) return <LoadingState label="Loading forms" />;

  const forms = query.data ?? [];

  return (
    <div>
      <div className="flex items-center justify-between border-b border-line px-4 py-3">
        <h2 className="text-sm font-medium text-secondary">Forms</h2>
        {/* One table: a plain button. Several: a small picker so the form knows where to write. */}
        {tables.length === 1 ? (
          <button
            onClick={() => create(tables[0]!.id)}
            disabled={creating}
            className="rounded bg-accent px-2.5 py-1 text-xs font-medium text-inverted disabled:opacity-60"
          >
            New form
          </button>
        ) : (
          <select
            value=""
            disabled={creating}
            onChange={(e) => e.target.value && create(e.target.value)}
            className="rounded border border-line bg-surface px-2 py-1 text-xs"
          >
            <option value="">+ New form for…</option>
            {tables.map((t) => (
              <option key={t.id} value={t.id}>
                {t.name}
              </option>
            ))}
          </select>
        )}
      </div>

      {forms.length === 0 ? (
        <Empty
          title="No forms yet"
          body="A form is a public page that writes into one of this base's tables. It only ever accepts the fields you put on it."
        />
      ) : (
        <ul className="divide-y divide-line">
          {forms.map((form) => (
            <li key={form.id}>
              <button
                onClick={() => setOpenForm(form.id)}
                className="flex w-full items-center gap-3 px-4 py-3 text-left hover:bg-sunken"
              >
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium text-primary">{form.title}</p>
                  <p className="text-xs text-tertiary">
                    {form.submissionCount} {form.submissionCount === 1 ? 'response' : 'responses'}
                  </p>
                </div>
                {form.isPublished ? (
                  <span className="text-2xs text-success-text">● Live</span>
                ) : (
                  <span className="rounded-full bg-sunken px-2 py-0.5 text-2xs text-tertiary">Draft</span>
                )}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

export function InterfacesSection() {
  return (
    <Empty
      title="Interfaces are not available yet"
      body="An interface is a purpose-built page over this base's data — a dashboard, a review queue, a record detail view. This section is a placeholder: nothing here is functional yet."
    />
  );
}

/**
 * An empty state that says what the thing is.
 *
 * A blank panel is indistinguishable from a failed load, and "No items" teaches nobody what the
 * section is for.
 */
function Empty({ title, body }: { title: string; body: string }) {
  return (
    <div className="mx-auto max-w-md px-6 py-12 text-center">
      <p className="text-sm font-medium text-primary">{title}</p>
      <p className="mt-1 text-sm text-secondary">{body}</p>
    </div>
  );
}

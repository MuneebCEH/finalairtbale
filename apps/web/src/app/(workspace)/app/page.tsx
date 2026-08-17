'use client';

import { useMutation, useQueries, useQuery, useQueryClient } from '@tanstack/react-query';
import Link from 'next/link';
import { useState } from 'react';

import { Button } from '@/components/ui/button';
import { Alert, Card, EmptyState, ErrorState, LoadingState } from '@/components/ui/feedback';
import { Field } from '@/components/ui/field';
import { dataApi, type Base } from '@/features/data/api';
import { ApiError, apiGet, apiList, apiPost } from '@/lib/api-client';
import { cn } from '@/lib/cn';

interface OrganizationSummary {
  id: string;
  name: string;
  slug: string;
  logoUrl: string | null;
  plan: string;
  status: string;
  role: string;
  joinedAt: string;
}

interface Workspace {
  id: string;
  name: string;
  icon: string | null;
  color: string | null;
}

/** The tile colours Airtable-style base cards cycle through, picked stably per base. */
const TILE_COLORS = [
  'bg-teal-600',
  'bg-blue-600',
  'bg-violet-600',
  'bg-rose-500',
  'bg-amber-500',
  'bg-emerald-600',
  'bg-cyan-600',
  'bg-indigo-600',
];

function tileColor(id: string): string {
  let hash = 0;
  for (const ch of id) hash = (hash * 31 + ch.charCodeAt(0)) >>> 0;
  return TILE_COLORS[hash % TILE_COLORS.length] as string;
}

/** "Delta Medical portal" → "DM", Airtable's two-letter base monogram. */
function monogram(name: string): string {
  const words = name.trim().split(/\s+/);
  const first = words[0]?.[0] ?? '?';
  const second = words[1]?.[0] ?? words[0]?.[1] ?? '';
  return (first + second).toUpperCase();
}

/**
 * Home — the Airtable-style dashboard: workspaces down the left, and every base as a coloured
 * card in the main area, grouped by workspace. The grid pages beyond this keep their own look.
 */
export default function HomePage() {
  const queryClient = useQueryClient();
  const [creatingOrg, setCreatingOrg] = useState(false);
  const [orgSlug, setOrgSlug] = useState<string | null>(null);

  const orgs = useQuery({
    queryKey: ['organizations'],
    queryFn: () => apiGet<OrganizationSummary[]>('/v1/me/organizations'),
  });

  const organization = orgs.data?.find((o) => o.slug === orgSlug) ?? orgs.data?.[0];

  const workspaces = useQuery({
    queryKey: ['workspaces', organization?.id],
    enabled: Boolean(organization?.id),
    queryFn: () =>
      apiList<Workspace>(`/v1/organizations/${organization?.id}/workspaces`, {
        query: { limit: 100 },
      }),
  });

  const wsList = workspaces.data?.data ?? [];

  // One bases query per workspace, in parallel — the dashboard shows everything at once.
  const basesQueries = useQueries({
    queries: wsList.map((ws) => ({
      queryKey: ['bases', ws.id],
      queryFn: () => dataApi.listBases(ws.id),
    })),
  });

  const createOrg = useMutation({
    mutationFn: (name: string) => apiPost<{ id: string; slug: string }>('/v1/organizations', { name }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['organizations'] });
      setCreatingOrg(false);
    },
  });

  if (orgs.isPending) {
    return (
      <main id="main" className="mx-auto max-w-5xl px-6 py-10">
        <LoadingState label="Loading your home" />
      </main>
    );
  }

  if (orgs.isError) {
    return (
      <main id="main" className="mx-auto max-w-5xl px-6 py-10">
        <ErrorState
          message={orgs.error instanceof ApiError ? orgs.error.message : 'Could not load your home.'}
          {...(orgs.error instanceof ApiError ? { requestId: orgs.error.requestId } : {})}
          onRetry={() => void orgs.refetch()}
        />
      </main>
    );
  }

  if ((orgs.data?.length ?? 0) === 0) {
    return (
      <main id="main" className="mx-auto max-w-3xl px-6 py-10">
        {creatingOrg ? (
          <CreateOrganizationForm
            pending={createOrg.isPending}
            error={createOrg.error}
            onCancel={() => setCreatingOrg(false)}
            onSubmit={(name) => createOrg.mutate(name)}
          />
        ) : (
          <EmptyState
            title="Welcome to Tessera"
            description="An organization holds your workspaces, members, and billing. Create one to get started."
            action={
              <Button variant="primary" onClick={() => setCreatingOrg(true)}>
                Create your first organization
              </Button>
            }
          />
        )}
      </main>
    );
  }

  const firstWs = wsList[0];

  return (
    <div className="flex h-[calc(100dvh-3rem)] overflow-hidden">
      {/* ── Sidebar, Airtable-style ── */}
      <aside className="hidden w-64 shrink-0 flex-col border-r border-line bg-surface md:flex">
        {/* Organization switcher */}
        <div className="border-b border-line p-3">
          {(orgs.data?.length ?? 0) > 1 ? (
            <select
              value={organization?.slug ?? ''}
              onChange={(event) => setOrgSlug(event.target.value)}
              aria-label="Organization"
              className="w-full rounded-lg border border-line bg-surface px-2 py-1.5 text-sm font-medium text-primary"
            >
              {orgs.data?.map((o) => (
                <option key={o.id} value={o.slug}>
                  {o.name}
                </option>
              ))}
            </select>
          ) : (
            <div className="flex items-center gap-2.5 px-1">
              <span
                aria-hidden="true"
                className="flex h-8 w-8 items-center justify-center rounded-lg bg-gradient-to-br from-teal-500 to-cyan-600 text-xs font-bold text-white"
              >
                {monogram(organization?.name ?? '?')}
              </span>
              <span className="min-w-0">
                <span className="block truncate text-sm font-semibold text-primary">
                  {organization?.name}
                </span>
                <span className="block text-2xs text-tertiary">{organization?.plan} plan</span>
              </span>
            </div>
          )}
        </div>

        <nav className="min-h-0 flex-1 overflow-y-auto p-2">
          <span className="flex items-center gap-2 rounded-lg bg-accent-subtle px-2.5 py-1.5 text-sm font-medium text-accent-text">
            <span aria-hidden="true">🏠</span> Home
          </span>

          <p className="mt-4 px-2.5 text-2xs font-semibold uppercase tracking-wider text-tertiary">
            Workspaces
          </p>
          <ul className="mt-1 space-y-0.5">
            {wsList.map((ws) => (
              <li key={ws.id}>
                <a
                  href={`#ws-${ws.id}`}
                  className="flex items-center gap-2 rounded-lg px-2.5 py-1.5 text-sm text-secondary transition hover:bg-sunken hover:text-primary"
                >
                  <span aria-hidden="true" className="text-tertiary">
                    {ws.icon ?? '▦'}
                  </span>
                  <span className="truncate">{ws.name}</span>
                </a>
              </li>
            ))}
          </ul>

          {organization && (
            <Link
              href={`/app/o?org=${organization.slug}`}
              className="mt-2 flex items-center gap-2 rounded-lg px-2.5 py-1.5 text-sm text-tertiary transition hover:bg-sunken hover:text-primary"
            >
              <span aria-hidden="true">＋</span> New workspace
            </Link>
          )}
        </nav>

        <div className="border-t border-line p-2">
          {organization && (
            <Link
              href={`/app/o?org=${organization.slug}`}
              className="flex items-center gap-2 rounded-lg px-2.5 py-1.5 text-sm text-secondary transition hover:bg-sunken hover:text-primary"
            >
              <span aria-hidden="true">👥</span> Members
            </Link>
          )}
          <button
            type="button"
            onClick={() => setCreatingOrg((v) => !v)}
            className="flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-sm text-secondary transition hover:bg-sunken hover:text-primary"
          >
            <span aria-hidden="true">🏢</span> New organization
          </button>
        </div>
      </aside>

      {/* ── Main: every workspace's bases as coloured cards ── */}
      <main id="main" className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto max-w-5xl px-6 py-8">
          <h1 className="text-3xl font-bold tracking-tight text-primary">Home</h1>

          {creatingOrg && (
            <CreateOrganizationForm
              pending={createOrg.isPending}
              error={createOrg.error}
              onCancel={() => setCreatingOrg(false)}
              onSubmit={(name) => createOrg.mutate(name)}
            />
          )}

          {/* Quick actions, the way Airtable starts you off */}
          {organization && firstWs && (
            <div className="mt-5 grid gap-3 sm:grid-cols-3">
              {(
                [
                  ['✨', 'Start with templates', 'Project tracker, CRM, calendar…'],
                  ['⇪', 'Import an Excel file', 'Columns become fields instantly'],
                  ['▦', 'Start from scratch', 'A blank base, ready to shape'],
                ] as const
              ).map(([icon, title, hint]) => (
                <Link
                  key={title}
                  href={`/app/w?org=${organization.slug}&ws=${firstWs.id}`}
                  className="group rounded-xl border border-line bg-surface p-4 transition hover:border-teal-500/50 hover:shadow-mid"
                >
                  <span aria-hidden="true" className="text-xl">
                    {icon}
                  </span>
                  <p className="mt-2 text-sm font-semibold text-primary group-hover:text-accent-text">
                    {title}
                  </p>
                  <p className="mt-0.5 text-xs text-tertiary">{hint}</p>
                </Link>
              ))}
            </div>
          )}

          {workspaces.isPending && (
            <div className="mt-8">
              <LoadingState label="Loading workspaces" />
            </div>
          )}

          {wsList.map((ws, index) => {
            const basesQuery = basesQueries[index];
            const bases: readonly Base[] = basesQuery?.data?.data ?? [];

            return (
              <section key={ws.id} id={`ws-${ws.id}`} className="mt-10 scroll-mt-6">
                <div className="flex items-center justify-between gap-3">
                  <h2 className="flex items-center gap-2 text-lg font-semibold text-primary">
                    <span aria-hidden="true" className="text-tertiary">
                      {ws.icon ?? '▦'}
                    </span>
                    {ws.name}
                  </h2>
                  {organization && (
                    <Link
                      href={`/app/w?org=${organization.slug}&ws=${ws.id}`}
                      className="text-sm font-medium text-accent-text hover:underline"
                    >
                      Open workspace →
                    </Link>
                  )}
                </div>

                <div className="mt-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                  {basesQuery?.isPending && (
                    <div className="rounded-xl border border-line bg-sunken/40 p-4 text-sm text-tertiary">
                      Loading bases…
                    </div>
                  )}

                  {bases.map((base) => (
                    <Link
                      key={base.id}
                      href={`/app/b?org=${organization?.slug}&base=${base.id}`}
                      className="group flex items-center gap-3 rounded-xl border border-line bg-surface p-4 transition hover:-translate-y-0.5 hover:border-teal-500/50 hover:shadow-mid"
                    >
                      <span
                        aria-hidden="true"
                        className={cn(
                          'flex h-11 w-11 shrink-0 items-center justify-center rounded-xl text-sm font-bold text-white shadow-sm',
                          tileColor(base.id),
                        )}
                        style={base.color ? { backgroundColor: base.color } : undefined}
                      >
                        {base.icon && /\p{Extended_Pictographic}/u.test(base.icon)
                          ? base.icon
                          : monogram(base.name)}
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-sm font-semibold text-primary group-hover:text-accent-text">
                          {base.name}
                        </span>
                        <span className="block text-xs text-tertiary">Base</span>
                      </span>
                    </Link>
                  ))}

                  {organization && basesQuery?.isSuccess && (
                    <Link
                      href={`/app/w?org=${organization.slug}&ws=${ws.id}`}
                      className="flex items-center justify-center gap-2 rounded-xl border border-dashed border-line p-4 text-sm text-tertiary transition hover:border-teal-500/60 hover:text-accent-text"
                    >
                      ＋ New base
                    </Link>
                  )}
                </div>
              </section>
            );
          })}

          {workspaces.isSuccess && wsList.length === 0 && (
            <div className="mt-10">
              <EmptyState
                title="No workspaces yet"
                description="A workspace holds related bases. Create your first one to get going."
                action={
                  organization && (
                    <Link
                      href={`/app/o?org=${organization.slug}`}
                      className="rounded-lg bg-accent px-3.5 py-2 text-sm font-semibold text-inverted"
                    >
                      Create a workspace
                    </Link>
                  )
                }
              />
            </div>
          )}
        </div>
      </main>
    </div>
  );
}

function CreateOrganizationForm({
  pending,
  error,
  onCancel,
  onSubmit,
}: {
  pending: boolean;
  error: unknown;
  onCancel: () => void;
  onSubmit: (name: string) => void;
}) {
  const [name, setName] = useState('');

  return (
    <Card className="mt-6 p-5">
      <h2 className="text-md font-medium text-primary">New organization</h2>

      {error instanceof ApiError && (
        <Alert tone="danger" className="mt-3">
          {error.message}
        </Alert>
      )}

      <form
        className="mt-4 space-y-4"
        onSubmit={(event) => {
          event.preventDefault();
          if (name.trim()) onSubmit(name.trim());
        }}
      >
        <Field
          label="Organization name"
          hint="You can change this later. The URL is derived from it."
          required
          autoFocus
          value={name}
          onChange={(event) => setName(event.target.value)}
        />
        <div className="flex gap-2">
          <Button type="submit" variant="primary" loading={pending} disabled={!name.trim()}>
            Create
          </Button>
          <Button type="button" variant="ghost" onClick={onCancel} disabled={pending}>
            Cancel
          </Button>
        </div>
      </form>
    </Card>
  );
}

'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import Link from 'next/link';
import { useState } from 'react';

import { Button } from '@/components/ui/button';
import { Alert, Card, EmptyState, ErrorState, LoadingState } from '@/components/ui/feedback';
import { Field } from '@/components/ui/field';
import { ApiError, apiGet, apiPost } from '@/lib/api-client';

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

/**
 * The organization picker — the first screen after signing in.
 *
 * A user genuinely belongs to many organizations (their employer, a client, a side project), so
 * this is a real destination rather than a redirect stop. It is also the only list in the
 * product that spans tenants, which it can do safely because it is derived from the caller's own
 * memberships.
 */
export default function OrganizationsPage() {
  const queryClient = useQueryClient();
  const [creating, setCreating] = useState(false);

  const query = useQuery({
    queryKey: ['organizations'],
    queryFn: () => apiGet<OrganizationSummary[]>('/v1/me/organizations'),
  });

  const create = useMutation({
    mutationFn: (name: string) => apiPost<{ id: string; slug: string }>('/v1/organizations', { name }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['organizations'] });
      setCreating(false);
    },
  });

  return (
    <main id="main" className="mx-auto max-w-3xl px-6 py-10">
      <header className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-line bg-gradient-to-r from-accent-subtle/60 to-transparent p-5">
        <div className="flex items-center gap-4">
          <span aria-hidden="true" className="flex h-12 w-12 shrink-0 items-center justify-center rounded-xl bg-accent text-xl text-inverted shadow-sm">🏢</span>
          <div>
          <h1 className="text-2xl font-semibold tracking-tight text-primary">Organizations</h1>
          <p className="mt-1 text-sm text-secondary">
            Choose an organization to open, or create a new one.
          </p>
          </div>
        </div>
        {!creating && (
          <Button variant="primary" onClick={() => setCreating(true)}>
            New organization
          </Button>
        )}
      </header>

      {creating && (
        <CreateOrganizationForm
          pending={create.isPending}
          error={create.error}
          onCancel={() => setCreating(false)}
          onSubmit={(name) => create.mutate(name)}
        />
      )}

      <div className="mt-6">
        {query.isPending && <LoadingState label="Loading your organizations" />}

        {query.isError && (
          <ErrorState
            message={
              query.error instanceof ApiError
                ? query.error.message
                : 'Could not load your organizations.'
            }
            {...(query.error instanceof ApiError ? { requestId: query.error.requestId } : {})}
            onRetry={() => void query.refetch()}
          />
        )}

        {query.isSuccess && query.data.length === 0 && !creating && (
          <EmptyState
            title="No organizations yet"
            description="An organization holds your workspaces, members, and billing. Create one to get started."
            action={
              <Button variant="primary" onClick={() => setCreating(true)}>
                Create your first organization
              </Button>
            }
          />
        )}

        {query.isSuccess && query.data.length > 0 && (
          <ul className="grid gap-3 sm:grid-cols-2">
            {query.data.map((organization) => (
              <Card as="li" key={organization.id} className="transition-shadow hover:shadow-mid">
                <Link
                  href={`/app/o?org=${organization.slug}`}
                  className="flex items-center gap-3 p-4"
                >
                  <span
                    aria-hidden="true"
                    className="flex h-9 w-9 shrink-0 items-center justify-center rounded bg-accent-subtle text-sm font-semibold text-accent-text"
                  >
                    {organization.name.slice(0, 2).toUpperCase()}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-base font-medium text-primary">
                      {organization.name}
                    </span>
                    <span className="block text-xs text-tertiary">
                      {organization.role} &middot; {organization.plan} plan
                    </span>
                  </span>
                  {organization.status !== 'active' && (
                    <span className="rounded bg-warning-subtle px-1.5 py-0.5 text-2xs font-medium text-warning-text">
                      {organization.status}
                    </span>
                  )}
                </Link>
              </Card>
            ))}
          </ul>
        )}
      </div>
    </main>
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

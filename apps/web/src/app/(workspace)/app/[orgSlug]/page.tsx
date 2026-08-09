'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { Page } from '@tessera/types';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useState } from 'react';

import { Button } from '@/components/ui/button';
import { Alert, Card, EmptyState, ErrorState, LoadingState } from '@/components/ui/feedback';
import { Field } from '@/components/ui/field';
import { ApiError, apiGet, apiList, apiPost } from '@/lib/api-client';

interface OrganizationSummary {
  id: string;
  name: string;
  slug: string;
  plan: string;
  role: string;
}

interface Workspace {
  id: string;
  name: string;
  description: string | null;
  icon: string | null;
  color: string | null;
  archivedAt: string | null;
  createdAt: string;
}

/**
 * The workspace list for one organization.
 *
 * The organization is addressed by slug in the URL for readability, then resolved to an id once
 * — every subsequent call uses the id. Resolving the slug on every request would make the slug a
 * second identity for the tenant, which is exactly the kind of ambiguity that produces
 * cross-tenant bugs.
 */
export default function OrganizationHomePage() {
  const params = useParams<{ orgSlug: string }>();
  const queryClient = useQueryClient();
  const [creating, setCreating] = useState(false);

  const organizations = useQuery({
    queryKey: ['organizations'],
    queryFn: () => apiGet<OrganizationSummary[]>('/v1/me/organizations'),
  });

  const organization = organizations.data?.find((item) => item.slug === params.orgSlug);

  const workspaces = useQuery({
    queryKey: ['workspaces', organization?.id],
    enabled: Boolean(organization?.id),
    queryFn: () =>
      apiList<Workspace>(`/v1/organizations/${organization?.id}/workspaces`, {
        query: { limit: 100 },
      }),
  });

  const create = useMutation({
    mutationFn: (name: string) =>
      apiPost<Workspace>(`/v1/organizations/${organization?.id}/workspaces`, { name }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['workspaces', organization?.id] });
      setCreating(false);
    },
  });

  if (organizations.isPending) {
    return (
      <main id="main" className="mx-auto max-w-5xl px-6 py-10">
        <LoadingState label="Loading organization" />
      </main>
    );
  }

  if (organizations.isSuccess && !organization) {
    return (
      <main id="main" className="mx-auto max-w-5xl px-6 py-10">
        <EmptyState
          title="Organization not found"
          description="It may have been renamed, or you may no longer be a member."
        />
      </main>
    );
  }

  return (
    <main id="main" className="mx-auto max-w-5xl px-6 py-10">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight text-primary">
            {organization?.name}
          </h1>
          <p className="mt-1 text-sm text-secondary">
            Workspaces group related bases and the people who work on them.
          </p>
        </div>
        {!creating && (
          <Button variant="primary" onClick={() => setCreating(true)}>
            New workspace
          </Button>
        )}
      </header>

      {creating && (
        <Card className="mt-6 p-5">
          <h2 className="text-md font-medium text-primary">New workspace</h2>

          {create.error instanceof ApiError && (
            <Alert
              tone={create.error.code === 'PLAN_LIMIT_EXCEEDED' ? 'warning' : 'danger'}
              className="mt-3"
            >
              {create.error.message}
            </Alert>
          )}

          <CreateWorkspaceForm
            pending={create.isPending}
            onCancel={() => setCreating(false)}
            onSubmit={(name) => create.mutate(name)}
          />
        </Card>
      )}

      <div className="mt-6">
        {workspaces.isPending && <LoadingState label="Loading workspaces" />}

        {workspaces.isError && (
          <ErrorState
            message={
              workspaces.error instanceof ApiError
                ? workspaces.error.message
                : 'Could not load workspaces.'
            }
            {...(workspaces.error instanceof ApiError
              ? { requestId: workspaces.error.requestId }
              : {})}
            onRetry={() => void workspaces.refetch()}
          />
        )}

        {workspaces.isSuccess && (
          <WorkspaceGrid page={workspaces.data} orgSlug={params.orgSlug} />
        )}
      </div>
    </main>
  );
}

function WorkspaceGrid({ page, orgSlug }: { page: Page<Workspace>; orgSlug: string }) {
  if (page.data.length === 0) {
    return (
      <EmptyState
        title="No workspaces yet"
        description="Create a workspace to hold your first base."
      />
    );
  }

  return (
    <ul className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
      {page.data.map((workspace) => (
        <Card as="li" key={workspace.id} className="transition-shadow hover:shadow-mid">
          <Link href={`/app/${orgSlug}/w/${workspace.id}`} className="flex items-start gap-3 p-4">
            <span
              aria-hidden="true"
              className="flex h-8 w-8 shrink-0 items-center justify-center rounded text-sm"
              style={
                workspace.color
                  ? { backgroundColor: `${workspace.color}22`, color: workspace.color }
                  : undefined
              }
            >
              {workspace.icon ?? '▦'}
            </span>
            <div className="min-w-0 flex-1">
              <h3 className="truncate text-base font-medium text-primary">{workspace.name}</h3>
              {workspace.description && (
                <p className="mt-0.5 line-clamp-2 text-xs text-secondary">
                  {workspace.description}
                </p>
              )}
              {workspace.archivedAt && (
                <span className="mt-1.5 inline-block rounded bg-sunken px-1.5 py-0.5 text-2xs font-medium text-tertiary">
                  Archived
                </span>
              )}
            </div>
          </Link>
        </Card>
      ))}
    </ul>
  );
}

function CreateWorkspaceForm({
  pending,
  onCancel,
  onSubmit,
}: {
  pending: boolean;
  onCancel: () => void;
  onSubmit: (name: string) => void;
}) {
  const [name, setName] = useState('');

  return (
    <form
      className="mt-4 space-y-4"
      onSubmit={(event) => {
        event.preventDefault();
        if (name.trim()) onSubmit(name.trim());
      }}
    >
      <Field
        label="Workspace name"
        required
        autoFocus
        value={name}
        onChange={(event) => setName(event.target.value)}
      />
      <div className="flex gap-2">
        <Button type="submit" variant="primary" loading={pending} disabled={!name.trim()}>
          Create workspace
        </Button>
        <Button type="button" variant="ghost" onClick={onCancel} disabled={pending}>
          Cancel
        </Button>
      </div>
    </form>
  );
}

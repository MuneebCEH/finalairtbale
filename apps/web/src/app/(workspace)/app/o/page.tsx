'use client';

import { useQuery } from '@tanstack/react-query';
import type { Page } from '@tessera/types';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { Suspense, useState } from 'react';

import { Card, EmptyState, ErrorState, LoadingState } from '@/components/ui/feedback';
import { HeroButton, PageHero } from '@/components/ui/page-hero';
import { MembersPanel } from '@/features/data/members-panel';
import { WorkspaceWizard } from '@/features/data/workspace-wizard';
import { ApiError, apiGet, apiList } from '@/lib/api-client';

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
  return (
    <Suspense fallback={null}>
      <OrganizationHomePageInner />
    </Suspense>
  );
}

function OrganizationHomePageInner() {
  const searchParams = useSearchParams();
  const orgSlug = searchParams.get('org') ?? '';
  const [creating, setCreating] = useState(false);
  const [showMembers, setShowMembers] = useState(false);

  const organizations = useQuery({
    queryKey: ['organizations'],
    queryFn: () => apiGet<OrganizationSummary[]>('/v1/me/organizations'),
  });

  const organization = organizations.data?.find((item) => item.slug === orgSlug);

  const workspaces = useQuery({
    queryKey: ['workspaces', organization?.id],
    enabled: Boolean(organization?.id),
    queryFn: () =>
      apiList<Workspace>(`/v1/organizations/${organization?.id}/workspaces`, {
        query: { limit: 100 },
      }),
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
      <PageHero
        icon={(organization?.name ?? '?').slice(0, 1).toUpperCase()}
        title={organization?.name}
        subtitle="Workspaces group related bases and the people who work on them."
        actions={
          !creating && (
            <>
              <HeroButton onClick={() => setShowMembers((v) => !v)}>
                👥 {showMembers ? 'Hide members' : 'Members'}
              </HeroButton>
              <HeroButton primary onClick={() => setCreating(true)}>
                + New workspace
              </HeroButton>
            </>
          )
        }
      />

      {showMembers && organization && <MembersPanel orgId={organization.id} />}

      {creating && organization && (
        <WorkspaceWizard
          orgId={organization.id}
          orgSlug={orgSlug}
          onClose={() => setCreating(false)}
        />
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
          <WorkspaceGrid page={workspaces.data} orgSlug={orgSlug} />
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
          <Link href={`/app/w?org=${orgSlug}&ws=${workspace.id}`} className="flex items-start gap-3 p-4">
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

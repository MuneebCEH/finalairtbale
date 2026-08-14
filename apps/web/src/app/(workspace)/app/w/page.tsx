'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useState } from 'react';

import { Button } from '@/components/ui/button';
import { Alert, Card, EmptyState, ErrorState, LoadingState } from '@/components/ui/feedback';
import { Field } from '@/components/ui/field';
import { dataApi } from '@/features/data/api';
import { ApiError } from '@/lib/api-client';

/** The bases inside one workspace. */
export default function WorkspaceBasesPage() {
  return (
    <Suspense fallback={null}>
      <WorkspaceBasesPageInner />
    </Suspense>
  );
}

function WorkspaceBasesPageInner() {
  const searchParams = useSearchParams();
  const orgSlug = searchParams.get('org') ?? '';
  const workspaceId = searchParams.get('ws') ?? '';
  const router = useRouter();
  const queryClient = useQueryClient();
  const [creating, setCreating] = useState(false);
  const [showTemplates, setShowTemplates] = useState(false);
  const [name, setName] = useState('');

  const bases = useQuery({
    queryKey: ['bases', workspaceId],
    queryFn: () => dataApi.listBases(workspaceId),
  });

  const templates = useQuery({
    queryKey: ['templates'],
    queryFn: () => dataApi.listTemplates(),
    enabled: showTemplates,
  });

  const useTemplate = useMutation({
    mutationFn: (templateId: string) => dataApi.createFromTemplate(workspaceId, templateId),
    onSuccess: (base) => router.push(`/app/b?org=${orgSlug}&base=${base.id}`),
  });

  const create = useMutation({
    mutationFn: (baseName: string) => dataApi.createBase(workspaceId, baseName),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['bases', workspaceId] });
      setCreating(false);
      setName('');
    },
  });

  return (
    <main id="main" className="mx-auto max-w-5xl px-6 py-10">
      <nav aria-label="Breadcrumb" className="mb-4 text-sm text-secondary">
        <Link href={`/app/o?org=${orgSlug}`} className="hover:text-primary">
          Workspaces
        </Link>
      </nav>

      <header className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight text-primary">Bases</h1>
          <p className="mt-1 text-sm text-secondary">
            A base holds related tables, and the views and automations built on them.
          </p>
        </div>
        {!creating && (
          <div className="flex gap-2">
            <Button variant="ghost" onClick={() => setShowTemplates((v) => !v)}>
              {showTemplates ? 'Hide templates' : 'Use a template'}
            </Button>
            <Button variant="primary" onClick={() => setCreating(true)}>
              New base
            </Button>
          </div>
        )}
      </header>

      {showTemplates && (
        <Card className="mt-6 p-5">
          <h2 className="text-md font-medium text-primary">Start from a template</h2>
          <p className="mt-1 text-sm text-secondary">
            A ready-made base with tables, fields and sample data you can edit.
          </p>

          {useTemplate.error instanceof ApiError && (
            <Alert tone="danger" className="mt-3">
              {useTemplate.error.message}
            </Alert>
          )}

          {templates.isPending && <LoadingState label="Loading templates" />}

          {templates.isSuccess && (
            <ul className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
              {templates.data.data.map((template) => (
                <li key={template.id}>
                  <Card className="flex h-full flex-col p-4">
                    <div className="flex items-center gap-2">
                      <span aria-hidden="true" className="text-xl">
                        {template.icon}
                      </span>
                      <span className="font-medium text-primary">{template.name}</span>
                    </div>
                    <p className="mt-1 text-2xs uppercase tracking-wide text-tertiary">
                      {template.category}
                    </p>
                    <p className="mt-2 flex-1 text-xs text-secondary">{template.description}</p>
                    <p className="mt-2 text-2xs text-tertiary">Tables: {template.tables.join(', ')}</p>
                    <Button
                      variant="primary"
                      className="mt-3"
                      loading={useTemplate.isPending && useTemplate.variables === template.id}
                      onClick={() => useTemplate.mutate(template.id)}
                    >
                      Use template
                    </Button>
                  </Card>
                </li>
              ))}
            </ul>
          )}
        </Card>
      )}

      {creating && (
        <Card className="mt-6 p-5">
          <h2 className="text-md font-medium text-primary">New base</h2>

          {create.error instanceof ApiError && (
            <Alert
              tone={create.error.code === 'PLAN_LIMIT_EXCEEDED' ? 'warning' : 'danger'}
              className="mt-3"
            >
              {create.error.message}
            </Alert>
          )}

          <form
            className="mt-4 space-y-4"
            onSubmit={(event) => {
              event.preventDefault();
              if (name.trim()) create.mutate(name.trim());
            }}
          >
            <Field
              label="Base name"
              required
              autoFocus
              value={name}
              onChange={(event) => setName(event.target.value)}
              hint="A table and a primary field are created for you, so it is usable straight away."
            />
            <div className="flex gap-2">
              <Button type="submit" variant="primary" loading={create.isPending} disabled={!name.trim()}>
                Create base
              </Button>
              <Button type="button" variant="ghost" onClick={() => setCreating(false)}>
                Cancel
              </Button>
            </div>
          </form>
        </Card>
      )}

      <div className="mt-6">
        {bases.isPending && <LoadingState label="Loading bases" />}

        {bases.isError && (
          <ErrorState
            message={bases.error instanceof ApiError ? bases.error.message : 'Could not load bases.'}
            {...(bases.error instanceof ApiError ? { requestId: bases.error.requestId } : {})}
            onRetry={() => void bases.refetch()}
          />
        )}

        {bases.isSuccess && bases.data.data.length === 0 && !creating && (
          <EmptyState
            title="No bases yet"
            description="A base is where your tables live. Create one to start modelling your data."
            action={
              <Button variant="primary" onClick={() => setCreating(true)}>
                Create your first base
              </Button>
            }
          />
        )}

        {bases.isSuccess && bases.data.data.length > 0 && (
          <ul className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {bases.data.data.map((base) => (
              <Card as="li" key={base.id} className="transition-shadow hover:shadow-mid">
                <Link href={`/app/b?org=${orgSlug}&base=${base.id}`} className="flex items-start gap-3 p-4">
                  <span
                    aria-hidden="true"
                    className="flex h-8 w-8 shrink-0 items-center justify-center rounded bg-accent-subtle text-sm text-accent-text"
                    style={base.color ? { backgroundColor: `${base.color}22`, color: base.color } : undefined}
                  >
                    {base.icon ?? '▦'}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-base font-medium text-primary">{base.name}</span>
                    {base.description && (
                      <span className="mt-0.5 block line-clamp-2 text-xs text-secondary">
                        {base.description}
                      </span>
                    )}
                  </span>
                </Link>
              </Card>
            ))}
          </ul>
        )}
      </div>
    </main>
  );
}

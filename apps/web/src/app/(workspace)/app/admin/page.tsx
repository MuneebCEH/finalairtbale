'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';

import { Button } from '@/components/ui/button';
import { Alert, Card, EmptyState, LoadingState } from '@/components/ui/feedback';
import { PageHero } from '@/components/ui/page-hero';
import { dataApi } from '@/features/data/api';
import { ApiError } from '@/lib/api-client';
import { cn } from '@/lib/cn';

/**
 * The platform console — the SaaS operator's view across every tenant. The server 404s anyone
 * who is not a super admin, so for a normal member this page honestly reports "not found"
 * rather than pretending a console exists that they cannot open.
 */
export default function AdminPage() {
  const queryClient = useQueryClient();
  const [notice, setNotice] = useState('');

  const overview = useQuery({
    queryKey: ['admin', 'overview'],
    queryFn: () => dataApi.adminOverview(),
    retry: false,
  });
  const users = useQuery({
    queryKey: ['admin', 'users'],
    queryFn: () => dataApi.adminUsers(),
    retry: false,
  });

  const updateUser = useMutation({
    mutationFn: ({ userId, ...input }: { userId: string; status?: 'active' | 'suspended'; password?: string; isSuperAdmin?: boolean }) =>
      dataApi.adminUpdateUser(userId, input),
    onSuccess: async (_result, variables) => {
      await queryClient.invalidateQueries({ queryKey: ['admin'] });
      setNotice(
        variables.password
          ? 'Password changed — share the new one with them.'
          : 'Saved.',
      );
    },
  });

  if (overview.isPending || users.isPending) {
    return (
      <main id="main" className="mx-auto max-w-5xl px-6 py-10">
        <LoadingState label="Loading console" />
      </main>
    );
  }

  // The API 404s non-staff; say so plainly instead of rendering an empty shell.
  if (overview.isError || users.isError) {
    return (
      <main id="main" className="mx-auto max-w-5xl px-6 py-10">
        <EmptyState
          title="Not found"
          description="There is nothing at this address."
        />
      </main>
    );
  }

  const totals = overview.data!.totals;
  const error = updateUser.error;

  return (
    <main id="main" className="mx-auto max-w-6xl px-6 py-8">
      <PageHero
        icon="⛨"
        title="Platform console"
        subtitle="Every organization and account on this deployment — the operator's view."
      />

      {error instanceof ApiError && (
        <Alert tone="danger" className="mt-4">
          {error.message}
        </Alert>
      )}
      {notice && !error && (
        <Alert tone="info" className="mt-4">
          {notice}
        </Alert>
      )}

      {/* Totals */}
      <div className="mt-6 grid grid-cols-2 gap-3 sm:grid-cols-5">
        {(
          [
            ['Organizations', totals.organizations, '🏢', 'from-teal-600 to-cyan-600'],
            ['Users', totals.users, '👥', 'from-indigo-600 to-blue-600'],
            ['Bases', totals.bases, '▦', 'from-violet-600 to-purple-600'],
            ['Tables', totals.tables, '⊞', 'from-amber-500 to-orange-600'],
            ['Records', totals.records, '≣', 'from-rose-500 to-pink-600'],
          ] as const
        ).map(([label, value, icon, grad]) => (
          <div
            key={label}
            className={cn(
              'relative overflow-hidden rounded-2xl bg-gradient-to-br p-4 text-white shadow-md',
              grad,
            )}
          >
            <span aria-hidden="true" className="absolute right-3 top-3 text-xl opacity-50">
              {icon}
            </span>
            <p className="text-3xl font-bold tabular-nums tracking-tight">{value.toLocaleString()}</p>
            <p className="mt-1 text-xs font-medium uppercase tracking-wide text-white/80">{label}</p>
          </div>
        ))}
      </div>

      {/* Organizations */}
      <Card className="mt-6 overflow-x-auto p-0">
        <h2 className="flex items-center gap-2 border-b border-line bg-sunken/50 px-4 py-3 text-md font-semibold text-primary"><span aria-hidden="true">🏢</span>Organizations</h2>
        <table className="w-full text-left text-sm">
          <thead>
            <tr className="border-b border-line bg-sunken/30 text-2xs font-medium uppercase tracking-wide text-tertiary">
              <th className="px-4 py-2 font-medium">Name</th>
              <th className="px-4 py-2 font-medium">Plan</th>
              <th className="px-4 py-2 font-medium">Members</th>
              <th className="px-4 py-2 font-medium">Bases</th>
              <th className="px-4 py-2 font-medium">Records</th>
            </tr>
          </thead>
          <tbody>
            {overview.data!.organizations.map((org) => (
              <tr key={org.id} className="border-b border-line transition-colors last:border-0 hover:bg-sunken/40">
                <td className="px-4 py-2 text-primary">{org.name}</td>
                <td className="px-4 py-2 text-secondary">{org.plan}</td>
                <td className="px-4 py-2 tabular-nums text-secondary">{org.members}</td>
                <td className="px-4 py-2 tabular-nums text-secondary">{org.bases}</td>
                <td className="px-4 py-2 tabular-nums text-secondary">{org.records.toLocaleString()}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </Card>

      {/* Users */}
      <Card className="mt-6 overflow-x-auto p-0">
        <h2 className="flex items-center gap-2 border-b border-line bg-sunken/50 px-4 py-3 text-md font-semibold text-primary"><span aria-hidden="true">👥</span>Users</h2>
        <table className="w-full text-left text-sm">
          <thead>
            <tr className="border-b border-line bg-sunken/30 text-2xs font-medium uppercase tracking-wide text-tertiary">
              <th className="px-4 py-2 font-medium">Account</th>
              <th className="px-4 py-2 font-medium">Status</th>
              <th className="px-4 py-2 font-medium">Orgs</th>
              <th className="px-4 py-2 font-medium">Last login</th>
              <th className="px-4 py-2 font-medium">Actions</th>
            </tr>
          </thead>
          <tbody>
            {users.data!.map((user) => (
              <tr key={user.id} className="border-b border-line transition-colors last:border-0 hover:bg-sunken/40">
                <td className="px-4 py-2">
                  <span className="block text-primary">
                    {user.name}
                    {user.isSuperAdmin && (
                      <span className="ml-1.5 rounded bg-accent-subtle px-1.5 py-0.5 text-2xs text-accent-text">
                        super admin
                      </span>
                    )}
                  </span>
                  <span className="block text-xs text-tertiary">{user.email}</span>
                </td>
                <td className="px-4 py-2">
                  <span
                    className={cn(
                      'rounded-full px-2 py-0.5 text-2xs',
                      user.status === 'active'
                        ? 'bg-success-subtle text-success-text'
                        : 'bg-danger-subtle text-danger-text',
                    )}
                  >
                    {user.status}
                  </span>
                </td>
                <td className="px-4 py-2 tabular-nums text-secondary">{user.organizations}</td>
                <td className="px-4 py-2 text-xs text-secondary">
                  {user.lastLoginAt ? new Date(user.lastLoginAt).toLocaleDateString() : '—'}
                </td>
                <td className="px-4 py-2">
                  <div className="flex flex-wrap gap-1">
                    <Button
                      size="sm"
                      variant={user.status === 'active' ? 'ghost' : 'secondary'}
                      onClick={() => {
                        const next = user.status === 'active' ? 'suspended' : 'active';
                        if (window.confirm(`${next === 'suspended' ? 'Suspend' : 'Reactivate'} ${user.email}?`)) {
                          updateUser.mutate({ userId: user.id, status: next });
                        }
                      }}
                    >
                      {user.status === 'active' ? 'Suspend' : 'Activate'}
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => {
                        const password = window.prompt(`New password for ${user.email} (min 8 chars):`);
                        if (password && password.length >= 8) {
                          updateUser.mutate({ userId: user.id, password });
                        } else if (password !== null) {
                          setNotice('Password must be at least 8 characters — nothing changed.');
                        }
                      }}
                    >
                      Reset password
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => {
                        const next = !user.isSuperAdmin;
                        if (window.confirm(`${next ? 'Grant' : 'Revoke'} super admin for ${user.email}?`)) {
                          updateUser.mutate({ userId: user.id, isSuperAdmin: next });
                        }
                      }}
                    >
                      {user.isSuperAdmin ? 'Revoke admin' : 'Make admin'}
                    </Button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </Card>
    </main>
  );
}

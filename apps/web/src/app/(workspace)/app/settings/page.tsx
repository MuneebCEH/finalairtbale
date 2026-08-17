'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';

import { Button } from '@/components/ui/button';
import { Alert, Card, LoadingState } from '@/components/ui/feedback';
import { PageHero } from '@/components/ui/page-hero';
import { dataApi } from '@/features/data/api';
import { ApiError, apiPatch, apiPost } from '@/lib/api-client';

/**
 * Account settings: the display name, and a real password change (current password required;
 * the server enforces its strong-password rule). The account menu links here, so this page
 * existing is part of the menu telling the truth.
 */
export default function SettingsPage() {
  const queryClient = useQueryClient();

  const me = useQuery({ queryKey: ['me'], queryFn: () => dataApi.me() });

  const [name, setName] = useState('');
  useEffect(() => {
    if (me.data?.name) setName(me.data.name);
  }, [me.data?.name]);

  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [notice, setNotice] = useState('');

  const saveName = useMutation({
    mutationFn: () => apiPatch('/v1/me', { name: name.trim() }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['me'] });
      setNotice('Name saved.');
    },
  });

  const changePassword = useMutation({
    mutationFn: () =>
      apiPost('/v1/auth/password/change', { currentPassword: current, newPassword: next }),
    onSuccess: () => {
      setCurrent('');
      setNext('');
      setNotice('Password changed.');
    },
  });

  if (me.isPending) {
    return (
      <main id="main" className="mx-auto max-w-3xl px-6 py-10">
        <LoadingState label="Loading settings" />
      </main>
    );
  }

  const error = saveName.error ?? changePassword.error ?? null;

  return (
    <main id="main" className="mx-auto max-w-3xl px-6 py-8">
      <PageHero
        icon={(me.data?.name || '?').slice(0, 1).toUpperCase()}
        title="Settings"
        subtitle={me.data?.email}
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

      {/* Profile */}
      <Card className="mt-6 p-5">
        <h2 className="text-md font-semibold text-primary">Profile</h2>
        <form
          className="mt-3 flex flex-wrap items-end gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            if (name.trim()) saveName.mutate();
          }}
        >
          <label className="flex min-w-0 flex-1 flex-col gap-1 text-xs font-medium text-secondary">
            Display name
            <input
              value={name}
              onChange={(event) => setName(event.target.value)}
              className="h-9 rounded border border-line bg-surface px-2 text-sm font-normal text-primary"
            />
          </label>
          <Button type="submit" variant="primary" loading={saveName.isPending} disabled={!name.trim()}>
            Save
          </Button>
        </form>
      </Card>

      {/* Password */}
      <Card className="mt-4 p-5">
        <h2 className="text-md font-semibold text-primary">Change password</h2>
        <p className="mt-1 text-xs text-tertiary">
          At least 12 characters, mixing letters with numbers or symbols.
        </p>
        <form
          className="mt-3 grid gap-3 sm:grid-cols-2"
          onSubmit={(event) => {
            event.preventDefault();
            if (current && next) changePassword.mutate();
          }}
        >
          <label className="flex flex-col gap-1 text-xs font-medium text-secondary">
            Current password
            <input
              type="password"
              value={current}
              onChange={(event) => setCurrent(event.target.value)}
              autoComplete="current-password"
              className="h-9 rounded border border-line bg-surface px-2 text-sm font-normal text-primary"
            />
          </label>
          <label className="flex flex-col gap-1 text-xs font-medium text-secondary">
            New password
            <input
              type="password"
              value={next}
              onChange={(event) => setNext(event.target.value)}
              autoComplete="new-password"
              className="h-9 rounded border border-line bg-surface px-2 text-sm font-normal text-primary"
            />
          </label>
          <div className="sm:col-span-2">
            <Button
              type="submit"
              variant="primary"
              loading={changePassword.isPending}
              disabled={!current || next.length < 12}
            >
              Change password
            </Button>
          </div>
        </form>
      </Card>
    </main>
  );
}

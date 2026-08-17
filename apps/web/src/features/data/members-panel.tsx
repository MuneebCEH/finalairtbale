'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';

import { Button } from '@/components/ui/button';
import { Alert, Card, LoadingState } from '@/components/ui/feedback';
import { dataApi } from '@/features/data/api';
import { ApiError } from '@/lib/api-client';

/**
 * The organization's people: who is in, with what role, and a way to add someone — creating
 * their account on the spot, because this deployment has no invite-email pipe. The server is
 * the authority on every rule (last owner, who may mint owners); this panel just surfaces its
 * answers honestly.
 */

const ROLES = [
  { value: 'owner', label: 'Owner', hint: 'everything, including members' },
  { value: 'admin', label: 'Admin', hint: 'tables, fields, automations, members' },
  { value: 'editor', label: 'Editor', hint: 'records only — no schema changes' },
  { value: 'viewer', label: 'Viewer', hint: 'read-only' },
] as const;

export function MembersPanel({ orgId }: { orgId: string }) {
  const queryClient = useQueryClient();
  const [adding, setAdding] = useState(false);
  const [form, setForm] = useState({ name: '', email: '', password: '', role: 'editor' });

  const members = useQuery({
    queryKey: ['members', orgId],
    queryFn: () => dataApi.listMembers(orgId),
  });

  const refresh = () => queryClient.invalidateQueries({ queryKey: ['members', orgId] });

  const add = useMutation({
    mutationFn: () =>
      dataApi.createMember(orgId, {
        name: form.name.trim(),
        email: form.email.trim(),
        ...(form.password ? { password: form.password } : {}),
        role: form.role,
      }),
    onSuccess: async () => {
      await refresh();
      setAdding(false);
      setForm({ name: '', email: '', password: '', role: 'editor' });
    },
  });

  const changeRole = useMutation({
    mutationFn: ({ userId, role }: { userId: string; role: string }) =>
      dataApi.updateMemberRole(orgId, userId, role),
    onSuccess: refresh,
  });

  const remove = useMutation({
    mutationFn: (userId: string) => dataApi.removeMember(orgId, userId),
    onSuccess: refresh,
  });

  const error = add.error ?? changeRole.error ?? remove.error ?? null;

  return (
    <Card className="mt-6 p-5">
      <div className="flex items-center justify-between gap-3">
        <div>
          <h2 className="text-md font-medium text-primary">Members</h2>
          <p className="mt-0.5 text-sm text-secondary">
            Who can open this organization, and what they are allowed to change.
          </p>
        </div>
        {!adding && (
          <Button variant="primary" size="sm" onClick={() => setAdding(true)}>
            Add member
          </Button>
        )}
      </div>

      {error instanceof ApiError && (
        <Alert tone="danger" className="mt-3">
          {error.message}
        </Alert>
      )}

      {adding && (
        <form
          className="mt-4 grid gap-2 rounded border border-line p-3 sm:grid-cols-2"
          onSubmit={(event) => {
            event.preventDefault();
            if (form.name.trim() && form.email.trim()) add.mutate();
          }}
        >
          <label className="flex flex-col gap-1 text-xs font-medium text-secondary">
            Name
            <input
              autoFocus
              value={form.name}
              onChange={(e) => setForm({ ...form, name: e.target.value })}
              className="h-8 rounded border border-line bg-surface px-2 text-sm font-normal text-primary"
            />
          </label>
          <label className="flex flex-col gap-1 text-xs font-medium text-secondary">
            Email
            <input
              type="email"
              value={form.email}
              onChange={(e) => setForm({ ...form, email: e.target.value })}
              className="h-8 rounded border border-line bg-surface px-2 text-sm font-normal text-primary"
            />
          </label>
          <label className="flex flex-col gap-1 text-xs font-medium text-secondary">
            Password
            <input
              type="text"
              value={form.password}
              onChange={(e) => setForm({ ...form, password: e.target.value })}
              placeholder="Min 8 characters — share it with them"
              className="h-8 rounded border border-line bg-surface px-2 text-sm font-normal text-primary"
            />
            <span className="font-normal text-tertiary">
              Needed for a brand-new account; leave blank if they already have one here.
            </span>
          </label>
          <label className="flex flex-col gap-1 text-xs font-medium text-secondary">
            Role
            <select
              value={form.role}
              onChange={(e) => setForm({ ...form, role: e.target.value })}
              className="h-8 rounded border border-line bg-surface px-2 text-sm font-normal text-primary"
            >
              {ROLES.map((r) => (
                <option key={r.value} value={r.value}>
                  {r.label} — {r.hint}
                </option>
              ))}
            </select>
          </label>
          <div className="flex gap-2 sm:col-span-2">
            <Button
              type="submit"
              size="sm"
              variant="primary"
              loading={add.isPending}
              disabled={!form.name.trim() || !form.email.trim()}
            >
              Add member
            </Button>
            <Button type="button" size="sm" variant="ghost" onClick={() => setAdding(false)}>
              Cancel
            </Button>
          </div>
        </form>
      )}

      <div className="mt-4">
        {members.isPending && <LoadingState label="Loading members" />}
        {members.isSuccess && (
          <ul className="divide-y divide-line">
            {members.data.map((member) => (
              <li key={member.id} className="flex items-center gap-3 py-2">
                <span
                  aria-hidden="true"
                  className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-accent-subtle text-xs font-medium text-accent-text"
                >
                  {(member.name || member.email || '?').slice(0, 1).toUpperCase()}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm text-primary">{member.name}</span>
                  <span className="block truncate text-xs text-tertiary">{member.email}</span>
                </span>
                <select
                  value={member.role}
                  aria-label={`Role for ${member.name}`}
                  onChange={(event) =>
                    changeRole.mutate({ userId: member.userId, role: event.target.value })
                  }
                  className="h-7 rounded border border-line bg-surface px-1 text-sm"
                >
                  {/* Legacy roles show as themselves so the select is never lying about state. */}
                  {!ROLES.some((r) => r.value === member.role) && (
                    <option value={member.role}>{member.role}</option>
                  )}
                  {ROLES.map((r) => (
                    <option key={r.value} value={r.value}>
                      {r.label}
                    </option>
                  ))}
                </select>
                <button
                  type="button"
                  aria-label={`Remove ${member.name}`}
                  onClick={() => {
                    if (window.confirm(`Remove ${member.name} from this organization?`)) {
                      remove.mutate(member.userId);
                    }
                  }}
                  className="px-1 text-tertiary hover:text-danger-text"
                >
                  ✕
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </Card>
  );
}

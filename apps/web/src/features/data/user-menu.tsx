'use client';

import { useMutation, useQuery } from '@tanstack/react-query';
import Link from 'next/link';
import { useState } from 'react';

import { dataApi } from '@/features/data/api';
import { apiPost } from '@/lib/api-client';

/**
 * The signed-in chip at the top right: avatar initial + name, opening a small account menu with
 * Settings and Sign out. Sign out really signs out — the server revokes the session cookie and
 * the browser lands back on the login page with no state left behind.
 */
export function UserMenu() {
  const [open, setOpen] = useState(false);

  const me = useQuery({
    queryKey: ['me'],
    queryFn: () => dataApi.me(),
    retry: false,
    staleTime: 5 * 60 * 1000,
  });

  const signOut = useMutation({
    mutationFn: () => apiPost('/v1/auth/logout', {}),
    onSettled: () => {
      // Even if the request failed the cookie may be gone; the login page is the honest place.
      window.location.href = '/login';
    },
  });

  if (!me.data) return null;
  const initial = (me.data.name || me.data.email || '?').slice(0, 1).toUpperCase();

  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-label="Account menu"
        className="flex items-center gap-2 rounded-full py-1 pl-1 pr-2 hover:bg-sunken"
      >
        <span
          aria-hidden="true"
          className="flex h-7 w-7 items-center justify-center rounded-full bg-accent text-xs font-semibold text-inverted"
        >
          {initial}
        </span>
        <span className="hidden max-w-[10rem] truncate text-sm text-primary sm:block">{me.data.name}</span>
        <span aria-hidden="true" className="text-xs text-tertiary">▾</span>
      </button>

      {open && (
        <>
          <button
            type="button"
            aria-label="Close account menu"
            onClick={() => setOpen(false)}
            className="fixed inset-0 z-40 cursor-default"
          />
          <div className="absolute right-0 top-full z-50 mt-1.5 w-60 rounded-lg border border-line bg-surface p-1.5 shadow-lg">
            <div className="border-b border-line px-2.5 pb-2 pt-1">
              <p className="truncate text-sm font-medium text-primary">{me.data.name}</p>
              <p className="truncate text-xs text-tertiary">{me.data.email}</p>
              {me.data.isSuperAdmin && (
                <span className="mt-1 inline-block rounded-full bg-accent-subtle px-2 py-0.5 text-2xs font-medium text-accent-text">
                  Super admin
                </span>
              )}
            </div>
            <Link
              href="/app/settings"
              onClick={() => setOpen(false)}
              className="mt-1 block rounded px-2.5 py-1.5 text-sm text-primary hover:bg-sunken"
            >
              Settings
            </Link>
            <button
              type="button"
              onClick={() => signOut.mutate()}
              disabled={signOut.isPending}
              className="mt-0.5 block w-full rounded px-2.5 py-1.5 text-left text-sm text-danger-text hover:bg-sunken"
            >
              {signOut.isPending ? 'Signing out…' : 'Sign out'}
            </button>
          </div>
        </>
      )}
    </div>
  );
}

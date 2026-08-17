'use client';

import { useQuery } from '@tanstack/react-query';
import Link from 'next/link';

import { dataApi } from '@/features/data/api';

/**
 * The platform-console link — rendered only for super admins, so ordinary members never learn
 * the console exists. The server independently 404s them anyway; this is presentation, not
 * security.
 */
export function AdminLink() {
  const me = useQuery({
    queryKey: ['me'],
    queryFn: () => dataApi.me(),
    retry: false,
    staleTime: 5 * 60 * 1000,
  });

  if (!me.data?.isSuperAdmin) return null;

  return (
    <Link
      href="/app/admin"
      className="rounded-md border border-white/20 bg-white/10 px-2.5 py-1 text-xs font-medium text-white backdrop-blur transition hover:bg-white/20"
    >
      ⛨ Admin
    </Link>
  );
}

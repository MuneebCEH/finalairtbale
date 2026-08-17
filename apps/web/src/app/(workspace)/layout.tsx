import Link from 'next/link';

import { ThemeToggle } from '@/components/theme';
import { AdminLink } from '@/features/data/admin-link';
import { UserMenu } from '@/features/data/user-menu';

/**
 * The authenticated shell.
 *
 * Kept intentionally thin. Session enforcement is not done here — a layout is the wrong place
 * for it, because a redirect in a layout does not protect the API and produces a confusing
 * flash. The API returns 401 for anything unauthenticated and the client redirects on that,
 * which means the authorization decision lives in exactly one place: the server.
 */
export default function WorkspaceLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex min-h-screen flex-col bg-canvas">
      {/* The brand bar: deep teal, white type — unmistakably this app, in light and dark alike.
          Height stays 3rem: the pinned grid page below depends on it. */}
      <header className="sticky top-0 z-30 bg-gradient-to-r from-slate-900 via-teal-900 to-slate-900 text-white shadow-md">
        <div className="mx-auto flex h-12 max-w-7xl items-center justify-between gap-4 px-6">
          <Link href="/app" className="flex items-center gap-2 text-white">
            <svg width="20" height="20" viewBox="0 0 26 26" aria-hidden="true" className="text-teal-300">
              <rect x="1" y="1" width="10" height="10" rx="2" fill="currentColor" opacity="0.9" />
              <rect x="14" y="1" width="10" height="10" rx="2" fill="currentColor" opacity="0.45" />
              <rect x="1" y="14" width="10" height="10" rx="2" fill="currentColor" opacity="0.45" />
              <rect x="15.5" y="15.5" width="9" height="9" rx="2" fill="currentColor" />
            </svg>
            <span className="text-sm font-semibold tracking-tight">Tessera</span>
          </Link>

          <nav aria-label="Account" className="flex items-center gap-2.5">
            <ThemeToggle />
            <AdminLink />
            <UserMenu />
          </nav>
        </div>
      </header>

      {children}
    </div>
  );
}

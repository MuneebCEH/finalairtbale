import Link from 'next/link';

import { ThemeToggle } from '@/components/theme';
import { AdminLink } from '@/features/data/admin-link';

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
      <header className="sticky top-0 z-30 border-b border-line bg-surface/85 backdrop-blur">
        <div className="mx-auto flex h-12 max-w-7xl items-center justify-between gap-4 px-6">
          <Link href="/app" className="flex items-center gap-2 text-primary">
            <svg width="20" height="20" viewBox="0 0 26 26" aria-hidden="true" className="text-accent">
              <rect x="1" y="1" width="10" height="10" rx="2" fill="currentColor" opacity="0.9" />
              <rect x="14" y="1" width="10" height="10" rx="2" fill="currentColor" opacity="0.45" />
              <rect x="1" y="14" width="10" height="10" rx="2" fill="currentColor" opacity="0.45" />
              <rect x="15.5" y="15.5" width="9" height="9" rx="2" fill="currentColor" />
            </svg>
            <span className="text-sm font-semibold tracking-tight">Tessera</span>
          </Link>

          <nav aria-label="Account" className="flex items-center gap-3">
            <ThemeToggle />
            <AdminLink />
            <Link
              href="/app/settings"
              className="text-sm text-secondary transition-colors duration-fast hover:text-primary"
            >
              Settings
            </Link>
          </nav>
        </div>
      </header>

      {children}
    </div>
  );
}

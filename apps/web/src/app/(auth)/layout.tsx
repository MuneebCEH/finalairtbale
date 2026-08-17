import Link from 'next/link';

import { ThemeToggle } from '@/components/theme';

export default function AuthLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="relative flex min-h-screen flex-col overflow-hidden bg-canvas">
      {/* A quiet brand wash behind the card — colour without noise. */}
      <div
        aria-hidden="true"
        className="pointer-events-none absolute -top-40 left-1/2 h-96 w-[60rem] -translate-x-1/2 rounded-full bg-accent-subtle/50 blur-3xl"
      />
      <header className="flex items-center justify-between px-6 py-5">
        <Link href="/" className="flex items-center gap-2 text-primary">
          <svg width="22" height="22" viewBox="0 0 26 26" aria-hidden="true" className="text-accent">
            <rect x="1" y="1" width="10" height="10" rx="2" fill="currentColor" opacity="0.9" />
            <rect x="14" y="1" width="10" height="10" rx="2" fill="currentColor" opacity="0.45" />
            <rect x="1" y="14" width="10" height="10" rx="2" fill="currentColor" opacity="0.45" />
            <rect x="15.5" y="15.5" width="9" height="9" rx="2" fill="currentColor" />
          </svg>
          <span className="text-base font-semibold tracking-tight">Tessera</span>
        </Link>
        <ThemeToggle />
      </header>

      <main id="main" className="relative flex flex-1 items-start justify-center px-6 pb-16 pt-6">
        <div className="w-full max-w-sm rounded-2xl border border-line bg-surface p-6 shadow-mid">
          {children}
        </div>
      </main>
    </div>
  );
}

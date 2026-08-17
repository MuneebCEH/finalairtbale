import type { ReactNode } from 'react';

/**
 * The bold page banner every chrome page shares: a deep teal gradient, a glass icon tile, white
 * type, and the page's actions sitting on the banner itself. One component so the whole app
 * speaks one visual language — the grid keeps its own quiet look on purpose.
 */
export function PageHero({
  icon,
  title,
  subtitle,
  actions,
}: {
  icon: ReactNode;
  title: ReactNode;
  subtitle?: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <header className="relative overflow-hidden rounded-2xl bg-gradient-to-br from-teal-800 via-teal-700 to-cyan-700 p-6 text-white shadow-lg">
      {/* Soft light blooms so the banner reads designed, not flat. */}
      <div aria-hidden="true" className="pointer-events-none absolute -right-16 -top-20 h-56 w-56 rounded-full bg-cyan-300/20 blur-2xl" />
      <div aria-hidden="true" className="pointer-events-none absolute -bottom-24 left-24 h-48 w-48 rounded-full bg-teal-300/10 blur-2xl" />

      <div className="relative flex flex-wrap items-center justify-between gap-4">
        <div className="flex min-w-0 items-center gap-4">
          <span
            aria-hidden="true"
            className="flex h-14 w-14 shrink-0 items-center justify-center rounded-2xl border border-white/20 bg-white/15 text-2xl shadow-inner backdrop-blur"
          >
            {icon}
          </span>
          <div className="min-w-0">
            <h1 className="truncate text-2xl font-bold tracking-tight">{title}</h1>
            {subtitle && <p className="mt-1 text-sm text-teal-50/80">{subtitle}</p>}
          </div>
        </div>
        {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
      </div>
    </header>
  );
}

/** A white action button that sits correctly on the hero gradient. */
export function HeroButton({
  children,
  onClick,
  primary = false,
}: {
  children: ReactNode;
  onClick: () => void;
  primary?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={
        primary
          ? 'rounded-lg bg-white px-3.5 py-2 text-sm font-semibold text-teal-800 shadow-sm transition hover:bg-teal-50'
          : 'rounded-lg border border-white/30 bg-white/10 px-3.5 py-2 text-sm font-medium text-white backdrop-blur transition hover:bg-white/20'
      }
    >
      {children}
    </button>
  );
}

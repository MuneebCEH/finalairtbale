import Link from 'next/link';

/**
 * The unauthenticated entry point.
 *
 * Deliberately a server component with no client JavaScript beyond the shared bundle: this is
 * the first paint a new visitor sees, and it should not wait on hydration.
 */
export default function HomePage() {
  return (
    <main id="main" className="mx-auto flex min-h-screen max-w-3xl flex-col justify-center px-6 py-16">
      <div className="flex items-center gap-2.5">
        <TesseraMark />
        <span className="text-lg font-semibold tracking-tight text-primary">Tessera</span>
      </div>

      <h1 className="mt-10 text-3xl font-semibold tracking-tight text-primary">
        A database that behaves like a spreadsheet.
      </h1>

      <p className="mt-4 max-w-xl text-md text-secondary">
        Model your work as tables and relationships, edit it in a grid your team already knows how
        to use, and automate the parts nobody should be doing by hand.
      </p>

      <div className="mt-8 flex flex-wrap gap-3">
        <Link
          href="/register"
          className="inline-flex h-10 items-center rounded bg-accent px-4 text-base font-medium text-inverted transition-colors duration-fast hover:bg-accent-hover"
        >
          Create an account
        </Link>
        <Link
          href="/login"
          className="inline-flex h-10 items-center rounded border border-line bg-surface px-4 text-base font-medium text-primary transition-colors duration-fast hover:bg-sunken"
        >
          Sign in
        </Link>
      </div>

      <dl className="mt-16 grid gap-6 sm:grid-cols-3">
        {[
          {
            term: 'Relational, not flat',
            detail:
              'Linked records, lookups, and rollups that stay correct when the data underneath them changes.',
          },
          {
            term: 'Built for large tables',
            detail:
              'Server-side filtering and a virtualised grid, so a million rows behaves like a hundred.',
          },
          {
            term: 'Permissions that hold',
            detail:
              'Enforced on the server at every level, from organization down to individual fields.',
          },
        ].map((item) => (
          <div key={item.term}>
            <dt className="text-sm font-medium text-primary">{item.term}</dt>
            <dd className="mt-1 text-sm text-secondary">{item.detail}</dd>
          </div>
        ))}
      </dl>
    </main>
  );
}

/** The product mark: four tiles, one offset — a tessera set into a mosaic. */
function TesseraMark() {
  return (
    <svg width="26" height="26" viewBox="0 0 26 26" aria-hidden="true" className="text-accent">
      <rect x="1" y="1" width="10" height="10" rx="2" fill="currentColor" opacity="0.9" />
      <rect x="14" y="1" width="10" height="10" rx="2" fill="currentColor" opacity="0.45" />
      <rect x="1" y="14" width="10" height="10" rx="2" fill="currentColor" opacity="0.45" />
      <rect x="15.5" y="15.5" width="9" height="9" rx="2" fill="currentColor" />
    </svg>
  );
}

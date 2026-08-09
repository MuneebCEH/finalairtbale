import type { Metadata } from 'next';
import Link from 'next/link';

export const metadata: Metadata = { title: 'Terms of service' };

/**
 * Placeholder for the terms of service.
 *
 * Deliberately not filled with invented legal text. A plausible-looking contract that no lawyer
 * has reviewed is worse than an obviously absent one: it looks binding, it is quoted back at
 * you, and nobody notices it was never approved. This page states plainly that the document is
 * outstanding, and the registration flow links here so the gap is visible rather than hidden.
 *
 * Replace the body with counsel-approved text before any public launch.
 */
export default function TermsPage() {
  return (
    <main id="main" className="mx-auto max-w-2xl px-6 py-16">
      <h1 className="text-2xl font-semibold tracking-tight text-primary">Terms of service</h1>

      <div className="mt-4 rounded border border-warning/25 bg-warning-subtle p-4 text-sm text-warning-text">
        <p className="font-medium">Not yet published.</p>
        <p className="mt-1">
          This deployment is pre-release. A counsel-reviewed terms of service must be published
          here before the platform is offered to the public.
        </p>
      </div>

      <p className="mt-6 text-sm text-secondary">
        If you are evaluating this deployment and need to know how your data is handled in the
        meantime, the technical controls are documented in the repository under{' '}
        <code className="font-mono text-xs">docs/03-security-and-permissions.md</code>.
      </p>

      <Link href="/" className="mt-8 inline-block text-sm text-accent-text hover:underline">
        Back to home
      </Link>
    </main>
  );
}

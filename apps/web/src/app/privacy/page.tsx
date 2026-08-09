import type { Metadata } from 'next';
import Link from 'next/link';

export const metadata: Metadata = { title: 'Privacy policy' };

/**
 * Placeholder for the privacy policy. See the note in `terms/page.tsx` — inventing privacy
 * commitments the operator has not actually reviewed would be worse than stating their absence,
 * because a privacy policy is a representation to users and, under GDPR, to regulators.
 *
 * What the platform *technically* does with personal data is real and documented; that is
 * summarised below because it is verifiable from the code.
 */
export default function PrivacyPage() {
  return (
    <main id="main" className="mx-auto max-w-2xl px-6 py-16">
      <h1 className="text-2xl font-semibold tracking-tight text-primary">Privacy policy</h1>

      <div className="mt-4 rounded border border-warning/25 bg-warning-subtle p-4 text-sm text-warning-text">
        <p className="font-medium">Not yet published.</p>
        <p className="mt-1">
          This deployment is pre-release. A counsel-reviewed privacy policy, naming the data
          controller and sub-processors, must be published here before the platform is offered to
          the public.
        </p>
      </div>

      <h2 className="mt-8 text-md font-medium text-primary">What the software does today</h2>
      <p className="mt-2 text-sm text-secondary">
        These are properties of the implementation, verifiable in the source, not commitments made
        on behalf of any operator:
      </p>
      <ul className="mt-3 space-y-2 text-sm text-secondary">
        <li>
          Accounts store an email address, a display name, and an Argon2id password hash. Plain
          passwords are never stored or logged.
        </li>
        <li>
          Sessions record an IP address and user agent so you can review and revoke your own
          devices. They are deleted 30 days after expiry.
        </li>
        <li>
          Privileged actions are recorded in an append-only audit log scoped to the organization
          they occurred in.
        </li>
        <li>
          Logs redact credentials by key name and by value shape before they reach any sink.
        </li>
        <li>
          Data export and account deletion are implemented as first-class background jobs.
        </li>
      </ul>

      <Link href="/" className="mt-8 inline-block text-sm text-accent-text hover:underline">
        Back to home
      </Link>
    </main>
  );
}

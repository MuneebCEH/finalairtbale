'use client';

import Link from 'next/link';
import { useState } from 'react';

import { Button } from '@/components/ui/button';
import { Alert, Card } from '@/components/ui/feedback';
import { Field } from '@/components/ui/field';
import { ApiError, apiPost } from '@/lib/api-client';

export default function ForgotPasswordPage() {
  const [email, setEmail] = useState('');
  const [sent, setSent] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const submit = async (event: React.FormEvent): Promise<void> => {
    event.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      await apiPost('/v1/auth/password/forgot', { email });
      // Success is shown regardless of whether the address exists. The confirmation deliberately
      // says "if that address has an account" — matching the API, which never discloses it.
      setSent(true);
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : 'Something went wrong.');
    } finally {
      setSubmitting(false);
    }
  };

  if (sent) {
    return (
      <Card className="p-6">
        <h1 className="text-xl font-semibold tracking-tight text-primary">Check your inbox</h1>
        <p className="mt-2 text-sm text-secondary">
          If <span className="font-medium text-primary">{email}</span> has an account, a reset link
          is on its way. It is valid for 30 minutes and can be used once.
        </p>
        <Link href="/login" className="mt-5 inline-block text-sm text-accent-text hover:underline">
          Back to sign in
        </Link>
      </Card>
    );
  }

  return (
    <Card className="p-6">
      <h1 className="text-xl font-semibold tracking-tight text-primary">Reset your password</h1>
      <p className="mt-1 text-sm text-secondary">
        Enter your email and we will send you a link to choose a new one.
      </p>

      {error && (
        <Alert tone="danger" className="mt-4">
          {error}
        </Alert>
      )}

      <form onSubmit={submit} className="mt-5 space-y-4">
        <Field
          label="Email"
          type="email"
          autoComplete="email"
          required
          autoFocus
          value={email}
          onChange={(event) => setEmail(event.target.value)}
        />
        <Button type="submit" variant="primary" fullWidth loading={submitting}>
          Send reset link
        </Button>
      </form>

      <Link href="/login" className="mt-5 inline-block text-sm text-secondary hover:text-primary">
        Back to sign in
      </Link>
    </Card>
  );
}

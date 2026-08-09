'use client';

import { zodResolver } from '@hookform/resolvers/zod';
import { loginSchema, type LoginInput } from '@tessera/validation';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { useForm } from 'react-hook-form';

import { Button } from '@/components/ui/button';
import { Alert, Card } from '@/components/ui/feedback';
import { Field } from '@/components/ui/field';
import { ApiError, apiPost } from '@/lib/api-client';

/**
 * Sign in.
 *
 * The same Zod schema validates here and on the server, so the client cannot show a form as
 * valid that the API will reject — and, more importantly, the server never trusts this check.
 * Client validation is an ergonomic shortcut; it is not a control.
 */
export default function LoginPage() {
  const router = useRouter();
  const [formError, setFormError] = useState<string | null>(null);
  const [mfaToken, setMfaToken] = useState<string | null>(null);

  const {
    register,
    handleSubmit,
    formState: { errors, isSubmitting },
  } = useForm<LoginInput>({
    resolver: zodResolver(loginSchema),
    defaultValues: { email: '', password: '', rememberMe: false },
  });

  const onSubmit = handleSubmit(async (values) => {
    setFormError(null);
    try {
      await apiPost('/v1/auth/login', values);
      // A full navigation rather than a client push: the session cookie was just set, and the
      // next request must carry it.
      router.replace('/app');
      router.refresh();
    } catch (error) {
      if (error instanceof ApiError) {
        if (error.code === 'MFA_REQUIRED') {
          setMfaToken((error.details?.['mfaToken'] as string | undefined) ?? null);
          return;
        }
        setFormError(error.message);
        return;
      }
      setFormError('Something went wrong. Please try again.');
    }
  });

  if (mfaToken) {
    return <MfaStep mfaToken={mfaToken} onCancel={() => setMfaToken(null)} />;
  }

  return (
    <Card className="p-6">
      <h1 className="text-xl font-semibold tracking-tight text-primary">Sign in</h1>
      <p className="mt-1 text-sm text-secondary">Welcome back.</p>

      {formError && (
        <Alert tone="danger" className="mt-4">
          {formError}
        </Alert>
      )}

      <form onSubmit={onSubmit} className="mt-5 space-y-4" noValidate>
        <Field
          label="Email"
          type="email"
          autoComplete="email"
          required
          {...(errors.email?.message ? { error: errors.email.message } : {})}
          {...register('email')}
        />

        <Field
          label="Password"
          type="password"
          autoComplete="current-password"
          required
          {...(errors.password?.message ? { error: errors.password.message } : {})}
          {...register('password')}
        />

        <label className="flex items-center gap-2 text-sm text-secondary">
          <input
            type="checkbox"
            className="h-4 w-4 rounded border-line text-accent"
            {...register('rememberMe')}
          />
          Keep me signed in on this device
        </label>

        <Button type="submit" variant="primary" fullWidth loading={isSubmitting}>
          Sign in
        </Button>
      </form>

      <div className="mt-5 flex items-center justify-between text-sm">
        <Link href="/forgot-password" className="text-accent-text hover:underline">
          Forgot your password?
        </Link>
        <Link href="/register" className="text-secondary hover:text-primary">
          Create an account
        </Link>
      </div>
    </Card>
  );
}

function MfaStep({ mfaToken, onCancel }: { mfaToken: string; onCancel: () => void }) {
  const router = useRouter();
  const [code, setCode] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const submit = async (event: React.FormEvent): Promise<void> => {
    event.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      await apiPost('/v1/auth/mfa/verify', { mfaToken, code: code.trim() });
      router.replace('/app');
      router.refresh();
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : 'That code was not accepted.');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Card className="p-6">
      <h1 className="text-xl font-semibold tracking-tight text-primary">Two-factor verification</h1>
      <p className="mt-1 text-sm text-secondary">
        Enter the six-digit code from your authenticator app, or one of your recovery codes.
      </p>

      {error && (
        <Alert tone="danger" className="mt-4">
          {error}
        </Alert>
      )}

      <form onSubmit={submit} className="mt-5 space-y-4">
        <Field
          label="Verification code"
          inputMode="numeric"
          autoComplete="one-time-code"
          autoFocus
          value={code}
          onChange={(event) => setCode(event.target.value)}
          className="font-mono tracking-widest"
          required
        />
        <Button type="submit" variant="primary" fullWidth loading={submitting}>
          Verify
        </Button>
        <Button type="button" variant="ghost" fullWidth onClick={onCancel}>
          Back
        </Button>
      </form>
    </Card>
  );
}

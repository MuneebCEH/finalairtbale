'use client';

import { zodResolver } from '@hookform/resolvers/zod';
import { registerSchema, type RegisterInput } from '@tessera/validation';
import Link from 'next/link';
import { useState } from 'react';
import { useForm } from 'react-hook-form';

import { Button } from '@/components/ui/button';
import { Alert, Card } from '@/components/ui/feedback';
import { Field } from '@/components/ui/field';
import { ApiError, apiPost } from '@/lib/api-client';

export default function RegisterPage() {
  const [formError, setFormError] = useState<string | null>(null);
  const [submitted, setSubmitted] = useState(false);

  const {
    register,
    handleSubmit,
    watch,
    setError,
    formState: { errors, isSubmitting },
  } = useForm<RegisterInput>({
    resolver: zodResolver(registerSchema),
    defaultValues: { email: '', password: '', name: '', acceptedTerms: true, marketingOptIn: false },
  });

  const password = watch('password') ?? '';

  const onSubmit = handleSubmit(async (values) => {
    setFormError(null);
    try {
      await apiPost('/v1/auth/register', values);
      setSubmitted(true);
    } catch (error) {
      if (error instanceof ApiError) {
        // The API returns field-level issues; map them back onto the form so each message lands
        // next to the input it concerns rather than in a generic banner.
        const fieldErrors = error.fieldErrors;
        const known = Object.entries(fieldErrors).filter(([path]) =>
          ['email', 'password', 'name'].includes(path),
        );
        if (known.length > 0) {
          for (const [path, message] of known) {
            setError(path as keyof RegisterInput, { message });
          }
          return;
        }
        setFormError(error.message);
        return;
      }
      setFormError('Something went wrong. Please try again.');
    }
  });

  if (submitted) {
    return (
      <Card className="p-6">
        <h1 className="text-xl font-semibold tracking-tight text-primary">Check your inbox</h1>
        <p className="mt-2 text-sm text-secondary">
          If that address can be used, a confirmation link is on its way. Open it to finish setting
          up your account. The link is valid for 24 hours.
        </p>
        <Link
          href="/login"
          className="mt-5 inline-block text-sm text-accent-text hover:underline"
        >
          Back to sign in
        </Link>
      </Card>
    );
  }

  return (
    <Card className="p-6">
      <h1 className="text-xl font-semibold tracking-tight text-primary">Create your account</h1>
      <p className="mt-1 text-sm text-secondary">Free to start. No card required.</p>

      {formError && (
        <Alert tone="danger" className="mt-4">
          {formError}
        </Alert>
      )}

      <form onSubmit={onSubmit} className="mt-5 space-y-4" noValidate>
        <Field
          label="Your name"
          autoComplete="name"
          required
          {...(errors.name?.message ? { error: errors.name.message } : {})}
          {...register('name')}
        />

        <Field
          label="Work email"
          type="email"
          autoComplete="email"
          required
          {...(errors.email?.message ? { error: errors.email.message } : {})}
          {...register('email')}
        />

        <div>
          <Field
            label="Password"
            type="password"
            autoComplete="new-password"
            required
            hint="At least 12 characters."
            {...(errors.password?.message ? { error: errors.password.message } : {})}
            {...register('password')}
          />
          <PasswordStrength value={password} />
        </div>

        <p className="text-xs text-tertiary">
          By creating an account you agree to the{' '}
          <Link href="/terms" className="text-accent-text hover:underline">
            terms of service
          </Link>{' '}
          and{' '}
          <Link href="/privacy" className="text-accent-text hover:underline">
            privacy policy
          </Link>
          .
        </p>

        <Button type="submit" variant="primary" fullWidth loading={isSubmitting}>
          Create account
        </Button>
      </form>

      <p className="mt-5 text-sm text-secondary">
        Already have an account?{' '}
        <Link href="/login" className="text-accent-text hover:underline">
          Sign in
        </Link>
      </p>
    </Card>
  );
}

/**
 * A strength indicator driven by length and character variety.
 *
 * Length dominates the score because it dominates real strength — a 20-character passphrase of
 * lowercase words beats "P@ss1!" comfortably, and a meter that says otherwise teaches people the
 * wrong lesson. The bar is paired with a text label so the signal is not colour-only.
 */
function PasswordStrength({ value }: { value: string }) {
  if (!value) return null;

  const variety =
    Number(/[a-z]/.test(value)) +
    Number(/[A-Z]/.test(value)) +
    Number(/\d/.test(value)) +
    Number(/[^A-Za-z0-9]/.test(value));

  const lengthScore = value.length >= 20 ? 3 : value.length >= 16 ? 2 : value.length >= 12 ? 1 : 0;
  const score = Math.min(4, lengthScore + Math.floor(variety / 2));

  const levels = [
    { label: 'Too short', tone: 'bg-danger' },
    { label: 'Weak', tone: 'bg-danger' },
    { label: 'Fair', tone: 'bg-warning' },
    { label: 'Good', tone: 'bg-success' },
    { label: 'Strong', tone: 'bg-success' },
  ] as const;

  const level = levels[score] ?? levels[0];

  return (
    <div className="mt-2 flex items-center gap-2" aria-live="polite">
      <div className="flex h-1 flex-1 gap-1" aria-hidden="true">
        {[0, 1, 2, 3].map((index) => (
          <div
            key={index}
            className={`flex-1 rounded-full ${index < score ? level.tone : 'bg-sunken'}`}
          />
        ))}
      </div>
      <span className="text-xs text-tertiary">{level.label}</span>
    </div>
  );
}

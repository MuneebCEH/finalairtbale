'use client';

import type { ReactNode } from 'react';

import { cn } from '@/lib/cn';

/**
 * Every non-happy path a screen can be in, as first-class components.
 *
 * These exist as primitives rather than ad-hoc markup because loading, empty, and error states
 * are the ones most often skipped under deadline pressure — and they are exactly the states a
 * user hits when something is already going wrong. Making them one import each removes the
 * excuse.
 */

type Tone = 'info' | 'success' | 'warning' | 'danger';

const TONES: Record<Tone, { container: string; icon: string; label: string }> = {
  info: { container: 'bg-accent-subtle border-accent/25 text-accent-text', icon: 'i', label: 'Note' },
  success: {
    container: 'bg-success-subtle border-success/25 text-success-text',
    icon: '✓',
    label: 'Success',
  },
  warning: {
    container: 'bg-warning-subtle border-warning/25 text-warning-text',
    icon: '⚠',
    label: 'Warning',
  },
  danger: {
    container: 'bg-danger-subtle border-danger/25 text-danger-text',
    icon: '⚠',
    label: 'Error',
  },
};

export function Alert({
  tone = 'info',
  title,
  children,
  className,
}: {
  tone?: Tone;
  title?: string;
  children?: ReactNode;
  className?: string;
}) {
  const config = TONES[tone];
  return (
    <div
      // Errors and warnings interrupt; informational messages do not. Marking everything
      // `alert` trains users to ignore the live region entirely.
      role={tone === 'danger' || tone === 'warning' ? 'alert' : 'status'}
      className={cn('flex gap-2.5 rounded border p-3 text-sm', config.container, className)}
    >
      <span aria-hidden="true" className="mt-px shrink-0 font-semibold">
        {config.icon}
      </span>
      <div className="min-w-0 flex-1">
        {/* The tone is also stated in text, so meaning does not rely on colour alone. */}
        <span className="sr-only">{config.label}: </span>
        {title && <p className="font-medium">{title}</p>}
        {children && <div className={cn(title && 'mt-0.5', 'text-secondary')}>{children}</div>}
      </div>
    </div>
  );
}

export function Skeleton({ className }: { className?: string }) {
  return (
    <div
      aria-hidden="true"
      className={cn('relative overflow-hidden rounded bg-sunken', className)}
    >
      <div className="absolute inset-0 -translate-x-full animate-shimmer bg-gradient-to-r from-transparent via-surface/60 to-transparent" />
    </div>
  );
}

/**
 * A loading placeholder that announces itself.
 *
 * The visible skeleton is `aria-hidden` and a polite live region carries the message, so a
 * screen-reader user is told the page is loading instead of hearing nothing at all.
 */
export function LoadingState({ label = 'Loading' }: { label?: string }) {
  return (
    <div className="space-y-3" role="status" aria-live="polite">
      <span className="sr-only">{label}</span>
      <Skeleton className="h-8 w-1/3" />
      <Skeleton className="h-20 w-full" />
      <Skeleton className="h-20 w-full" />
    </div>
  );
}

export function EmptyState({
  title,
  description,
  action,
  icon,
}: {
  title: string;
  description?: string;
  action?: ReactNode;
  icon?: ReactNode;
}) {
  return (
    <div className="flex flex-col items-center justify-center rounded-md border border-dashed border-line px-6 py-12 text-center">
      {icon && (
        <div aria-hidden="true" className="mb-3 text-tertiary">
          {icon}
        </div>
      )}
      <h3 className="text-md font-medium text-primary">{title}</h3>
      {description && <p className="mt-1 max-w-sm text-sm text-secondary">{description}</p>}
      {action && <div className="mt-4">{action}</div>}
    </div>
  );
}

/**
 * The error state.
 *
 * Always surfaces the request id. It is the single most useful thing a user can paste into a
 * support conversation, and it costs one line to show.
 */
export function ErrorState({
  title = 'Something went wrong',
  message,
  requestId,
  onRetry,
}: {
  title?: string;
  message: string;
  requestId?: string;
  onRetry?: () => void;
}) {
  return (
    <Alert tone="danger" title={title}>
      <p>{message}</p>
      {requestId && requestId !== 'network' && (
        <p className="mt-1.5 font-mono text-2xs text-tertiary">Reference: {requestId}</p>
      )}
      {onRetry && (
        <button
          type="button"
          onClick={onRetry}
          className="mt-2 text-sm font-medium underline underline-offset-2"
        >
          Try again
        </button>
      )}
    </Alert>
  );
}

export function Card({
  children,
  className,
  as: Tag = 'div',
}: {
  children: ReactNode;
  className?: string;
  as?: 'div' | 'section' | 'article' | 'li';
}) {
  return (
    <Tag className={cn('rounded-md border border-line bg-surface shadow-low', className)}>
      {children}
    </Tag>
  );
}

'use client';

import { forwardRef, useId, type InputHTMLAttributes, type ReactNode } from 'react';

import { cn } from '@/lib/cn';

export interface FieldProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'id'> {
  readonly label: string;
  readonly hint?: string;
  readonly error?: string;
  readonly trailing?: ReactNode;
  /** Hides the label visually while keeping it for assistive technology. */
  readonly labelHidden?: boolean;
}

/**
 * A labelled text input.
 *
 * The wiring here is the reason this component exists rather than callers assembling
 * `<label>` + `<input>` themselves each time:
 *
 *  • The label is always associated by `htmlFor`/`id` — never by wrapping, which breaks when a
 *    trailing element is added later.
 *  • `aria-describedby` points at the hint *and* the error, so a screen reader announces both.
 *  • `aria-invalid` marks the field, and the error is in a `role="alert"` live region so it is
 *    announced when it appears rather than only being visible.
 *  • The error is never conveyed by red border alone (WCAG 1.4.1): there is always text.
 */
export const Field = forwardRef<HTMLInputElement, FieldProps>(function Field(
  { label, hint, error, trailing, labelHidden, className, required, ...rest },
  ref,
) {
  const id = useId();
  const hintId = `${id}-hint`;
  const errorId = `${id}-error`;

  const describedBy = [hint ? hintId : null, error ? errorId : null].filter(Boolean).join(' ');

  return (
    <div className="flex flex-col gap-1.5">
      <label
        htmlFor={id}
        className={cn(
          'text-sm font-medium text-secondary',
          labelHidden && 'sr-only',
        )}
      >
        {label}
        {required && (
          <span className="ml-0.5 text-danger-text" aria-hidden="true">
            *
          </span>
        )}
      </label>

      <div className="relative">
        <input
          ref={ref}
          id={id}
          required={required}
          aria-invalid={error ? true : undefined}
          aria-describedby={describedBy || undefined}
          className={cn(
            'h-9 w-full rounded border bg-surface px-2.5 text-base text-primary',
            'placeholder:text-tertiary',
            'transition-colors duration-fast',
            'disabled:cursor-not-allowed disabled:bg-sunken disabled:text-tertiary',
            error
              ? 'border-danger focus-visible:ring-danger'
              : 'border-line hover:border-line-strong',
            trailing && 'pr-9',
            className,
          )}
          {...rest}
        />
        {trailing && (
          <span className="absolute inset-y-0 right-0 flex items-center pr-2">{trailing}</span>
        )}
      </div>

      {hint && !error && (
        <p id={hintId} className="text-xs text-tertiary">
          {hint}
        </p>
      )}

      {error && (
        <p id={errorId} role="alert" className="flex items-start gap-1 text-xs text-danger-text">
          {/* A non-colour cue, so the error is perceivable without distinguishing red. */}
          <span aria-hidden="true">&#9888;</span>
          <span>{error}</span>
        </p>
      )}
    </div>
  );
});

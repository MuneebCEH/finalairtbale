'use client';

import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from 'react';

import { cn } from '@/lib/cn';

type Variant = 'primary' | 'secondary' | 'ghost' | 'danger' | 'link';
type Size = 'sm' | 'md' | 'lg';

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  readonly variant?: Variant;
  readonly size?: Size;
  readonly loading?: boolean;
  readonly leadingIcon?: ReactNode;
  readonly trailingIcon?: ReactNode;
  readonly fullWidth?: boolean;
}

const VARIANTS: Record<Variant, string> = {
  primary:
    'bg-accent text-inverted hover:bg-accent-hover active:bg-accent-hover disabled:bg-accent/50',
  secondary:
    'bg-surface text-primary border border-line hover:bg-sunken active:bg-sunken disabled:bg-surface',
  ghost: 'bg-transparent text-secondary hover:bg-sunken hover:text-primary active:bg-sunken',
  danger: 'bg-danger text-inverted hover:brightness-95 active:brightness-90',
  link: 'bg-transparent text-accent-text underline-offset-2 hover:underline p-0 h-auto',
};

const SIZES: Record<Size, string> = {
  sm: 'h-7 px-2.5 text-xs gap-1.5',
  md: 'h-8 px-3 text-sm gap-2',
  lg: 'h-10 px-4 text-base gap-2',
};

/**
 * The button primitive.
 *
 * Three accessibility behaviours are built in rather than left to callers, because in practice
 * callers forget all three:
 *
 *  • A loading button is `aria-busy` and disabled, so it cannot be double-submitted — the single
 *    most common cause of duplicate records in a form-driven product.
 *  • The spinner replaces the leading icon rather than being appended, so the button does not
 *    change width mid-interaction and shift the layout under the user's cursor.
 *  • Icons are `aria-hidden`; a button's accessible name always comes from its text. An
 *    icon-only button therefore requires an explicit `aria-label`, which TypeScript cannot
 *    enforce but review can spot.
 */
export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  {
    variant = 'secondary',
    size = 'md',
    loading = false,
    leadingIcon,
    trailingIcon,
    fullWidth = false,
    className,
    children,
    disabled,
    type = 'button',
    ...rest
  },
  ref,
) {
  return (
    <button
      ref={ref}
      type={type}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      className={cn(
        'inline-flex items-center justify-center rounded font-medium',
        'transition-colors duration-fast',
        'disabled:cursor-not-allowed disabled:opacity-60',
        VARIANTS[variant],
        variant !== 'link' && SIZES[size],
        fullWidth && 'w-full',
        className,
      )}
      {...rest}
    >
      {loading ? (
        <Spinner />
      ) : (
        leadingIcon && (
          <span aria-hidden="true" className="shrink-0">
            {leadingIcon}
          </span>
        )
      )}
      {children}
      {trailingIcon && !loading && (
        <span aria-hidden="true" className="shrink-0">
          {trailingIcon}
        </span>
      )}
    </button>
  );
});

function Spinner() {
  return (
    <svg
      className="h-3.5 w-3.5 shrink-0 animate-spin"
      viewBox="0 0 16 16"
      fill="none"
      aria-hidden="true"
    >
      <circle cx="8" cy="8" r="6.5" stroke="currentColor" strokeOpacity="0.25" strokeWidth="2.5" />
      <path
        d="M14.5 8a6.5 6.5 0 0 0-6.5-6.5"
        stroke="currentColor"
        strokeWidth="2.5"
        strokeLinecap="round"
      />
    </svg>
  );
}

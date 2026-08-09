import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

/**
 * Composes class names, with later Tailwind utilities winning over earlier conflicting ones.
 *
 * Without the merge step, `cn('px-3', props.className)` silently ignores a caller's `px-6`
 * because both classes end up in the attribute and CSS order — not JSX order — decides. This is
 * the single most common source of "why won't this component accept my styling" confusion.
 */
export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}

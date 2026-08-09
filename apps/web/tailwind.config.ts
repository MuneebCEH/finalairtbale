import type { Config } from 'tailwindcss';

/**
 * The design system's Tailwind surface.
 *
 * Every colour is a CSS custom property rather than a literal, so light and dark themes are a
 * variable swap on `:root` and not a second set of utility classes on every element. That is
 * what keeps `dark:` prefixes out of feature code entirely — a component written once is correct
 * in both themes, which is the only way theme support survives contact with a growing codebase.
 *
 * The scale is deliberately tight. A dense data application needs a handful of well-chosen
 * surfaces and one accent, not sixty shades that drift apart over time.
 */
const config: Config = {
  content: ['./src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        // Surfaces, from furthest back to nearest front.
        canvas: 'rgb(var(--surface-canvas) / <alpha-value>)',
        surface: 'rgb(var(--surface-default) / <alpha-value>)',
        raised: 'rgb(var(--surface-raised) / <alpha-value>)',
        sunken: 'rgb(var(--surface-sunken) / <alpha-value>)',
        overlay: 'rgb(var(--surface-overlay) / <alpha-value>)',

        // Text, by emphasis rather than by colour name.
        primary: 'rgb(var(--text-primary) / <alpha-value>)',
        secondary: 'rgb(var(--text-secondary) / <alpha-value>)',
        tertiary: 'rgb(var(--text-tertiary) / <alpha-value>)',
        inverted: 'rgb(var(--text-inverted) / <alpha-value>)',

        line: {
          DEFAULT: 'rgb(var(--border-default) / <alpha-value>)',
          strong: 'rgb(var(--border-strong) / <alpha-value>)',
          subtle: 'rgb(var(--border-subtle) / <alpha-value>)',
        },

        accent: {
          DEFAULT: 'rgb(var(--accent-default) / <alpha-value>)',
          hover: 'rgb(var(--accent-hover) / <alpha-value>)',
          subtle: 'rgb(var(--accent-subtle) / <alpha-value>)',
          text: 'rgb(var(--accent-text) / <alpha-value>)',
        },

        // Status colours. Each is paired with a non-colour affordance in the components that
        // use them (icon, label, pattern), so meaning never depends on hue alone — WCAG 1.4.1.
        success: {
          DEFAULT: 'rgb(var(--success-default) / <alpha-value>)',
          subtle: 'rgb(var(--success-subtle) / <alpha-value>)',
          text: 'rgb(var(--success-text) / <alpha-value>)',
        },
        warning: {
          DEFAULT: 'rgb(var(--warning-default) / <alpha-value>)',
          subtle: 'rgb(var(--warning-subtle) / <alpha-value>)',
          text: 'rgb(var(--warning-text) / <alpha-value>)',
        },
        danger: {
          DEFAULT: 'rgb(var(--danger-default) / <alpha-value>)',
          subtle: 'rgb(var(--danger-subtle) / <alpha-value>)',
          text: 'rgb(var(--danger-text) / <alpha-value>)',
        },
      },

      fontFamily: {
        sans: ['var(--font-sans)', 'system-ui', 'sans-serif'],
        mono: ['var(--font-mono)', 'ui-monospace', 'monospace'],
      },

      fontSize: {
        // A compact type scale. 13px is the workhorse for grid and table content; the browser
        // default of 16px wastes vertical space in a data-dense product.
        '2xs': ['0.6875rem', { lineHeight: '1rem' }],
        xs: ['0.75rem', { lineHeight: '1.125rem' }],
        sm: ['0.8125rem', { lineHeight: '1.25rem' }],
        base: ['0.875rem', { lineHeight: '1.375rem' }],
        md: ['0.9375rem', { lineHeight: '1.5rem' }],
        lg: ['1.0625rem', { lineHeight: '1.625rem' }],
        xl: ['1.25rem', { lineHeight: '1.75rem' }],
        '2xl': ['1.5rem', { lineHeight: '2rem' }],
        '3xl': ['1.875rem', { lineHeight: '2.25rem' }],
      },

      spacing: {
        // Row heights, named rather than numeric so a change is one edit.
        row: '2rem',
        'row-md': '2.5rem',
        'row-lg': '3.25rem',
        'row-xl': '5.5rem',
      },

      borderRadius: {
        sm: '0.25rem',
        DEFAULT: '0.375rem',
        md: '0.5rem',
        lg: '0.75rem',
      },

      boxShadow: {
        // Shadows are subtle and few. In a dense UI, heavy elevation reads as clutter.
        low: '0 1px 2px 0 rgb(var(--shadow-color) / 0.06)',
        mid: '0 4px 12px -2px rgb(var(--shadow-color) / 0.10), 0 2px 4px -2px rgb(var(--shadow-color) / 0.06)',
        high: '0 16px 32px -8px rgb(var(--shadow-color) / 0.16), 0 4px 8px -4px rgb(var(--shadow-color) / 0.08)',
        focus: '0 0 0 2px rgb(var(--surface-default)), 0 0 0 4px rgb(var(--accent-default))',
      },

      transitionDuration: {
        instant: '80ms',
        fast: '140ms',
        DEFAULT: '200ms',
      },

      keyframes: {
        'fade-in': { from: { opacity: '0' }, to: { opacity: '1' } },
        'slide-up': {
          from: { opacity: '0', transform: 'translateY(4px)' },
          to: { opacity: '1', transform: 'translateY(0)' },
        },
        shimmer: {
          '100%': { transform: 'translateX(100%)' },
        },
      },
      animation: {
        'fade-in': 'fade-in 140ms ease-out',
        'slide-up': 'slide-up 160ms ease-out',
        shimmer: 'shimmer 1.6s infinite',
      },
    },
  },
  plugins: [],
};

export default config;

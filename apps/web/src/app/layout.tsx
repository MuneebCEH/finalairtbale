import type { Metadata, Viewport } from 'next';

import { ThemeScript } from '@/components/theme';

import { Providers } from './providers';
import './globals.css';

export const metadata: Metadata = {
  title: {
    default: 'Tessera',
    template: '%s · Tessera',
  },
  description:
    'A collaborative relational workspace: structured data, real-time collaboration, and no-code automation in one place.',
  robots: { index: false, follow: false },
};

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  // Zoom is deliberately not disabled. `maximum-scale=1` is a WCAG 1.4.4 failure and makes a
  // dense data application unusable for anyone with low vision.
  themeColor: [
    { media: '(prefers-color-scheme: light)', color: '#ffffff' },
    { media: '(prefers-color-scheme: dark)', color: '#14181f' },
  ],
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <ThemeScript />
      </head>
      <body>
        {/* First tab stop on every page. WCAG 2.4.1 — without it, keyboard users traverse the
            entire navigation on every navigation. */}
        <a
          href="#main"
          className="sr-only-focusable absolute left-3 top-3 z-50 rounded bg-accent px-3 py-2 text-sm font-medium text-inverted"
        >
          Skip to main content
        </a>
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}

'use client';

import { useEffect, useState } from 'react';

export type Theme = 'light' | 'dark' | 'system';

const STORAGE_KEY = 'tessera-theme';

/**
 * Applies the stored theme before the browser paints.
 *
 * Rendered as an inline, blocking script in <head>. Any approach that waits for React to hydrate
 * produces a flash of the wrong theme on every navigation — brief, but jarring, and worst in
 * dark mode where the flash is a full-screen white frame.
 *
 * The script is written as a string because it must run synchronously before first paint, which
 * a React component cannot do. It reads only from localStorage and matchMedia, so there is no
 * injection surface.
 */
export function ThemeScript() {
  const script = `
    (function () {
      try {
        var stored = localStorage.getItem('${STORAGE_KEY}');
        var theme = stored === 'light' || stored === 'dark'
          ? stored
          : (window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
        document.documentElement.setAttribute('data-theme', theme);
        document.documentElement.style.colorScheme = theme;
      } catch (e) {
        document.documentElement.setAttribute('data-theme', 'light');
      }
    })();
  `;
  return <script dangerouslySetInnerHTML={{ __html: script }} />;
}

export function useTheme(): {
  theme: Theme;
  resolved: 'light' | 'dark';
  setTheme: (theme: Theme) => void;
} {
  const [theme, setThemeState] = useState<Theme>('system');
  const [resolved, setResolved] = useState<'light' | 'dark'>('light');

  useEffect(() => {
    const stored = localStorage.getItem(STORAGE_KEY) as Theme | null;
    setThemeState(stored ?? 'system');

    const media = window.matchMedia('(prefers-color-scheme: dark)');
    const apply = (): void => {
      const current = (localStorage.getItem(STORAGE_KEY) as Theme | null) ?? 'system';
      const next = current === 'system' ? (media.matches ? 'dark' : 'light') : current;
      document.documentElement.setAttribute('data-theme', next);
      document.documentElement.style.colorScheme = next;
      setResolved(next);
    };

    apply();
    // Keeps a "system" preference live: changing the OS theme updates the app without a reload.
    media.addEventListener('change', apply);
    return () => media.removeEventListener('change', apply);
  }, []);

  const setTheme = (next: Theme): void => {
    if (next === 'system') localStorage.removeItem(STORAGE_KEY);
    else localStorage.setItem(STORAGE_KEY, next);

    setThemeState(next);
    const effective =
      next === 'system'
        ? window.matchMedia('(prefers-color-scheme: dark)').matches
          ? 'dark'
          : 'light'
        : next;
    document.documentElement.setAttribute('data-theme', effective);
    document.documentElement.style.colorScheme = effective;
    setResolved(effective);
  };

  return { theme, resolved, setTheme };
}

export function ThemeToggle() {
  const { theme, setTheme } = useTheme();
  const options: Array<{ value: Theme; label: string; glyph: string }> = [
    { value: 'light', label: 'Light', glyph: '☀' },
    { value: 'dark', label: 'Dark', glyph: '☽' },
    { value: 'system', label: 'System', glyph: '◐' },
  ];

  return (
    <div
      role="radiogroup"
      aria-label="Colour theme"
      className="inline-flex rounded border border-line bg-surface p-0.5"
    >
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          role="radio"
          aria-checked={theme === option.value}
          onClick={() => setTheme(option.value)}
          title={option.label}
          className={`flex h-6 w-7 items-center justify-center rounded-sm text-xs transition-colors duration-fast ${
            theme === option.value
              ? 'bg-sunken text-primary'
              : 'text-tertiary hover:text-secondary'
          }`}
        >
          <span aria-hidden="true">{option.glyph}</span>
          <span className="sr-only">{option.label}</span>
        </button>
      ))}
    </div>
  );
}

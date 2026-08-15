'use client';

import { cn } from '@/lib/cn';

/**
 * The base's top-level sections.
 *
 * Data, Automations, Interfaces and Forms are four different things you can do with one base, not
 * four pages that happen to share a URL prefix — so the tab strip lives above the table tabs and
 * survives switching tables. Losing the section on every table click is the thing that makes a
 * two-level navigation feel broken.
 */

export const BASE_SECTIONS = ['data', 'automations', 'interfaces', 'forms'] as const;

export type BaseSection = (typeof BASE_SECTIONS)[number];

const LABELS: Record<BaseSection, string> = {
  data: 'Data',
  automations: 'Automations',
  interfaces: 'Interfaces',
  forms: 'Forms',
};

export function BaseTabs({
  active,
  onChange,
  counts,
}: {
  active: BaseSection;
  onChange: (section: BaseSection) => void;
  /** Shown beside a section that holds something, so an empty one is visibly empty. */
  counts?: Partial<Record<BaseSection, number>>;
}) {
  return (
    <nav aria-label="Base sections" className="flex shrink-0 items-center gap-1">
      {BASE_SECTIONS.map((section) => {
        const count = counts?.[section];
        const isActive = section === active;

        return (
          <button
            key={section}
            type="button"
            aria-current={isActive ? 'page' : undefined}
            onClick={() => onChange(section)}
            className={cn(
              'relative px-3 py-2 text-sm transition-colors',
              isActive ? 'font-medium text-primary' : 'text-secondary hover:text-primary',
            )}
          >
            {LABELS[section]}
            {count !== undefined && count > 0 && (
              <span className="ml-1.5 rounded bg-sunken px-1.5 py-0.5 text-2xs text-tertiary">
                {count}
              </span>
            )}
            {/* An underline rather than a filled tab: the section strip sits directly above the
                table strip, and two filled rows read as one confusing block. */}
            {isActive && <span className="absolute inset-x-2 -bottom-px h-0.5 rounded bg-accent" />}
          </button>
        );
      })}
    </nav>
  );
}

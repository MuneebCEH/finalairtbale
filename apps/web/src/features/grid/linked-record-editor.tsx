'use client';

import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

import { cn } from '@/lib/cn';

import { dataApi, type Field, type LinkedRef } from '../data/api';

/**
 * The editor for a linked-record cell: a search-and-select popup over the target table. Because a
 * grid cell clips its overflow, the popup is rendered through a portal to `document.body` and
 * positioned under the cell, so it is never cut off. Selections commit as `[{id, label}]` when the
 * popup closes; the server stores the ids and echoes the labels back.
 */
export function LinkedRecordEditor({
  field,
  value,
  onCommit,
}: {
  field: Field;
  value: unknown;
  onCommit: (value: unknown) => void;
}) {
  const linkedTableId = field.options?.['linkedTableId'] as string | undefined;
  const [selected, setSelected] = useState<LinkedRef[]>(
    Array.isArray(value) ? (value as LinkedRef[]).filter((v) => v && v.id) : [],
  );
  const [search, setSearch] = useState('');
  const [options, setOptions] = useState<LinkedRef[]>([]);
  const [loading, setLoading] = useState(false);
  const anchorRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const committed = useRef(false);
  const [rect, setRect] = useState<DOMRect | null>(null);

  useEffect(() => {
    setRect(anchorRef.current?.getBoundingClientRect() ?? null);
  }, []);

  useEffect(() => {
    inputRef.current?.focus();
  }, [rect]);

  useEffect(() => {
    if (!linkedTableId) return;
    let cancelled = false;
    setLoading(true);
    const timer = setTimeout(() => {
      dataApi
        .linkOptions(linkedTableId, search || undefined)
        .then((result) => !cancelled && setOptions(result.data))
        .catch(() => !cancelled && setOptions([]))
        .finally(() => !cancelled && setLoading(false));
    }, 150);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [linkedTableId, search]);

  // Guard against a double-commit (the overlay and the Done button can both fire): committing the
  // same base version twice makes the second write a spurious version conflict.
  const finish = () => {
    if (committed.current) return;
    committed.current = true;
    onCommit(selected);
  };
  const isSelected = (id: string) => selected.some((s) => s.id === id);
  const toggle = (option: LinkedRef) =>
    setSelected((current) =>
      isSelected(option.id) ? current.filter((s) => s.id !== option.id) : [...current, option],
    );

  const summary =
    selected.length === 0
      ? 'Select records…'
      : selected.map((s) => s.label).join(', ');

  const panel =
    rect && typeof document !== 'undefined'
      ? createPortal(
          <>
            <button
              type="button"
              aria-label="Close linked record picker"
              onClick={finish}
              className="fixed inset-0 z-40 cursor-default"
            />
            <div
              className="fixed z-50 w-72 rounded-md border border-line bg-surface p-2 shadow-lg"
              style={{
                top: Math.min(rect.bottom + 4, window.innerHeight - 320),
                left: Math.min(rect.left, window.innerWidth - 300),
              }}
            >
              {!linkedTableId && (
                <p className="p-2 text-xs text-tertiary">This link field is not configured yet.</p>
              )}

              {selected.length > 0 && (
                <div className="mb-2 flex flex-wrap gap-1">
                  {selected.map((item) => (
                    <span
                      key={item.id}
                      className="flex items-center gap-1 rounded bg-sunken px-1.5 py-0.5 text-xs"
                    >
                      {item.label}
                      <button
                        type="button"
                        aria-label={`Remove ${item.label}`}
                        onClick={() => toggle(item)}
                        className="text-tertiary hover:text-danger-text"
                      >
                        ×
                      </button>
                    </span>
                  ))}
                </div>
              )}

              <input
                ref={inputRef}
                value={search}
                onChange={(event) => setSearch(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Escape') finish();
                  event.stopPropagation();
                }}
                placeholder="Search records…"
                className="mb-1 w-full rounded border border-line bg-canvas px-2 py-1 text-sm outline-none focus:border-accent"
              />

              <div className="max-h-48 overflow-y-auto">
                {loading && <div className="px-2 py-1.5 text-xs text-tertiary">Searching…</div>}
                {!loading && options.length === 0 && (
                  <div className="px-2 py-1.5 text-xs text-tertiary">No matching records.</div>
                )}
                {options.map((option) => (
                  <button
                    key={option.id}
                    type="button"
                    onClick={() => toggle(option)}
                    className={cn(
                      'flex w-full items-center justify-between rounded px-2 py-1.5 text-left text-sm hover:bg-sunken',
                      isSelected(option.id) && 'text-accent-text',
                    )}
                  >
                    <span className="truncate">{option.label}</span>
                    {isSelected(option.id) && <span aria-hidden="true">✓</span>}
                  </button>
                ))}
              </div>

              <div className="mt-1 flex justify-end border-t border-line pt-1">
                <button
                  type="button"
                  onClick={finish}
                  className="rounded px-2 py-1 text-xs font-medium text-accent-text hover:bg-sunken"
                >
                  Done
                </button>
              </div>
            </div>
          </>,
          document.body,
        )
      : null;

  return (
    <div
      ref={anchorRef}
      className="flex h-full w-full items-center truncate px-2 text-sm text-tertiary"
    >
      <span className="truncate">{summary}</span>
      {panel}
    </div>
  );
}

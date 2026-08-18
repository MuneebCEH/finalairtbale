'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';

import { cn } from '@/lib/cn';

import { dataApi, richTextToPlain, type Field, type RecordRow } from '../data/api';

import { Cell, isComputed } from './cell';

/**
 * The expanded record: every field in a form, and its comment thread beside it.
 *
 * The grid shows a few columns of many; this is where the whole record is legible at once, and
 * where a field too wide or too tall for a cell — a long note, a stack of attachments — is
 * actually usable.
 *
 * Editing reuses `Cell` rather than reimplementing per-type editors. Two implementations of "how
 * do you edit a currency field" drift, and the one used less often is the one that rots.
 */
export function RecordPanel({
  record,
  recordIndex,
  fields,
  baseId,
  tableName,
  onClose,
  onCommitAt,
  onStep,
  onDuplicate,
}: {
  record: RecordRow;
  recordIndex: number;
  fields: Field[];
  baseId: string;
  tableName: string;
  onClose: () => void;
  onCommitAt: (row: number, column: number, value: unknown) => void;
  onStep: (delta: number) => void;
  /** Optional — the grid passes it; other hosts of this panel may not offer duplication. */
  onDuplicate?: (record: RecordRow) => void;
}) {
  const queryClient = useQueryClient();
  const [draft, setDraft] = useState('');
  const [editingField, setEditingField] = useState<string | null>(null);
  const panelRef = useRef<HTMLDivElement>(null);

  const comments = useQuery({
    queryKey: ['comments', record.id],
    queryFn: () => dataApi.listComments(record.id),
  });

  // History loads with the panel: the question "who changed this" usually arrives already urgent.
  const revisions = useQuery({
    queryKey: ['revisions', record.id],
    queryFn: () => dataApi.listRevisions(record.id),
  });

  const addComment = useMutation({
    mutationFn: (text: string) => dataApi.createComment(record.id, text),
    onSuccess: () => {
      setDraft('');
      void queryClient.invalidateQueries({ queryKey: ['comments', record.id] });
    },
  });

  // Escape closes. Bound to the panel rather than the document so it does not also fire for a
  // dialog opened on top of this one.
  useEffect(() => {
    panelRef.current?.focus();
  }, []);

  const primary = fields.find((field) => field.isPrimary) ?? fields[0];
  const title = primary ? String(record.fields[primary.id] ?? 'Untitled') : 'Record';

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center bg-black/40 p-4 sm:p-8"
      // A click on the backdrop closes; a click inside must not bubble out to it.
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-label={`${title} — ${tableName}`}
        tabIndex={-1}
        onKeyDown={(event) => {
          if (event.key === 'Escape') {
            event.stopPropagation();
            onClose();
          }
        }}
        className={cn(
          'flex max-h-full w-full max-w-5xl flex-col overflow-hidden rounded-lg border border-line',
          'bg-surface shadow-xl outline-none',
        )}
      >
        <header className="flex shrink-0 items-center gap-2 border-b border-line px-4 py-3">
          <div className="flex gap-1">
            <button
              type="button"
              aria-label="Previous record"
              onClick={() => onStep(-1)}
              className="rounded px-2 py-1 text-sm text-tertiary hover:bg-sunken hover:text-secondary"
            >
              ↑
            </button>
            <button
              type="button"
              aria-label="Next record"
              onClick={() => onStep(1)}
              className="rounded px-2 py-1 text-sm text-tertiary hover:bg-sunken hover:text-secondary"
            >
              ↓
            </button>
          </div>

          <h2 className="min-w-0 flex-1 truncate text-base font-semibold text-primary">{title}</h2>

          {onDuplicate && (
            <button
              type="button"
              onClick={() => onDuplicate(record)}
              className="rounded px-2 py-1 text-sm text-secondary hover:bg-sunken hover:text-primary"
              title="Make a copy of this record"
            >
              ⧉ Duplicate
            </button>
          )}
          <button
            type="button"
            aria-label="Close"
            onClick={onClose}
            className="rounded px-2 py-1 text-sm text-tertiary hover:bg-sunken hover:text-secondary"
          >
            ✕
          </button>
        </header>

        {/*
          Side by side from `md` rather than `lg`. At `lg` the panel spent most of its width on
          fields while comments sat below the fold on the laptop widths this is actually used at,
          which made the thread feel like an afterthought rather than half the reason to open a
          record.
        */}
        <div className="flex min-h-0 flex-1 flex-col overflow-hidden md:flex-row">
          {/*
            Fields.
            `min-w-0` on the scroll container and on every value is what keeps this from growing a
            horizontal scrollbar: without it a long value forces the flex child wider than the
            panel instead of wrapping inside it.
          */}
          <div className="min-h-0 min-w-0 flex-1 overflow-y-auto p-5">
            <dl className="space-y-4">
              {fields.map((field, columnIndex) => (
                <div
                  key={field.id}
                  className="grid min-w-0 gap-1.5 sm:grid-cols-[11rem_minmax(0,1fr)] sm:items-start sm:gap-4"
                >
                  <dt className="flex min-w-0 items-center gap-1.5 pt-2 text-xs font-medium text-secondary">
                    <span className="truncate" title={field.name}>
                      {field.name}
                    </span>
                    {isComputed(field.type) && (
                      <span className="shrink-0 text-2xs text-tertiary" title="Computed by a formula">
                        ƒ
                      </span>
                    )}
                  </dt>

                  <dd
                    className="min-w-0"
                    onDoubleClick={() => {
                      if (!isComputed(field.type)) setEditingField(field.id);
                    }}
                  >
                    <Cell
                      field={field}
                      value={record.fields[field.id] ?? null}
                      baseId={baseId}
                      isSelected={false}
                      isEditing={editingField === field.id}
                      rowIndex={recordIndex}
                      columnIndex={columnIndex}
                      // Ignored in fluid mode, which is what this view uses: the value fills the
                      // column and wraps rather than being clipped to a fixed column width.
                      width={0}
                      fluid
                      onSelect={() => undefined}
                      onStartEdit={() => setEditingField(field.id)}
                      onCommit={(value) => {
                        setEditingField(null);
                        onCommitAt(recordIndex, columnIndex, value);
                      }}
                      onCommitAt={onCommitAt}
                      onCancel={() => setEditingField(null)}
                    />
                  </dd>
                </div>
              ))}
            </dl>
          </div>

          {/* Comments */}
          <aside
            className={cn(
              'flex min-h-0 shrink-0 flex-col bg-sunken/30',
              // Capped on small screens so the thread cannot push the fields off the panel; a
              // fixed column once there is room for one.
              'max-h-64 border-t border-line md:max-h-none md:w-72 md:border-l md:border-t-0 lg:w-80',
            )}
          >
            <h3 className="shrink-0 px-4 py-3 text-xs font-medium uppercase tracking-wide text-tertiary">
              Comments
            </h3>

            <div className="min-h-0 flex-1 overflow-y-auto px-4">
              {comments.isPending && <p className="text-sm text-tertiary">Loading…</p>}

              {comments.data?.data.length === 0 && (
                <p className="text-sm text-tertiary">
                  No comments yet. Anyone who can read this record can leave one.
                </p>
              )}

              <ul className="space-y-3">
                {(comments.data?.data ?? []).map((comment) => (
                  <li key={comment.id} className="rounded border border-line p-2">
                    <p className="text-2xs text-tertiary">
                      {comment.authorName ?? 'Someone'} ·{' '}
                      {new Date(comment.createdAt).toLocaleString()}
                    </p>
                    <p className="mt-1 whitespace-pre-wrap text-sm text-primary">
                      {richTextToPlain(comment.body)}
                    </p>
                  </li>
                ))}
              </ul>
            </div>

            <form
              className="shrink-0 border-t border-line p-3"
              onSubmit={(event) => {
                event.preventDefault();
                const text = draft.trim();
                if (text) addComment.mutate(text);
              }}
            >
              <textarea
                value={draft}
                onChange={(event) => setDraft(event.target.value)}
                placeholder="Leave a comment"
                aria-label="Leave a comment"
                rows={3}
                className="w-full resize-none rounded border border-line bg-surface p-2 text-sm text-primary"
              />
              {addComment.isError && (
                <p className="mt-1 text-2xs text-danger">
                  {addComment.error instanceof Error
                    ? addComment.error.message
                    : 'That comment could not be posted.'}
                </p>
              )}
              <button
                type="submit"
                disabled={draft.trim().length === 0 || addComment.isPending}
                className={cn(
                  'mt-2 w-full rounded px-3 py-1.5 text-sm font-medium',
                  'bg-accent text-inverted disabled:opacity-40',
                )}
              >
                {addComment.isPending ? 'Posting…' : 'Comment'}
              </button>
            </form>

            {/* History — who changed which field, newest first. */}
            <div className="max-h-48 shrink-0 overflow-y-auto border-t border-line px-4 py-2">
              <h3 className="text-xs font-medium uppercase tracking-wide text-tertiary">History</h3>
              {revisions.isPending && <p className="mt-1 text-2xs text-tertiary">Loading…</p>}
              {revisions.isSuccess && revisions.data.length === 0 && (
                <p className="mt-1 text-2xs text-tertiary">No edits recorded yet.</p>
              )}
              <ul className="mt-1 space-y-2">
                {(revisions.data ?? []).map((rev) => (
                  <li key={rev.id} className="text-2xs text-secondary">
                    <span className="font-medium text-primary">{rev.userName}</span>{' '}
                    {rev.kind === 'created' ? 'created this record' : rev.kind === 'restored' ? 'restored this record' : 'edited'}
                    {rev.createdAt && (
                      <span className="text-tertiary"> · {new Date(rev.createdAt).toLocaleString()}</span>
                    )}
                    {rev.changes.map((change, i) => (
                      <span key={i} className="block truncate pl-2">
                        {change.field}: <span className="text-tertiary line-through">{formatRevValue(change.from)}</span>{' '}
                        → {formatRevValue(change.to)}
                      </span>
                    ))}
                  </li>
                ))}
              </ul>
            </div>
          </aside>
        </div>
      </div>
    </div>
  );
}

/** A revision value, compact: scalars as themselves, blanks as "empty", structures summarised. */
function formatRevValue(value: unknown): string {
  if (value === null || value === undefined || value === '') return 'empty';
  if (Array.isArray(value)) return `${value.length} item${value.length === 1 ? '' : 's'}`;
  if (typeof value === 'object') return '…';
  return String(value).slice(0, 60);
}

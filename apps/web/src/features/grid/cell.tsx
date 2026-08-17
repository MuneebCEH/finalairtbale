'use client';

import { memo, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

import { cn } from '@/lib/cn';

import { dataApi, type Field } from '../data/api';

import { AttachmentGallery, AttachmentPreview } from './attachment-preview';
import { LinkedRecordEditor } from './linked-record-editor';

/**
 * Cell rendering and editing.
 *
 * Split into a display component and an editor, because the display path runs for every visible
 * cell on every scroll frame and must stay cheap, while the editor runs for exactly one cell at
 * a time and can afford to be careful.
 *
 * `Cell` is memoised on the four things that actually change its output. Without that, moving
 * the selection re-renders every mounted cell instead of the two involved, and the grid feels
 * heavy at a few hundred rows.
 */

interface CellProps {
  readonly field: Field;
  readonly value: unknown;
  /** Attachments are stored against the base, so the cell needs to know which one it is in. */
  readonly baseId: string;
  readonly isSelected: boolean;
  readonly isEditing: boolean;
  readonly rowIndex: number;
  readonly columnIndex: number;
  readonly width: number;
  /**
   * Fills its container and wraps, instead of being a fixed-width single-line grid cell.
   *
   * The record panel needs this. A grid cell is `shrink-0`, `overflow-hidden` and
   * `whitespace-nowrap` because a column has one width and a row has one height; a form has
   * neither constraint, and reusing the grid geometry there produced a horizontal scrollbar and
   * checkboxes stretched across the full width.
   */
  readonly fluid?: boolean;
  readonly onSelect: (row: number, column: number) => void;
  readonly onStartEdit: (row: number, column: number) => void;
  readonly onCommit: (value: unknown) => void;
  /**
   * Writes to a cell by coordinate, without going through edit mode.
   *
   * Attachments need this: uploading never puts the cell into edit mode, so the editor's commit
   * — which returns early when nothing is being edited — silently dropped the write.
   */
  readonly onCommitAt: (row: number, column: number, value: unknown) => void;
  readonly onCancel: () => void;
}

export const Cell = memo(
  function Cell({
    field,
    value,
    baseId,
    isSelected,
    isEditing,
    rowIndex,
    columnIndex,
    width,
    onSelect,
    onStartEdit,
    onCommit,
    onCommitAt,
    onCancel,
    fluid = false,
  }: CellProps) {
    return (
      <div
        role="gridcell"
        aria-selected={isSelected}
        aria-readonly={isComputed(field.type) || undefined}
        tabIndex={-1}
        style={fluid ? undefined : { width }}
        onMouseDown={() => onSelect(rowIndex, columnIndex)}
        onDoubleClick={() => {
          if (!isComputed(field.type)) onStartEdit(rowIndex, columnIndex);
        }}
        className={cn(
          'relative px-2 text-sm',
          // `group/cell` is what lets the attachment upload control appear on hover.
          'group/cell flex items-center',
          fluid
            ? 'min-h-9 w-full rounded border border-line py-1.5'
            : 'shrink-0 overflow-hidden whitespace-nowrap border-b border-r border-line',
          isSelected && 'z-10 outline outline-2 -outline-offset-2 outline-accent',
          isComputed(field.type) && 'bg-sunken/40 text-secondary',
        )}
      >
        {isEditing ? (
          <CellEditor field={field} value={value} onCommit={onCommit} onCancel={onCancel} />
        ) : (
          <CellDisplay
            field={field}
            value={value}
            baseId={baseId}
            fluid={fluid}
            onWrite={(next) => onCommitAt(rowIndex, columnIndex, next)}
          />
        )}
      </div>
    );
  },
  // The comparator is the point of the memo: a cell re-renders only when its own value, its own
  // selection state, or its width changes.
  (previous, next) =>
    previous.value === next.value &&
    previous.isSelected === next.isSelected &&
    previous.isEditing === next.isEditing &&
    previous.width === next.width &&
    previous.field.id === next.field.id,
);

function CellDisplay({
  field,
  value,
  baseId,
  fluid,
  onWrite,
}: {
  field: Field;
  value: unknown;
  baseId: string;
  fluid: boolean;
  onWrite: (value: unknown) => void;
}) {
  // Attachments are handled before the empty check, and must stay that way. An empty attachment
  // cell still needs its upload control — returning null for it is exactly why there was no way
  // to add the first file to a record.
  if (field.type === 'attachment') {
    return (
      <AttachmentCell
        files={Array.isArray(value) ? (value as AttachmentValue[]) : []}
        baseId={baseId}
        wrap={fluid}
        onChange={onWrite}
      />
    );
  }

  if (value === null || value === undefined || value === '') return null;

  switch (field.type) {
    case 'checkbox':
      return (
        <span
          aria-hidden="true"
          className={cn(
            'flex h-4 w-4 items-center justify-center rounded-sm border text-2xs',
            value === true ? 'border-accent bg-accent text-inverted' : 'border-line',
          )}
        >
          {value === true ? '✓' : ''}
        </span>
      );

    case 'singleSelect':
    case 'status': {
      const choice = choicesOf(field).find((c) => c.id === value);
      if (!choice) return <span className="truncate text-tertiary">{String(value)}</span>;
      return (
        <span
          className="truncate rounded px-1.5 py-0.5 text-xs font-medium"
          style={
            choice.color
              ? { backgroundColor: `${choice.color}22`, color: choice.color }
              : { backgroundColor: 'rgb(var(--surface-sunken))' }
          }
        >
          {choice.label}
        </span>
      );
    }

    case 'multipleSelect': {
      const ids = Array.isArray(value) ? value : [];
      const choices = choicesOf(field);
      return (
        <span className="flex gap-1 overflow-hidden">
          {ids.slice(0, 4).map((id) => {
            const choice = choices.find((c) => c.id === id);
            return (
              <span
                key={String(id)}
                className="shrink-0 rounded bg-sunken px-1.5 py-0.5 text-xs"
                style={choice?.color ? { backgroundColor: `${choice.color}22`, color: choice.color } : undefined}
              >
                {choice?.label ?? String(id)}
              </span>
            );
          })}
          {ids.length > 4 && <span className="text-xs text-tertiary">+{ids.length - 4}</span>}
        </span>
      );
    }

    case 'currency':
    case 'decimal':
    case 'number':
    case 'percent':
    case 'rating':
    case 'progress':
      // Numbers are right-aligned and tabular so digits line up down the column — the single
      // biggest readability win in a numeric grid.
      return (
        <span className="w-full truncate text-right font-mono text-sm tabular-nums">
          {formatNumber(field, value)}
        </span>
      );

    case 'date':
      return <span className="truncate">{String(value).slice(0, 10)}</span>;

    case 'dateTime':
      return <span className="truncate">{new Date(String(value)).toLocaleString()}</span>;

    case 'url':
      return (
        <a
          href={String(value)}
          target="_blank"
          rel="noopener noreferrer nofollow"
          onClick={(event) => event.stopPropagation()}
          className="truncate text-accent-text hover:underline"
        >
          {String(value)}
        </a>
      );

    case 'linkedRecord':
    case 'parentRecord':
    case 'childRecords': {
      const refs = Array.isArray(value) ? (value as { id: string; label?: string }[]) : [];
      if (refs.length === 0) return null;
      return (
        <span className="flex gap-1 overflow-hidden">
          {refs.slice(0, 4).map((ref) => (
            <span
              key={ref.id}
              className="shrink-0 truncate rounded bg-sunken px-1.5 py-0.5 text-xs text-accent-text"
            >
              {ref.label ?? ref.id}
            </span>
          ))}
          {refs.length > 4 && <span className="text-xs text-tertiary">+{refs.length - 4}</span>}
        </span>
      );
    }

    default:
      return <span className="truncate">{String(value)}</span>;
  }
}

function CellEditor({
  field,
  value,
  onCommit,
  onCancel,
}: {
  field: Field;
  value: unknown;
  onCommit: (value: unknown) => void;
  onCancel: () => void;
}) {
  const [draft, setDraft] = useState(() => toEditableText(field, value));
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, []);

  if (field.type === 'checkbox') {
    // A checkbox has no meaningful text form; entering edit mode simply toggles it.
    onCommit(value !== true);
    return null;
  }

  if (field.type === 'singleSelect' || field.type === 'status') {
    return (
      <select
        autoFocus
        value={String(value ?? '')}
        onChange={(event) => onCommit(event.target.value || null)}
        onBlur={onCancel}
        className="h-full w-full bg-surface text-sm outline-none"
      >
        <option value="">—</option>
        {choicesOf(field).map((choice) => (
          <option key={choice.id} value={choice.id}>
            {choice.label}
          </option>
        ))}
      </select>
    );
  }

  if (field.type === 'linkedRecord' || field.type === 'parentRecord') {
    return <LinkedRecordEditor field={field} value={value} onCommit={onCommit} />;
  }

  return (
    <input
      ref={inputRef}
      value={draft}
      onChange={(event) => setDraft(event.target.value)}
      onKeyDown={(event) => {
        if (event.key === 'Enter') {
          event.preventDefault();
          onCommit(draft === '' ? null : draft);
        } else if (event.key === 'Escape') {
          event.preventDefault();
          onCancel();
        }
        // Arrow keys inside an open editor move the caret, not the selection.
        event.stopPropagation();
      }}
      onBlur={() => onCommit(draft === '' ? null : draft)}
      className={cn(
        'h-full w-full bg-surface text-sm outline-none',
        isNumeric(field.type) && 'text-right font-mono tabular-nums',
      )}
    />
  );
}

interface AttachmentValue {
  id: string;
  filename: string;
  mimeType: string;
  size: number;
  url?: string | null;
}

/**
 * Attachment cell.
 *
 * Images render as real thumbnails; everything else gets a type glyph and its filename. Links
 * carry `rel="noopener noreferrer"` and open in a new tab — the files origin is deliberately
 * cookie-free, and `noopener` stops the opened document reaching back through `window.opener`.
 *
 * A file whose URL failed to sign is shown greyed out rather than as a dead link, so "the file
 * is unavailable" is visibly different from "there is no file".
 */
function AttachmentCell({
  files,
  baseId,
  wrap = false,
  onChange,
}: {
  files: AttachmentValue[];
  baseId: string;
  /** In the record panel every file is shown, wrapped over as many lines as it takes. */
  wrap?: boolean;
  onChange: (value: unknown) => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  /** Index of the file being previewed, or null when the lightbox is closed. */
  const [previewing, setPreviewing] = useState<number | null>(null);
  /** Airtable's "Expand cell" — all of the cell's files as large cards. */
  const [galleryOpen, setGalleryOpen] = useState(false);
  /** The hovered file's dark tooltip (filename · type · size), positioned near the card. */
  const [hovered, setHovered] = useState<{ name: string; mime: string; size: number; x: number; y: number } | null>(null);

  const upload = async (chosen: FileList | null): Promise<void> => {
    if (!chosen || chosen.length === 0) return;

    setBusy(true);
    setFailure(null);

    try {
      // Sequential, not `Promise.all`. These are whole files over the wire, and firing twenty at
      // once buys nothing while making the rate limiter reject most of them.
      const added: AttachmentValue[] = [];
      for (const file of Array.from(chosen)) {
        const stored = await dataApi.uploadAttachment(baseId, file);
        added.push({
          id: stored.id,
          filename: stored.filename,
          // The server's verdict, not the browser's guess: it names the file from its bytes.
          mimeType: stored.mimeType,
          size: stored.size,
          // Omitted when absent rather than sent as null. The field schema types `url` as an
          // optional string, so an explicit null fails validation and the server rejects the whole
          // write as "one or more attachments are malformed" — a message that says nothing about
          // which of the six properties was wrong.
          ...(stored.url ? { url: stored.url } : {}),
        });
      }

      // Appended, so uploading into a cell that already has files does not replace them.
      onChange([...files, ...added]);
    } catch (error) {
      setFailure(error instanceof Error ? error.message : 'That file could not be uploaded.');
    } finally {
      setBusy(false);
      // Cleared so that choosing the same file again still fires a change event.
      if (inputRef.current) inputRef.current.value = '';
    }
  };

  return (
    <span
      className={cn(
        'flex w-full items-center gap-1',
        wrap ? 'flex-wrap' : 'overflow-hidden',
      )}
    >
      <input
        ref={inputRef}
        type="file"
        multiple
        className="hidden"
        onChange={(event) => void upload(event.target.files)}
      />

      {/* Airtable-style: each file is a small white card — images show themselves, documents a
          typed glyph — rather than a grey name-chip. Names live in the tooltip and the gallery. */}
      {(wrap ? files : files.slice(0, 6)).map((file) => {
        const isImage = file.mimeType?.startsWith('image/');

        if (!file.url) {
          return (
            <span
              key={file.id}
              title={`${file.filename} (unavailable)`}
              className="shrink-0 truncate rounded bg-sunken px-1.5 py-0.5 text-2xs text-tertiary line-through"
            >
              {file.filename}
            </span>
          );
        }

        const isDoc = !isImage && !file.mimeType?.startsWith('audio/') && !file.mimeType?.startsWith('video/');

        return (
          <button
            key={file.id}
            type="button"
            onClick={(event) => {
              event.stopPropagation();
              setPreviewing(files.indexOf(file));
            }}
            onMouseDown={(event) => event.stopPropagation()}
            onDoubleClick={(event) => event.stopPropagation()}
            onMouseEnter={(event) => {
              const rect = event.currentTarget.getBoundingClientRect();
              setHovered({
                name: file.filename,
                mime: file.mimeType ?? '',
                size: file.size,
                x: Math.min(rect.left, window.innerWidth - 280),
                y: rect.bottom + 6,
              });
            }}
            onMouseLeave={() => setHovered(null)}
            aria-label={`Preview ${file.filename}`}
            className={cn(
              'flex shrink-0 items-center justify-center overflow-hidden rounded-sm border border-line bg-white',
              'hover:ring-2 hover:ring-accent',
              wrap ? 'h-14 w-11' : 'h-6 w-5',
            )}
          >
            {isImage ? (
              // A plain <img>, not next/image, and deliberately so: the URL is signed, expires in
              // an hour, and lives on a cookie-free origin the image optimiser cannot fetch
              // through. Optimising it would mean proxying private files through the app server.
              <img
                src={file.url}
                alt=""
                className="h-full w-full object-cover"
                loading="lazy"
              />
            ) : isDoc ? (
              // A miniature "page": faint text lines, the way Airtable's document thumbnails read
              // at this size — honest about being a document without fetching the whole file.
              <span aria-hidden="true" className={cn('flex w-full flex-col bg-white', wrap ? 'gap-1 p-1.5 pt-2' : 'gap-[2px] p-[3px] pt-1')}>
                {[86, 70, 92, 60].slice(0, wrap ? 4 : 3).map((width, i) => (
                  <span key={i} className="block h-[2px] rounded-full bg-slate-300" style={{ width: `${width}%` }} />
                ))}
              </span>
            ) : (
              <span aria-hidden="true" className={cn('text-tertiary', wrap ? 'text-lg' : 'text-2xs')}>
                {fileGlyph(file.mimeType)}
              </span>
            )}
          </button>
        );
      })}

      {/* Airtable's dark hover card: name, kind, size — portalled so the cell cannot clip it. */}
      {hovered &&
        typeof document !== 'undefined' &&
        createPortal(
          <div
            role="tooltip"
            style={{ left: hovered.x, top: hovered.y }}
            className="pointer-events-none fixed z-[70] max-w-[17rem] rounded-md bg-slate-900 px-3 py-2 text-white shadow-lg"
          >
            <p className="break-words text-xs font-medium leading-snug">{hovered.name}</p>
            <p className="mt-1 flex justify-between gap-4 text-2xs uppercase tracking-wide text-white/60">
              <span>{fileKind(hovered.mime, hovered.name)}</span>
              <span>{formatBytes(hovered.size)}</span>
            </p>
          </div>,
          document.body,
        )}
      {!wrap && files.length > 6 && (
        <span className="shrink-0 text-2xs text-tertiary">+{files.length - 6}</span>
      )}

      {/* Airtable's "Expand cell": every file large, in a gallery. */}
      {files.length > 0 && (
        <button
          type="button"
          aria-label="Expand attachments"
          title="Expand cell"
          onMouseDown={(event) => event.stopPropagation()}
          onDoubleClick={(event) => event.stopPropagation()}
          onClick={(event) => {
            event.stopPropagation();
            setGalleryOpen(true);
          }}
          className={cn(
            'shrink-0 rounded px-1 text-2xs leading-5 text-tertiary hover:bg-sunken hover:text-accent-text',
            wrap ? 'opacity-70' : 'opacity-0 focus-visible:opacity-100 group-hover/cell:opacity-100',
          )}
        >
          ⤢
        </button>
      )}

      {/*
       * Pushed to the right so it sits in the same place whether the cell holds nothing or five
       * files — a control that moves as content grows is one people stop finding.
       */}
      <button
        type="button"
        disabled={busy}
        aria-label={busy ? 'Uploading' : `Add a file to ${'this cell'}`}
        title={failure ?? 'Add a file'}
        // The cell's own mousedown selects and its dblclick edits; neither should fire from here.
        onMouseDown={(event) => event.stopPropagation()}
        onDoubleClick={(event) => event.stopPropagation()}
        onClick={(event) => {
          event.stopPropagation();
          inputRef.current?.click();
        }}
        className={cn(
          'shrink-0 rounded px-1 text-2xs leading-5',
          wrap ? 'ml-1' : 'ml-auto',
          wrap ? 'opacity-70' : 'opacity-0 focus-visible:opacity-100 group-hover/cell:opacity-100',
          // An empty cell keeps the control visible: there is no content to hover over, and an
          // invisible-until-hover button in an empty cell reads as an empty cell.
          files.length === 0 && 'opacity-60',
          failure ? 'text-danger' : 'text-tertiary hover:bg-sunken hover:text-secondary',
          busy && 'animate-pulse',
        )}
      >
        {busy ? '…' : failure ? '!' : '+'}
      </button>

      {previewing !== null && (
        <AttachmentPreview
          files={files}
          startIndex={previewing}
          onClose={() => setPreviewing(null)}
        />
      )}

      {galleryOpen && (
        <AttachmentGallery
          files={files}
          title="Attachments"
          onClose={() => setGalleryOpen(false)}
        />
      )}
    </span>
  );
}

/** The tooltip's kind label — "PDF", "IMAGE", "AUDIO" — from mime, falling back to extension. */
function fileKind(mimeType: string, filename: string): string {
  if (mimeType === 'application/pdf') return 'PDF';
  if (mimeType.startsWith('image/')) return mimeType.slice(6).toUpperCase();
  if (mimeType.startsWith('audio/')) return 'AUDIO';
  if (mimeType.startsWith('video/')) return 'VIDEO';
  const ext = filename.split('.').pop();
  return ext && ext.length <= 5 ? ext.toUpperCase() : 'FILE';
}

function fileGlyph(mimeType: string): string {
  if (mimeType === 'application/pdf') return '▤';
  if (mimeType.startsWith('image/')) return '▣';
  if (mimeType.startsWith('video/')) return '▷';
  if (mimeType.startsWith('audio/')) return '♪';
  if (mimeType.startsWith('text/')) return '≡';
  return '⎙';
}

function formatBytes(size: number): string {
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${Math.round(size / 1024)} KB`;
  return `${(size / (1024 * 1024)).toFixed(1)} MB`;
}

// ── Helpers ─────────────────────────────────────────────────────────────────

interface Choice {
  id: string;
  label: string;
  color?: string;
}

function choicesOf(field: Field): Choice[] {
  const choices = field.options?.['choices'];
  return Array.isArray(choices) ? (choices as Choice[]) : [];
}

function isNumeric(type: string): boolean {
  return ['number', 'decimal', 'currency', 'percent', 'rating', 'progress', 'duration', 'autoNumber'].includes(type);
}

export function isComputed(type: string): boolean {
  return [
    'formula', 'rollup', 'lookup', 'count', 'autoNumber', 'recordId',
    'createdTime', 'lastModifiedTime', 'createdBy', 'lastModifiedBy', 'childRecords',
  ].includes(type);
}

function formatNumber(field: Field, value: unknown): string {
  if (typeof value !== 'number') return String(value);
  const precision = (field.options?.['precision'] as number | undefined) ?? 0;

  if (field.type === 'currency') {
    const code = (field.options?.['currencyCode'] as string | undefined) ?? 'USD';
    try {
      return new Intl.NumberFormat(undefined, { style: 'currency', currency: code }).format(value);
    } catch {
      return value.toFixed(precision);
    }
  }
  if (field.type === 'percent' || field.type === 'progress') return `${value}%`;
  return value.toFixed(precision);
}

/** The text a user edits. Select fields never reach here; they use a dropdown. */
function toEditableText(field: Field, value: unknown): string {
  if (value === null || value === undefined) return '';
  if (field.type === 'date') return String(value).slice(0, 10);
  if (Array.isArray(value)) return value.join(', ');
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

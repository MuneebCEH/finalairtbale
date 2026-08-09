'use client';

import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';

import { cn } from '@/lib/cn';

export interface PreviewableFile {
  id: string;
  filename: string;
  mimeType: string;
  size: number;
  url?: string | null;
}

/**
 * Full-size preview of an attachment, with the rest of the record's files reachable from it.
 *
 * Images render inline. Everything else — PDFs included — goes in a sandboxed `iframe` pointed at
 * the signed URL rather than being embedded by some viewer library: the file origin already sets
 * `Content-Security-Policy: sandbox` and `X-Content-Type-Options: nosniff` on what it serves, and
 * the browser's own PDF viewer is better than anything worth shipping here. A format the browser
 * cannot display falls back to a download, which is the honest outcome rather than a blank frame.
 */
export function AttachmentPreview({
  files,
  startIndex,
  onClose,
}: {
  files: PreviewableFile[];
  startIndex: number;
  onClose: () => void;
}) {
  const [index, setIndex] = useState(startIndex);
  const file = files[index];

  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') onClose();
      if (event.key === 'ArrowRight') setIndex((current) => Math.min(files.length - 1, current + 1));
      if (event.key === 'ArrowLeft') setIndex((current) => Math.max(0, current - 1));
    };

    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [files.length, onClose]);

  // Rendered before the early return so the hook order stays fixed; `mounted` also keeps the
  // portal off the server, where `document` does not exist.
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);

  if (!file || !mounted) return null;

  const isImage = file.mimeType.startsWith('image/');

  /*
   * Portalled to `document.body`, and it has to be.
   *
   * This renders inside a grid cell, and the grid's virtualisation wrapper carries a
   * `transform` — which makes it the containing block for `position: fixed` descendants. Left in
   * place the overlay was sized to the scrolled row strip (6716×320) instead of the viewport, and
   * the cell's `overflow-hidden` clipped what was left. It was in the DOM and invisible.
   */
  return createPortal(
    <div
      className="fixed inset-0 z-[60] flex flex-col bg-black/80"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <header className="flex shrink-0 items-center gap-3 px-4 py-3 text-white">
        <span className="min-w-0 flex-1 truncate text-sm font-medium">{file.filename}</span>
        <span className="shrink-0 text-xs text-white/60">
          {index + 1} of {files.length} · {formatBytes(file.size)}
        </span>

        {file.url && (
          <a
            href={file.url}
            download={file.filename}
            // The files origin is cookie-free by design; `noopener` keeps the opened document
            // from reaching back through `window.opener`.
            rel="noopener noreferrer"
            className="shrink-0 rounded px-2 py-1 text-xs text-white/80 hover:bg-white/10 hover:text-white"
          >
            Download
          </a>
        )}

        <button
          type="button"
          aria-label="Close preview"
          onClick={onClose}
          className="shrink-0 rounded px-2 py-1 text-white/80 hover:bg-white/10 hover:text-white"
        >
          ✕
        </button>
      </header>

      <div className="flex min-h-0 flex-1 items-center gap-2 px-2 pb-4">
        <StepButton
          direction="previous"
          disabled={index === 0}
          onClick={() => setIndex((current) => Math.max(0, current - 1))}
        />

        <div className="flex h-full min-w-0 flex-1 items-center justify-center">
          {!file.url ? (
            <p className="text-sm text-white/70">
              This file could not be signed for viewing. It may have been removed.
            </p>
          ) : isImage ? (
            // A plain <img>, not next/image: the URL is signed, expires within the hour, and is
            // served from a cookie-free origin the image optimiser cannot fetch through.
            <img
              src={file.url}
              alt={file.filename}
              className="max-h-full max-w-full object-contain"
            />
          ) : (
            <iframe
              src={file.url}
              title={file.filename}
              // Nothing in an uploaded document needs scripts, forms or navigation.
              sandbox=""
              className="h-full w-full rounded bg-white"
            />
          )}
        </div>

        <StepButton
          direction="next"
          disabled={index === files.length - 1}
          onClick={() => setIndex((current) => Math.min(files.length - 1, current + 1))}
        />
      </div>
    </div>,
    document.body,
  );
}

function StepButton({
  direction,
  disabled,
  onClick,
}: {
  direction: 'previous' | 'next';
  disabled: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      aria-label={`${direction === 'next' ? 'Next' : 'Previous'} attachment`}
      disabled={disabled}
      onClick={onClick}
      className={cn(
        'shrink-0 rounded px-3 py-6 text-2xl text-white/70',
        'hover:bg-white/10 hover:text-white disabled:opacity-20 disabled:hover:bg-transparent',
      )}
    >
      {direction === 'next' ? '›' : '‹'}
    </button>
  );
}

function formatBytes(size: number): string {
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${Math.round(size / 1024)} KB`;
  return `${(size / (1024 * 1024)).toFixed(1)} MB`;
}

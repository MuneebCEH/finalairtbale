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
          ) : (
            <FilePreview file={file} large />
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

/**
 * Renders one file by what it actually is. PDFs go through an `<object>` — NOT a sandboxed
 * iframe: Chrome's built-in PDF viewer refuses to run inside `sandbox` and shows a broken page,
 * which is exactly the bug this replaced. Audio and video get native players (the medical data
 * has .mp3 voice notes). Anything else falls back to a download card.
 */
export function FilePreview({ file, large = false }: { file: PreviewableFile; large?: boolean }) {
  const url = file.url ?? '';
  const mime = file.mimeType ?? '';

  if (mime.startsWith('image/')) {
    // A plain <img>, not next/image: the URL is signed and served from a cookie-free origin
    // the image optimiser cannot fetch through.
    return <img src={url} alt={file.filename} className="max-h-full max-w-full rounded object-contain" />;
  }
  if (mime === 'application/pdf' || file.filename.toLowerCase().endsWith('.pdf')) {
    return (
      <object data={url} type="application/pdf" className="h-full w-full rounded bg-white" aria-label={file.filename}>
        <DownloadCard file={file} />
      </object>
    );
  }
  if (mime.startsWith('audio/') || /\.(mp3|wav|m4a|ogg)$/i.test(file.filename)) {
    return (
      <div className={cn('flex flex-col items-center gap-3', large && 'text-white')}>
        <span aria-hidden="true" className="text-4xl">🎙️</span>
        <span className="max-w-full truncate text-sm">{file.filename}</span>
        <audio controls src={url} className="w-72 max-w-full" />
      </div>
    );
  }
  if (mime.startsWith('video/') || /\.(mp4|mov|webm)$/i.test(file.filename)) {
    return <video controls src={url} className="max-h-full max-w-full rounded" />;
  }
  return <DownloadCard file={file} light={large} />;
}

function DownloadCard({ file, light = false }: { file: PreviewableFile; light?: boolean }) {
  return (
    <div className={cn('flex h-full flex-col items-center justify-center gap-2 p-4', light ? 'text-white' : 'text-secondary')}>
      <span aria-hidden="true" className="text-3xl">📄</span>
      <span className="max-w-full truncate text-sm">{file.filename}</span>
      {file.url && (
        <a
          href={file.url}
          download={file.filename}
          rel="noopener noreferrer"
          className="rounded bg-accent-subtle px-3 py-1 text-xs font-medium text-accent-text"
        >
          Download · {formatBytes(file.size)}
        </a>
      )}
    </div>
  );
}

/**
 * Airtable's expanded attachment cell: every file in the cell as a large preview card. A card
 * click drills into the full lightbox (arrows, download). Portalled for the same containing-block
 * reason as the lightbox above.
 */
export function AttachmentGallery({
  files,
  title,
  onClose,
}: {
  files: PreviewableFile[];
  title: string;
  onClose: () => void;
}) {
  const [lightboxAt, setLightboxAt] = useState<number | null>(null);
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);

  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  if (!mounted) return null;

  if (lightboxAt !== null) {
    return (
      <AttachmentPreview files={files} startIndex={lightboxAt} onClose={() => setLightboxAt(null)} />
    );
  }

  return createPortal(
    <div
      className="fixed inset-0 z-[60] flex items-center justify-center bg-black/50 p-6"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div className="flex max-h-full w-full max-w-3xl flex-col rounded-lg bg-surface shadow-lg">
        <header className="flex shrink-0 items-center gap-2 border-b border-line px-4 py-2.5">
          <span aria-hidden="true" className="text-sm text-tertiary">📎</span>
          <span className="min-w-0 flex-1 truncate text-sm font-medium text-primary">{title}</span>
          <span className="shrink-0 text-xs text-tertiary">
            {files.length} file{files.length === 1 ? '' : 's'}
          </span>
          <button
            type="button"
            aria-label="Close attachments"
            onClick={onClose}
            className="shrink-0 rounded px-2 py-1 text-secondary hover:bg-sunken hover:text-primary"
          >
            ✕
          </button>
        </header>

        <div className="grid min-h-0 flex-1 grid-cols-2 gap-3 overflow-y-auto p-4 sm:grid-cols-3">
          {files.map((file, index) => (
            <figure key={file.id} className="flex flex-col gap-1">
              <button
                type="button"
                onClick={() => setLightboxAt(index)}
                aria-label={`Open ${file.filename}`}
                className="h-44 overflow-hidden rounded border border-line bg-white hover:ring-2 hover:ring-accent"
              >
                {file.url && (file.mimeType?.startsWith('image/') ? (
                  <img src={file.url} alt="" className="h-full w-full object-cover" loading="lazy" />
                ) : file.mimeType === 'application/pdf' || file.filename.toLowerCase().endsWith('.pdf') ? (
                  // A shrunken live render of the document — pointer-events off so the click
                  // lands on the card, not inside the embedded viewer.
                  <object
                    data={`${file.url}#toolbar=0&view=FitH`}
                    type="application/pdf"
                    aria-hidden="true"
                    className="pointer-events-none h-full w-full"
                  >
                    <span className="flex h-full items-center justify-center text-3xl">📄</span>
                  </object>
                ) : (
                  <span className="flex h-full items-center justify-center text-3xl" aria-hidden="true">
                    {file.mimeType?.startsWith('audio/') ? '🎙️' : file.mimeType?.startsWith('video/') ? '🎞️' : '📄'}
                  </span>
                ))}
              </button>
              <figcaption className="truncate text-xs text-secondary" title={file.filename}>
                {file.filename}
              </figcaption>
            </figure>
          ))}
        </div>
      </div>
    </div>,
    document.body,
  );
}

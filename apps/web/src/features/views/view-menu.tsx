'use client';

import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';

import { Button } from '@/components/ui/button';
import { dataApi, type Field, type SavedView } from '@/features/data/api';

import type { ViewState } from './toolbar';

/**
 * The active view's menu — Airtable's "Grid view ▾" chip: switch between saved views, rename,
 * duplicate, delete, download the view as CSV, print it. Views live on the server, so a rename
 * here is a rename for everyone.
 */
export function ViewMenu({
  tableId,
  tableName,
  views,
  activeViewId,
  fields,
  viewState,
  search,
  onSwitch,
}: {
  tableId: string;
  tableName: string;
  views: SavedView[];
  activeViewId: string | null;
  /** Visible fields in render order — what the CSV and the printout contain. */
  fields: Field[];
  viewState: ViewState;
  search: string;
  onSwitch: (view: SavedView) => void;
}) {
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [name, setName] = useState('');
  const [exporting, setExporting] = useState(false);

  const active = views.find((view) => view.id === activeViewId) ?? null;

  const refresh = () => queryClient.invalidateQueries({ queryKey: ['views', tableId] });

  const rename = useMutation({
    mutationFn: () => dataApi.updateView(activeViewId!, { name: name.trim() }),
    onSuccess: async () => {
      await refresh();
      setRenaming(false);
      setOpen(false);
    },
  });

  const duplicate = useMutation({
    mutationFn: () =>
      dataApi.createView(tableId, {
        name: `${active?.name ?? 'View'} copy`,
        type: active?.type ?? 'grid',
        config: active?.config ?? null,
      }),
    onSuccess: async (created) => {
      await refresh();
      onSwitch(created);
      setOpen(false);
    },
  });

  const [copied, setCopied] = useState(false);

  const share = useMutation({
    mutationFn: () => dataApi.shareView(activeViewId!),
    onSuccess: async (updated) => {
      await refresh();
      void copyShareLink(updated.shareSlug ?? null);
    },
  });

  const unshare = useMutation({
    mutationFn: () => dataApi.unshareView(activeViewId!),
    onSuccess: () => void refresh(),
  });

  /** The public page lives in the same static export; the slug rides the query string. */
  function shareUrl(slug: string): string {
    return `${window.location.origin}/share/?s=${slug}`;
  }

  async function copyShareLink(slug: string | null) {
    if (!slug) return;
    try {
      await navigator.clipboard.writeText(shareUrl(slug));
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard can be denied — the prompt still shows the URL for hand-copying.
      window.prompt('Copy this share link:', shareUrl(slug));
    }
  }

  const remove = useMutation({
    mutationFn: () => dataApi.deleteView(activeViewId!),
    onSuccess: async () => {
      await refresh();
      const next = views.find((view) => view.id !== activeViewId);
      if (next) onSwitch(next);
      setOpen(false);
    },
  });

  /** Every record of the current view (filter/sort/search applied), across all pages. */
  async function fetchAllRecords() {
    const all = [];
    let cursor: string | undefined;
    for (let page = 0; page < 100; page++) {
      const result = await dataApi.queryRecords(tableId, {
        limit: 200,
        ...(cursor ? { cursor } : {}),
        ...(viewState.filter ? { filter: viewState.filter } : {}),
        ...(viewState.sorts.length > 0 ? { sort: viewState.sorts } : {}),
        ...(viewState.groups.length > 0 ? { group: viewState.groups } : {}),
        ...(search.trim() ? { search: search.trim() } : {}),
      });
      all.push(...result.data);
      if (!result.meta.hasMore || !result.meta.nextCursor) break;
      cursor = result.meta.nextCursor;
    }
    return all;
  }

  function cellText(value: unknown): string {
    if (value === null || value === undefined) return '';
    if (Array.isArray(value)) {
      return value
        .map((item) =>
          item && typeof item === 'object' && 'filename' in item
            ? String((item as { filename?: unknown }).filename ?? '')
            : cellText(item),
        )
        .filter(Boolean)
        .join(', ');
    }
    if (typeof value === 'object') return JSON.stringify(value);
    return String(value);
  }

  async function downloadCsv() {
    setExporting(true);
    try {
      const records = await fetchAllRecords();
      const quote = (text: string) => `"${text.replaceAll('"', '""')}"`;
      const lines = [
        fields.map((field) => quote(field.name)).join(','),
        ...records.map((record) =>
          fields.map((field) => quote(cellText(record.fields[field.id]))).join(','),
        ),
      ];
      // BOM so Excel opens UTF-8 (names with accents) correctly.
      const blob = new Blob(['﻿' + lines.join('\r\n')], { type: 'text/csv;charset=utf-8' });
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = `${tableName} - ${active?.name ?? 'view'}.csv`;
      link.click();
      URL.revokeObjectURL(url);
    } finally {
      setExporting(false);
      setOpen(false);
    }
  }

  async function printView() {
    setExporting(true);
    try {
      const records = await fetchAllRecords();
      const escape = (text: string) =>
        text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
      const win = window.open('', '_blank');
      if (!win) return;
      win.document.write(`<!doctype html><title>${escape(tableName)}</title>
<style>body{font:12px system-ui;margin:24px}h1{font-size:16px}table{border-collapse:collapse;width:100%}
th,td{border:1px solid #ccc;padding:4px 6px;text-align:left;font-size:11px}th{background:#f4f4f4}</style>
<h1>${escape(tableName)} — ${escape(active?.name ?? 'view')} (${records.length} records)</h1>
<table><thead><tr>${fields.map((field) => `<th>${escape(field.name)}</th>`).join('')}</tr></thead>
<tbody>${records
        .map(
          (record) =>
            `<tr>${fields.map((field) => `<td>${escape(cellText(record.fields[field.id]))}</td>`).join('')}</tr>`,
        )
        .join('')}</tbody></table>`);
      win.document.close();
      win.focus();
      win.print();
    } finally {
      setExporting(false);
      setOpen(false);
    }
  }

  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        className="flex items-center gap-1.5 rounded px-2 py-1 text-sm font-medium text-primary hover:bg-sunken"
      >
        <span aria-hidden="true">▦</span>
        {active?.name ?? 'Grid view'}
        <span aria-hidden="true" className="text-xs text-tertiary">
          ▾
        </span>
      </button>

      {open && (
        <>
          <button
            type="button"
            aria-label="Close view menu"
            onClick={() => setOpen(false)}
            className="fixed inset-0 z-20 cursor-default"
          />
          <div
            role="menu"
            aria-label="View menu"
            className="absolute left-0 top-full z-30 mt-1 w-72 rounded-md border border-line bg-surface p-1 shadow-lg"
          >
            {views.length > 1 && (
              <>
                {views.map((view) => (
                  <button
                    key={view.id}
                    type="button"
                    role="menuitem"
                    onClick={() => {
                      onSwitch(view);
                      setOpen(false);
                    }}
                    className={`flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-sm hover:bg-sunken ${
                      view.id === activeViewId ? 'text-accent-text' : 'text-primary'
                    }`}
                  >
                    <span aria-hidden="true" className="text-xs">
                      ▦
                    </span>
                    <span className="truncate">{view.name}</span>
                    {view.id === activeViewId && <span className="ml-auto">✓</span>}
                  </button>
                ))}
                <div className="mx-1 my-1 border-t border-line" />
              </>
            )}

            {renaming ? (
              <form
                className="flex items-center gap-1 p-1"
                onSubmit={(event) => {
                  event.preventDefault();
                  if (name.trim()) rename.mutate();
                }}
              >
                <input
                  autoFocus
                  value={name}
                  onChange={(event) => setName(event.target.value)}
                  aria-label="View name"
                  className="h-8 min-w-0 flex-1 rounded border border-line bg-surface px-2 text-sm text-primary"
                />
                <Button type="submit" size="sm" variant="primary" loading={rename.isPending} disabled={!name.trim()}>
                  Save
                </Button>
              </form>
            ) : (
              <>
                <Item
                  label="Rename view"
                  icon="✎"
                  onClick={() => {
                    setName(active?.name ?? '');
                    setRenaming(true);
                  }}
                />
                <Item
                  label={duplicate.isPending ? 'Duplicating…' : 'Duplicate view'}
                  icon="⧉"
                  onClick={() => duplicate.mutate()}
                />
                <div className="mx-1 my-1 border-t border-line" />
                <Item label={exporting ? 'Preparing…' : 'Download CSV'} icon="⇩" onClick={() => void downloadCsv()} />
                <Item label="Print view" icon="⎙" onClick={() => void printView()} />
                <div className="mx-1 my-1 border-t border-line" />
                {active?.shareSlug ? (
                  <>
                    <Item
                      label={copied ? 'Link copied ✓' : 'Copy share link'}
                      icon="🔗"
                      onClick={() => void copyShareLink(active.shareSlug ?? null)}
                    />
                    <Item
                      label={unshare.isPending ? 'Stopping…' : 'Stop sharing'}
                      icon="⊘"
                      onClick={() => unshare.mutate()}
                    />
                  </>
                ) : (
                  <Item
                    label={share.isPending ? 'Creating link…' : copied ? 'Link copied ✓' : 'Share view (public link)'}
                    icon="🔗"
                    onClick={() => share.mutate()}
                  />
                )}
                <div className="mx-1 my-1 border-t border-line" />
                <Item
                  label={remove.isPending ? 'Deleting…' : 'Delete view'}
                  icon="🗑"
                  danger
                  disabled={views.length <= 1}
                  onClick={() => {
                    if (window.confirm(`Delete the view “${active?.name}”?`)) remove.mutate();
                  }}
                />
              </>
            )}
          </div>
        </>
      )}
    </div>
  );
}

function Item({
  label,
  icon,
  danger,
  disabled,
  onClick,
}: {
  label: string;
  icon: string;
  danger?: boolean;
  disabled?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      role="menuitem"
      disabled={disabled}
      onClick={onClick}
      className={`flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-sm ${
        disabled
          ? 'cursor-not-allowed opacity-50'
          : danger
            ? 'text-danger-text hover:bg-sunken'
            : 'text-primary hover:bg-sunken'
      }`}
    >
      <span aria-hidden="true" className="w-4 text-center text-xs">
        {icon}
      </span>
      {label}
    </button>
  );
}

'use client';

import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';

import { Button } from '@/components/ui/button';
import { Alert } from '@/components/ui/feedback';
import { dataApi } from '@/features/data/api';
import { ApiError } from '@/lib/api-client';

/**
 * The active table tab's menu — Airtable's caret menu: Import data, Rename, Duplicate,
 * Clear data, Delete. Destructive entries confirm first; everything runs against the API and
 * refreshes the table list, so what the tabs show is always what the server holds.
 */
export function TableMenu({
  tableId,
  tableName,
  baseId,
  onDeleted,
  onClose,
}: {
  tableId: string;
  tableName: string;
  baseId: string;
  /** Called after the table is gone so the page can select a neighbour. */
  onDeleted: () => void;
  onClose: () => void;
}) {
  const queryClient = useQueryClient();
  const [mode, setMode] = useState<'menu' | 'rename' | 'import'>('menu');
  const [name, setName] = useState(tableName);

  const refresh = async () => {
    await queryClient.invalidateQueries({ queryKey: ['tables', baseId] });
  };

  const rename = useMutation({
    mutationFn: () => dataApi.updateTable(tableId, { name: name.trim() }),
    onSuccess: async () => {
      await refresh();
      onClose();
    },
  });

  const duplicate = useMutation({
    mutationFn: () => dataApi.duplicateTable(tableId),
    onSuccess: async () => {
      await refresh();
      onClose();
    },
  });

  const clear = useMutation({
    mutationFn: () => dataApi.clearTable(tableId),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['records', tableId] });
      await refresh();
      onClose();
    },
  });

  const remove = useMutation({
    mutationFn: () => dataApi.deleteTable(tableId),
    onSuccess: async () => {
      await refresh();
      onDeleted();
      onClose();
    },
  });

  const error =
    rename.error ?? duplicate.error ?? clear.error ?? remove.error ?? null;

  return (
    <>
      <button
        type="button"
        aria-label="Close table menu"
        onClick={onClose}
        className="fixed inset-0 z-20 cursor-default"
      />
      <div
        role="menu"
        aria-label={`${tableName} table menu`}
        className="absolute left-0 top-full z-30 mt-1 w-72 rounded-md border border-line bg-surface p-1 shadow-lg"
      >
        {error instanceof ApiError && (
          <Alert tone="danger" className="m-1">
            {error.message}
          </Alert>
        )}

        {mode === 'rename' ? (
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
              aria-label="Table name"
              className="h-8 min-w-0 flex-1 rounded border border-line bg-surface px-2 text-sm text-primary"
            />
            <Button type="submit" size="sm" variant="primary" loading={rename.isPending} disabled={!name.trim()}>
              Save
            </Button>
          </form>
        ) : mode === 'import' ? (
          <ImportIntoTable
            tableId={tableId}
            onDone={async () => {
              await queryClient.invalidateQueries({ queryKey: ['records', tableId] });
              await queryClient.invalidateQueries({ queryKey: ['fields', tableId] });
              onClose();
            }}
            onBack={() => setMode('menu')}
          />
        ) : (
          <>
            <MenuItem icon="⇪" label="Import data" hint="CSV, Excel or pasted rows" onClick={() => setMode('import')} />
            <MenuItem icon="✎" label="Rename table" onClick={() => setMode('rename')} />
            <MenuItem
              icon="⧉"
              label={duplicate.isPending ? 'Duplicating…' : 'Duplicate table'}
              onClick={() => duplicate.mutate()}
            />
            <div className="mx-1 my-1 border-t border-line" />
            <MenuItem
              icon="✕"
              label={clear.isPending ? 'Clearing…' : 'Clear data'}
              danger
              onClick={() => {
                if (window.confirm(`Delete ALL records in “${tableName}”? Fields and views stay.`)) {
                  clear.mutate();
                }
              }}
            />
            <MenuItem
              icon="🗑"
              label={remove.isPending ? 'Deleting…' : 'Delete table'}
              danger
              onClick={() => {
                if (window.confirm(`Delete the table “${tableName}” and everything in it?`)) {
                  remove.mutate();
                }
              }}
            />
          </>
        )}
      </div>
    </>
  );
}

function MenuItem({
  icon,
  label,
  hint,
  danger,
  onClick,
}: {
  icon: string;
  label: string;
  hint?: string;
  danger?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      role="menuitem"
      onClick={onClick}
      className={`flex w-full items-start gap-2 rounded px-2 py-1.5 text-left text-sm hover:bg-sunken ${
        danger ? 'text-danger-text' : 'text-primary'
      }`}
    >
      <span aria-hidden="true" className="w-4 pt-0.5 text-center text-xs">
        {icon}
      </span>
      <span className="min-w-0">
        <span className="block">{label}</span>
        {hint && <span className="block text-xs text-tertiary">{hint}</span>}
      </span>
    </button>
  );
}

type Cell = string | number | boolean | null;

/**
 * Import rows into THIS table: a file (.xlsx/.csv) or pasted rows. Parsing happens in the
 * browser with SheetJS — pasted text goes through the same parser so quoted commas survive.
 */
function ImportIntoTable({
  tableId,
  onDone,
  onBack,
}: {
  tableId: string;
  onDone: () => Promise<void>;
  onBack: () => void;
}) {
  const [tab, setTab] = useState<'file' | 'paste'>('file');
  const [pasted, setPasted] = useState('');
  const [parsed, setParsed] = useState<{ header: string[]; rows: Cell[][] } | null>(null);
  const [parseError, setParseError] = useState('');
  const [parsing, setParsing] = useState(false);
  const [firstRowIsHeader, setFirstRowIsHeader] = useState(true);
  const pasteTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const importMut = useMutation({
    mutationFn: () => {
      const { header, rows } = parsed!;
      return dataApi.importRowsIntoTable(tableId, {
        fields: header.map((name) => ({ name, type: 'singleLineText' })),
        rows,
      });
    },
    onSuccess: () => void onDone(),
  });

  async function parseWorkbook(input: ArrayBuffer | string) {
    const XLSX = await import('xlsx');
    const wb =
      typeof input === 'string'
        ? XLSX.read(input, { type: 'string' })
        : XLSX.read(input, { type: 'array', cellDates: true });
    const sheetName = wb.SheetNames[0];
    const sheet = sheetName ? wb.Sheets[sheetName] : undefined;
    if (!sheet) throw new Error('No rows found.');

    const aoa = XLSX.utils.sheet_to_json<Cell[]>(sheet, {
      header: 1,
      blankrows: false,
      raw: true,
      defval: '',
    });
    if (aoa.length === 0) throw new Error('No rows found.');

    const norm = (v: unknown): Cell => {
      if (v instanceof Date) return v.toISOString().slice(0, 10);
      if (typeof v === 'number' || typeof v === 'boolean' || v === null) return v;
      return String(v);
    };

    const first = aoa[0] ?? [];
    const header = firstRowIsHeader
      ? first.map((h, i) => String(h ?? '').trim() || `Column ${i + 1}`)
      : first.map((_, i) => `Column ${i + 1}`);
    const body = (firstRowIsHeader ? aoa.slice(1) : aoa).map((r) => header.map((_, i) => norm(r[i])));
    setParsed({ header, rows: body });
  }

  async function onFile(event: React.ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    if (!file) return;
    setParsing(true);
    setParseError('');
    setParsed(null);
    try {
      await parseWorkbook(await file.arrayBuffer());
    } catch (err) {
      setParseError(err instanceof Error ? err.message : 'Could not read that file.');
    } finally {
      setParsing(false);
    }
  }

  // Pasted text re-parses (debounced) as it changes, so the row count is always live.
  useEffect(() => {
    if (tab !== 'paste') return;
    if (pasteTimer.current) clearTimeout(pasteTimer.current);
    if (!pasted.trim()) {
      setParsed(null);
      return;
    }
    pasteTimer.current = setTimeout(() => {
      setParsing(true);
      setParseError('');
      parseWorkbook(pasted)
        .catch((err) => setParseError(err instanceof Error ? err.message : 'Could not parse that.'))
        .finally(() => setParsing(false));
    }, 300);
    return () => {
      if (pasteTimer.current) clearTimeout(pasteTimer.current);
    };
  }, [pasted, tab, firstRowIsHeader]);

  return (
    <div className="p-2">
      <div className="flex items-center gap-1">
        <button type="button" onClick={onBack} aria-label="Back" className="rounded px-1.5 py-0.5 text-sm text-secondary hover:bg-sunken">
          ‹
        </button>
        <span className="text-sm font-medium text-primary">Import data</span>
      </div>

      <div className="mt-2 flex gap-1">
        {(['file', 'paste'] as const).map((t) => (
          <button
            key={t}
            type="button"
            onClick={() => {
              setTab(t);
              setParsed(null);
              setParseError('');
            }}
            className={`rounded px-2 py-1 text-xs ${tab === t ? 'bg-accent-subtle text-accent-text' : 'text-secondary hover:bg-sunken'}`}
          >
            {t === 'file' ? 'CSV / Excel file' : 'Paste table data'}
          </button>
        ))}
      </div>

      {parseError && (
        <Alert tone="danger" className="mt-2">
          {parseError}
        </Alert>
      )}
      {importMut.error instanceof ApiError && (
        <Alert tone="danger" className="mt-2">
          {importMut.error.message}
        </Alert>
      )}

      {tab === 'file' ? (
        <input
          type="file"
          accept=".xlsx,.xls,.csv"
          onChange={onFile}
          className="mt-2 block w-full text-xs text-secondary file:mr-2 file:rounded file:border-0 file:bg-accent-subtle file:px-2 file:py-1.5 file:text-xs file:font-medium file:text-accent-text"
        />
      ) : (
        <textarea
          value={pasted}
          onChange={(event) => setPasted(event.target.value)}
          placeholder="Paste rows copied from Excel or Google Sheets…"
          rows={5}
          className="mt-2 w-full rounded border border-line bg-surface p-2 text-xs text-primary"
        />
      )}

      <label className="mt-2 flex items-center gap-1.5 text-xs text-secondary">
        <input
          type="checkbox"
          checked={firstRowIsHeader}
          onChange={(event) => setFirstRowIsHeader(event.target.checked)}
        />
        First row is field names
      </label>

      {parsing && <p className="mt-2 text-xs text-secondary">Reading…</p>}
      {parsed && (
        <p className="mt-2 text-xs text-secondary">
          {parsed.header.length} columns · {parsed.rows.length} rows. Columns matching an existing
          field name land in that field; the rest become new fields.
        </p>
      )}

      <div className="mt-2 flex gap-1.5">
        <Button
          size="sm"
          variant="primary"
          loading={importMut.isPending}
          disabled={!parsed || parsed.rows.length === 0}
          onClick={() => importMut.mutate()}
        >
          Import{parsed ? ` ${parsed.rows.length} rows` : ''}
        </Button>
        <Button size="sm" variant="ghost" onClick={onBack}>
          Cancel
        </Button>
      </div>
    </div>
  );
}

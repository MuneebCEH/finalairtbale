'use client';

import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useRouter } from 'next/navigation';
import { useRef, useState } from 'react';

import { Button } from '@/components/ui/button';
import { Alert, Card } from '@/components/ui/feedback';
import { Field } from '@/components/ui/field';
import { dataApi } from '@/features/data/api';
import { ApiError } from '@/lib/api-client';

/** Field types a spreadsheet column can map to. */
const FIELD_TYPES = [
  { value: 'singleLineText', label: 'Text' },
  { value: 'longText', label: 'Long text' },
  { value: 'number', label: 'Number' },
  { value: 'currency', label: 'Currency' },
  { value: 'percent', label: 'Percent' },
  { value: 'date', label: 'Date' },
  { value: 'checkbox', label: 'Checkbox' },
  { value: 'email', label: 'Email' },
  { value: 'url', label: 'URL' },
  { value: 'phone', label: 'Phone' },
];

type Cell = string | number | boolean | null;
type Parsed = { columns: { name: string; type: string }[]; rows: Cell[][] };

const DATE_RE = /^\d{4}-\d{2}-\d{2}([ T]\d{2}:\d{2})?/;

/** Guess a column's field type from a sample of its values. */
function detectType(samples: Cell[]): string {
  const vals = samples.filter((v) => v !== null && v !== '' && v !== undefined);
  if (vals.length === 0) return 'singleLineText';
  const all = (pred: (v: Cell) => boolean) => vals.every(pred);

  if (all((v) => typeof v === 'boolean')) return 'checkbox';
  if (all((v) => typeof v === 'number' || (typeof v === 'string' && v.trim() !== '' && !Number.isNaN(Number(v)))))
    return 'number';
  if (all((v) => typeof v === 'string' && DATE_RE.test(v))) return 'date';
  if (all((v) => typeof v === 'string' && /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(v))) return 'email';
  if (all((v) => typeof v === 'string' && /^https?:\/\//i.test(v))) return 'url';
  return 'singleLineText';
}

/**
 * Reads an .xlsx/.csv entirely in the browser (SheetJS), previews the detected columns as fields,
 * and posts the parsed data to the API which builds a base + table + records from it.
 */
export function ImportSpreadsheetCard({
  workspaceId,
  orgSlug,
  onCancel,
}: {
  workspaceId: string;
  orgSlug: string;
  onCancel: () => void;
}) {
  const router = useRouter();
  const queryClient = useQueryClient();
  const fileRef = useRef<HTMLInputElement>(null);

  const [fileName, setFileName] = useState('');
  const [baseName, setBaseName] = useState('');
  const [tableName, setTableName] = useState('');
  const [parsed, setParsed] = useState<Parsed | null>(null);
  const [parseError, setParseError] = useState('');
  const [parsing, setParsing] = useState(false);

  const importMut = useMutation({
    mutationFn: () =>
      dataApi.importSpreadsheet(workspaceId, {
        baseName: baseName.trim() || 'Imported',
        tableName: tableName.trim() || 'Sheet 1',
        fields: parsed!.columns,
        rows: parsed!.rows,
      }),
    onSuccess: async (base) => {
      await queryClient.invalidateQueries({ queryKey: ['bases', workspaceId] });
      router.push(`/app/b?org=${orgSlug}&base=${base.id}`);
    },
  });

  async function onFile(event: React.ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    if (!file) return;
    setParsing(true);
    setParseError('');
    setParsed(null);
    setFileName(file.name);
    if (!baseName) setBaseName(file.name.replace(/\.(xlsx|xls|csv)$/i, ''));

    try {
      const XLSX = await import('xlsx');
      const buf = await file.arrayBuffer();
      const wb = XLSX.read(buf, { type: 'array', cellDates: true });
      const sheetName = wb.SheetNames[0];
      const sheet = sheetName ? wb.Sheets[sheetName] : undefined;
      if (!sheetName || !sheet) throw new Error('The file has no sheets.');
      setTableName((t) => t || sheetName);

      const aoa = XLSX.utils.sheet_to_json<Cell[]>(sheet, {
        header: 1,
        blankrows: false,
        raw: true,
        defval: '',
      });
      if (aoa.length === 0) throw new Error('The sheet is empty.');

      // First row is the header; normalise every cell to a JSON-safe value.
      const norm = (v: unknown): Cell => {
        if (v instanceof Date) return v.toISOString().slice(0, 10);
        if (typeof v === 'number' || typeof v === 'boolean' || v === null) return v;
        return String(v);
      };

      const header = (aoa[0] ?? []).map((h, i) => String(h ?? '').trim() || `Column ${i + 1}`);
      const bodyRows = aoa.slice(1).map((r) => header.map((_, i) => norm(r[i])));

      const columns = header.map((name, i) => ({
        name,
        type: detectType(bodyRows.slice(0, 25).map((r) => r[i] ?? null)),
      }));

      setParsed({ columns, rows: bodyRows });
    } catch (err) {
      setParseError(err instanceof Error ? err.message : 'Could not read that file.');
    } finally {
      setParsing(false);
    }
  }

  function setColumnType(index: number, type: string) {
    setParsed((p) => (p ? { ...p, columns: p.columns.map((c, i) => (i === index ? { ...c, type } : c)) } : p));
  }

  return (
    <Card className="mt-6 p-5">
      <h2 className="text-md font-medium text-primary">Import from Excel</h2>
      <p className="mt-1 text-sm text-secondary">
        Upload an <code>.xlsx</code> or <code>.csv</code> file. The first row becomes your field names and every
        following row becomes a record.
      </p>

      {parseError && (
        <Alert tone="danger" className="mt-3">
          {parseError}
        </Alert>
      )}
      {importMut.error instanceof ApiError && (
        <Alert tone={importMut.error.code === 'PLAN_LIMIT_EXCEEDED' ? 'warning' : 'danger'} className="mt-3">
          {importMut.error.message}
        </Alert>
      )}

      <div className="mt-4">
        <input
          ref={fileRef}
          type="file"
          accept=".xlsx,.xls,.csv"
          onChange={onFile}
          className="block w-full text-sm text-secondary file:mr-3 file:rounded file:border-0 file:bg-accent-subtle file:px-3 file:py-2 file:text-sm file:font-medium file:text-accent-text hover:file:bg-accent-subtle/80"
        />
        {parsing && <p className="mt-2 text-sm text-secondary">Reading {fileName}…</p>}
      </div>

      {parsed && (
        <div className="mt-5 space-y-4">
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Base name" required value={baseName} onChange={(e) => setBaseName(e.target.value)} />
            <Field label="Table name" value={tableName} onChange={(e) => setTableName(e.target.value)} />
          </div>

          <div>
            <p className="text-sm font-medium text-primary">
              {parsed.columns.length} fields · {parsed.rows.length} records
            </p>
            <p className="mt-0.5 text-xs text-secondary">
              Review each field&apos;s type below. The first field is the primary field.
            </p>
            <ul className="mt-3 max-h-64 divide-y divide-subtle overflow-y-auto rounded border border-subtle">
              {parsed.columns.map((col, i) => (
                <li key={i} className="flex items-center gap-3 px-3 py-2">
                  <span className="min-w-0 flex-1 truncate text-sm text-primary">
                    {col.name}
                    {i === 0 && <span className="ml-1 text-2xs uppercase tracking-wide text-tertiary">primary</span>}
                  </span>
                  <select
                    value={col.type}
                    onChange={(e) => setColumnType(i, e.target.value)}
                    className="rounded border border-subtle bg-surface px-2 py-1 text-sm text-primary"
                  >
                    {FIELD_TYPES.map((t) => (
                      <option key={t.value} value={t.value}>
                        {t.label}
                      </option>
                    ))}
                  </select>
                </li>
              ))}
            </ul>
          </div>
        </div>
      )}

      <div className="mt-5 flex gap-2">
        <Button
          variant="primary"
          loading={importMut.isPending}
          disabled={!parsed || parsed.rows.length === 0 || !baseName.trim()}
          onClick={() => importMut.mutate()}
        >
          Import {parsed ? `${parsed.rows.length} rows` : ''}
        </Button>
        <Button variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </Card>
  );
}

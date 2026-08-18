'use client';

import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useRouter } from 'next/navigation';
import { useState } from 'react';

import { Button } from '@/components/ui/button';
import { Alert, Card } from '@/components/ui/feedback';
import { dataApi } from '@/features/data/api';
import { ApiError, apiPost } from '@/lib/api-client';
import { cn } from '@/lib/cn';

import { AiBuilderChat } from './ai-builder-chat';

/**
 * The guided workspace creator, Airtable-style: name the workspace and base, say how many tables
 * you want and what fields each should have — and it builds the whole thing. Field TYPES are
 * inferred from the names ("DOB" becomes a date, "Amount Paid" currency, "Status" a select), so
 * the result opens ready to use, not as a wall of text columns.
 */

interface TableDraft {
  name: string;
  fields: string; // comma-separated field names; blank = just the primary Name field
}

/** Name → field type, the "auto" in auto-create. Order matters: first match wins. */
function guessType(rawName: string): { type: string; options?: Record<string, unknown> } {
  const name = rawName.toLowerCase();
  const has = (...words: string[]) => words.some((w) => name.includes(w));

  if (has('date', 'dob', 'birth', 'deadline', 'due', 'shipped', 'delivered', 'day')) return { type: 'date' };
  if (has('amount', 'price', 'cost', 'paid', 'total', 'fee', 'salary', 'budget', 'payment')) return { type: 'currency' };
  if (has('qty', 'quantity', 'count', 'number', 'age', 'score')) return { type: 'number' };
  if (has('email')) return { type: 'email' };
  if (has('phone', 'mobile')) return { type: 'phone' };
  if (has('url', 'link', 'website')) return { type: 'url' };
  if (has('status', 'stage')) {
    return {
      type: 'singleSelect',
      options: {
        choices: [
          { id: 'new', label: 'New', position: 0, color: '#2563eb' },
          { id: 'in_progress', label: 'In progress', position: 1, color: '#f59e0b' },
          { id: 'done', label: 'Done', position: 2, color: '#16a34a' },
        ],
      },
    };
  }
  if (has('priority')) {
    return {
      type: 'singleSelect',
      options: {
        choices: [
          { id: 'low', label: 'Low', position: 0, color: '#64748b' },
          { id: 'medium', label: 'Medium', position: 1, color: '#f59e0b' },
          { id: 'high', label: 'High', position: 2, color: '#dc2626' },
        ],
      },
    };
  }
  if (has('notes', 'description', 'details', 'comment', 'address')) return { type: 'longText' };
  if (has('done', 'active', 'verified', 'checked', 'entered', 'billed', 'complete')) return { type: 'checkbox' };
  return { type: 'singleLineText' };
}

export function WorkspaceWizard({
  orgId,
  orgSlug,
  onClose,
}: {
  orgId: string;
  orgSlug: string;
  onClose: () => void;
}) {
  const router = useRouter();
  const queryClient = useQueryClient();

  // AI-first: describe it and it gets built. The manual form stays one tab away.
  const [mode, setMode] = useState<'ai' | 'manual'>('ai');
  const [wsName, setWsName] = useState('');
  const [baseName, setBaseName] = useState('');
  const [tables, setTables] = useState<TableDraft[]>([{ name: 'Table 1', fields: '' }]);
  const [progress, setProgress] = useState('');

  const setCount = (n: number) => {
    setTables((current) => {
      const next = current.slice(0, n);
      while (next.length < n) next.push({ name: `Table ${next.length + 1}`, fields: '' });
      return next;
    });
  };

  const build = useMutation({
    mutationFn: async () => {
      setProgress('Creating workspace…');
      const ws = await apiPost<{ id: string }>(`/v1/organizations/${orgId}/workspaces`, {
        name: wsName.trim(),
      });

      setProgress('Creating base…');
      const base = await dataApi.createBase(ws.id, baseName.trim() || wsName.trim());

      // The base arrives with one seeded table; it becomes the wizard's first table.
      const seeded = await dataApi.listTables(base.id);
      const firstId = seeded[0]?.id;

      for (let i = 0; i < tables.length; i++) {
        const draft = tables[i]!;
        const tableName = draft.name.trim() || `Table ${i + 1}`;
        setProgress(`Creating table ${i + 1} of ${tables.length} — ${tableName}…`);

        let tableId: string;
        if (i === 0 && firstId) {
          await dataApi.updateTable(firstId, { name: tableName });
          tableId = firstId;
        } else {
          const created = await dataApi.createTable(base.id, tableName);
          tableId = created.id;
        }

        const fieldNames = draft.fields
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean)
          .slice(0, 20);
        for (const fieldName of fieldNames) {
          const guessed = guessType(fieldName);
          setProgress(`${tableName}: adding "${fieldName}" (${guessed.type})…`);
          await dataApi.createField(tableId, {
            name: fieldName,
            type: guessed.type,
            ...(guessed.options ? { options: guessed.options } : {}),
          });
        }
      }

      return base;
    },
    onSuccess: async (base) => {
      await queryClient.invalidateQueries({ queryKey: ['workspaces'] });
      router.push(`/app/b?org=${orgSlug}&base=${base.id}`);
    },
    onError: () => setProgress(''),
  });

  return (
    <Card className="mt-6 p-5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h2 className="text-md font-semibold text-primary">New workspace</h2>
          <p className="mt-1 text-sm text-secondary">
            {mode === 'ai'
              ? 'Prompt likho — AI tables, fields, links, sample data aur dashboard sab bana dega.'
              : 'Say what you need — tables and their fields — and it will be built for you.'}
          </p>
        </div>
        <div className="flex rounded-lg border border-line p-0.5" role="tablist" aria-label="Builder mode">
          {(
            [
              ['ai', '🤖 AI Builder'],
              ['manual', '✎ Manual'],
            ] as const
          ).map(([value, label]) => (
            <button
              key={value}
              type="button"
              role="tab"
              aria-selected={mode === value}
              onClick={() => setMode(value)}
              className={cn(
                'rounded-md px-3 py-1.5 text-sm font-medium',
                mode === value ? 'bg-accent text-inverted' : 'text-secondary hover:bg-sunken',
              )}
            >
              {label}
            </button>
          ))}
        </div>
      </div>

      {mode === 'ai' ? (
        <div className="mt-4">
          <AiBuilderChat orgId={orgId} orgSlug={orgSlug} onClose={onClose} />
        </div>
      ) : (
        // Plain expression, not a nested component: a component defined per-render would remount
        // on every keystroke and drop the input focus.
        manualBody()
      )}
    </Card>
  );

  function manualBody() {
    return (
      <>
      {build.error instanceof ApiError && (
        <Alert tone="danger" className="mt-3">
          {build.error.message}
        </Alert>
      )}

      <form
        className="mt-4 space-y-4"
        onSubmit={(event) => {
          event.preventDefault();
          if (wsName.trim() && !build.isPending) build.mutate();
        }}
      >
        <div className="grid gap-3 sm:grid-cols-2">
          <label className="flex flex-col gap-1 text-xs font-medium text-secondary">
            Workspace name
            <input
              autoFocus
              value={wsName}
              onChange={(event) => setWsName(event.target.value)}
              placeholder="e.g. Billing team"
              className="h-9 rounded border border-line bg-surface px-2 text-sm font-normal text-primary"
            />
          </label>
          <label className="flex flex-col gap-1 text-xs font-medium text-secondary">
            First base name
            <input
              value={baseName}
              onChange={(event) => setBaseName(event.target.value)}
              placeholder="e.g. Claims 2026 (defaults to workspace name)"
              className="h-9 rounded border border-line bg-surface px-2 text-sm font-normal text-primary"
            />
          </label>
        </div>

        <label className="flex items-center gap-2 text-xs font-medium text-secondary">
          How many tables?
          <select
            value={tables.length}
            onChange={(event) => setCount(Number(event.target.value))}
            className="h-8 rounded border border-line bg-surface px-2 text-sm font-normal text-primary"
          >
            {[1, 2, 3, 4, 5, 6, 7, 8].map((n) => (
              <option key={n} value={n}>
                {n}
              </option>
            ))}
          </select>
        </label>

        <div className="space-y-2">
          {tables.map((table, index) => (
            <div key={index} className="grid gap-2 rounded-lg border border-line bg-sunken/40 p-3 sm:grid-cols-[minmax(8rem,14rem)_1fr]">
              <label className="flex flex-col gap-1 text-2xs font-medium uppercase tracking-wide text-tertiary">
                Table {index + 1}
                <input
                  value={table.name}
                  onChange={(event) =>
                    setTables((cur) => cur.map((t, i) => (i === index ? { ...t, name: event.target.value } : t)))
                  }
                  className="h-8 rounded border border-line bg-surface px-2 text-sm font-normal normal-case tracking-normal text-primary"
                />
              </label>
              <label className="flex flex-col gap-1 text-2xs font-medium uppercase tracking-wide text-tertiary">
                Fields (comma separated — types are auto-detected)
                <input
                  value={table.fields}
                  onChange={(event) =>
                    setTables((cur) => cur.map((t, i) => (i === index ? { ...t, fields: event.target.value } : t)))
                  }
                  placeholder="e.g. Patient Name, DOB, Amount Paid, Status, Phone, Notes"
                  className="h-8 rounded border border-line bg-surface px-2 text-sm font-normal normal-case tracking-normal text-primary"
                />
              </label>
            </div>
          ))}
        </div>

        {build.isPending && progress && (
          <p className="flex items-center gap-2 text-sm text-accent-text">
            <span aria-hidden="true" className="inline-block h-3 w-3 animate-spin rounded-full border-2 border-current border-t-transparent" />
            {progress}
          </p>
        )}

        <div className="flex gap-2">
          <Button type="submit" variant="primary" loading={build.isPending} disabled={!wsName.trim()}>
            ✨ Create it all
          </Button>
          <Button type="button" variant="ghost" onClick={onClose} disabled={build.isPending}>
            Cancel
          </Button>
        </div>
      </form>
      </>
    );
  }
}

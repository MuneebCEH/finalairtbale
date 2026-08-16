'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';

import { Button } from '@/components/ui/button';
import { Alert, EmptyState, LoadingState } from '@/components/ui/feedback';
import { dataApi, type AutomationDto, type Field } from '@/features/data/api';
import { ApiError } from '@/lib/api-client';
import { cn } from '@/lib/cn';

/**
 * The Automations builder, Airtable-style: the base's automations down the left, and the selected
 * one's trigger + actions on the right. Everything here is data on the server — the runner
 * executes these steps when records change, so what this page shows is what will actually happen.
 */

const TRIGGERS = [
  { value: 'record_created', label: 'When a record is created' },
  { value: 'record_updated', label: 'When a record is updated' },
  { value: 'record_matches', label: 'When a record matches conditions' },
] as const;

const ACTION_TYPES = [
  { value: 'update_record', label: 'Update the triggering record' },
  { value: 'create_record', label: 'Create a record in a table' },
  { value: 'webhook', label: 'Send a webhook (HTTPS POST)' },
  { value: 'send_email', label: 'Send an email' },
] as const;

const OPERATORS = [
  { value: 'is', label: 'is' },
  { value: 'isNot', label: 'is not' },
  { value: 'contains', label: 'contains' },
  { value: 'isEmpty', label: 'is empty' },
  { value: 'isNotEmpty', label: 'is not empty' },
  { value: 'gt', label: '>' },
  { value: 'lt', label: '<' },
] as const;

type Draft = Omit<AutomationDto, 'id' | 'runCount' | 'lastRunAt' | 'baseId'> & { id?: string };

const emptyDraft = (tableId: string): Draft => ({
  name: 'New automation',
  tableId,
  enabled: false,
  triggerType: 'record_created',
  triggerConfig: null,
  actions: [],
});

export function AutomationsSection({ baseId }: { baseId: string }) {
  const queryClient = useQueryClient();
  const [selectedId, setSelectedId] = useState<string | 'new' | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [notice, setNotice] = useState('');

  const automations = useQuery({
    queryKey: ['automations', baseId],
    queryFn: () => dataApi.listAutomations(baseId),
  });
  const tables = useQuery({
    queryKey: ['tables', baseId],
    queryFn: () => dataApi.listTables(baseId),
  });

  // Selecting an automation copies it into a local draft; Save writes the draft back.
  useEffect(() => {
    if (selectedId === 'new') {
      const firstTable = tables.data?.[0]?.id;
      if (firstTable) setDraft(emptyDraft(firstTable));
      return;
    }
    const found = automations.data?.find((a) => a.id === selectedId);
    setDraft(found ? { ...found } : null);
  }, [selectedId, automations.data, tables.data]);

  const refresh = () => queryClient.invalidateQueries({ queryKey: ['automations', baseId] });

  const save = useMutation({
    mutationFn: async () => {
      if (!draft) throw new Error('nothing to save');
      const payload = {
        name: draft.name.trim() || 'Untitled automation',
        tableId: draft.tableId,
        enabled: draft.enabled,
        triggerType: draft.triggerType,
        triggerConfig: draft.triggerConfig,
        actions: draft.actions,
      };
      return draft.id
        ? dataApi.updateAutomation(draft.id, payload)
        : dataApi.createAutomation(baseId, payload);
    },
    onSuccess: async (saved) => {
      await refresh();
      setSelectedId(saved.id);
      setNotice('Saved.');
    },
  });

  const remove = useMutation({
    mutationFn: (id: string) => dataApi.deleteAutomation(id),
    onSuccess: async () => {
      await refresh();
      setSelectedId(null);
      setDraft(null);
    },
  });

  const runTest = useMutation({
    mutationFn: (id: string) => dataApi.testAutomation(id),
    onSuccess: async (result) => {
      await refresh();
      setNotice(`Test ran against the newest record (${result.ranAgainst.slice(0, 12)}…). Check the table.`);
    },
  });

  const toggleEnabled = useMutation({
    mutationFn: (a: AutomationDto) => dataApi.updateAutomation(a.id, { enabled: !a.enabled }),
    onSuccess: refresh,
  });

  if (automations.isPending || tables.isPending) return <LoadingState label="Loading automations" />;

  const list = automations.data ?? [];
  const error = save.error ?? remove.error ?? runTest.error ?? null;

  return (
    <div className="flex h-full min-h-0">
      {/* ── Left: the base's automations ── */}
      <aside className="flex w-64 shrink-0 flex-col border-r border-line">
        <div className="flex items-center justify-between border-b border-line px-3 py-2">
          <span className="text-sm font-medium text-primary">Automations</span>
          <Button size="sm" variant="primary" onClick={() => setSelectedId('new')}>
            + New
          </Button>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto">
          {list.length === 0 && (
            <p className="px-3 py-4 text-xs text-tertiary">
              An automation watches this base — a record created or changed — and runs steps in
              response. Create your first one.
            </p>
          )}
          {list.map((a) => (
            <button
              key={a.id}
              type="button"
              onClick={() => setSelectedId(a.id)}
              className={cn(
                'flex w-full items-center gap-2 border-b border-line px-3 py-2.5 text-left hover:bg-sunken',
                selectedId === a.id && 'bg-accent-subtle/40',
              )}
            >
              <span
                aria-hidden="true"
                className={cn('h-2 w-2 shrink-0 rounded-full', a.enabled ? 'bg-success' : 'bg-line')}
                title={a.enabled ? 'On' : 'Off'}
              />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm text-primary">{a.name}</span>
                <span className="block truncate text-2xs text-tertiary">
                  {tables.data?.find((t) => t.id === a.tableId)?.name ?? '—'} · ran {a.runCount}×
                </span>
              </span>
              <span
                role="switch"
                aria-checked={a.enabled}
                tabIndex={0}
                onClick={(event) => {
                  event.stopPropagation();
                  toggleEnabled.mutate(a);
                }}
                onKeyDown={(event) => {
                  if (event.key === 'Enter' || event.key === ' ') {
                    event.preventDefault();
                    event.stopPropagation();
                    toggleEnabled.mutate(a);
                  }
                }}
                className={cn(
                  'relative h-4 w-7 shrink-0 cursor-pointer rounded-full transition-colors',
                  a.enabled ? 'bg-success' : 'bg-line',
                )}
              >
                <span
                  aria-hidden="true"
                  className={cn(
                    'absolute top-0.5 h-3 w-3 rounded-full bg-white transition-all',
                    a.enabled ? 'left-3.5' : 'left-0.5',
                  )}
                />
              </span>
            </button>
          ))}
        </div>
      </aside>

      {/* ── Right: the editor ── */}
      <section className="min-h-0 flex-1 overflow-y-auto p-4">
        {!draft ? (
          <EmptyState
            title="Pick an automation"
            description="Choose one on the left, or create a new one, to edit its trigger and actions."
            action={
              <Button variant="primary" onClick={() => setSelectedId('new')}>
                New automation
              </Button>
            }
          />
        ) : (
          <div className="mx-auto max-w-2xl space-y-4">
            {error instanceof ApiError && <Alert tone="danger">{error.message}</Alert>}
            {notice && !error && (
              <Alert tone="info" className="text-sm">
                {notice}
              </Alert>
            )}

            <div className="flex flex-wrap items-center gap-2">
              <input
                value={draft.name}
                onChange={(event) => setDraft({ ...draft, name: event.target.value })}
                aria-label="Automation name"
                className="h-9 min-w-0 flex-1 rounded border border-line bg-surface px-2 text-base font-medium text-primary"
              />
              <label className="flex items-center gap-1.5 text-sm text-secondary">
                <input
                  type="checkbox"
                  checked={draft.enabled}
                  onChange={(event) => setDraft({ ...draft, enabled: event.target.checked })}
                />
                On
              </label>
            </div>

            {/* Trigger */}
            <div className="rounded-md border border-line p-3">
              <p className="text-2xs font-medium uppercase tracking-wide text-tertiary">Trigger</p>
              <div className="mt-2 flex flex-wrap gap-2">
                <select
                  value={draft.tableId}
                  onChange={(event) => setDraft({ ...draft, tableId: event.target.value })}
                  aria-label="Table"
                  className="h-8 rounded border border-line bg-surface px-2 text-sm"
                >
                  {tables.data?.map((t) => (
                    <option key={t.id} value={t.id}>
                      {t.name}
                    </option>
                  ))}
                </select>
                <select
                  value={draft.triggerType}
                  onChange={(event) =>
                    setDraft({ ...draft, triggerType: event.target.value as Draft['triggerType'] })
                  }
                  aria-label="Trigger type"
                  className="h-8 min-w-0 flex-1 rounded border border-line bg-surface px-2 text-sm"
                >
                  {TRIGGERS.map((t) => (
                    <option key={t.value} value={t.value}>
                      {t.label}
                    </option>
                  ))}
                </select>
              </div>

              {draft.triggerType === 'record_matches' && (
                <ConditionsEditor
                  tableId={draft.tableId}
                  config={draft.triggerConfig ?? {}}
                  onChange={(triggerConfig) => setDraft({ ...draft, triggerConfig })}
                />
              )}
            </div>

            {/* Actions */}
            <div className="rounded-md border border-line p-3">
              <p className="text-2xs font-medium uppercase tracking-wide text-tertiary">Actions</p>
              {draft.actions.length === 0 && (
                <p className="mt-2 text-sm text-tertiary">No steps yet — add what should happen.</p>
              )}
              <div className="mt-2 space-y-3">
                {draft.actions.map((action, index) => (
                  <ActionEditor
                    key={index}
                    index={index}
                    action={action}
                    tableId={draft.tableId}
                    tables={tables.data ?? []}
                    onChange={(next) =>
                      setDraft({
                        ...draft,
                        actions: draft.actions.map((a, i) => (i === index ? next : a)),
                      })
                    }
                    onRemove={() =>
                      setDraft({ ...draft, actions: draft.actions.filter((_, i) => i !== index) })
                    }
                  />
                ))}
              </div>
              {draft.actions.length < 5 && (
                <Button
                  size="sm"
                  variant="ghost"
                  className="mt-2"
                  onClick={() =>
                    setDraft({
                      ...draft,
                      actions: [...draft.actions, { type: 'update_record', config: {} }],
                    })
                  }
                >
                  + Add action
                </Button>
              )}
            </div>

            <div className="flex flex-wrap items-center gap-2">
              <Button variant="primary" loading={save.isPending} onClick={() => save.mutate()}>
                Save
              </Button>
              {draft.id && (
                <>
                  <Button
                    variant="secondary"
                    loading={runTest.isPending}
                    onClick={() => runTest.mutate(draft.id!)}
                    title="Runs the steps once against the table's newest record"
                  >
                    Run test
                  </Button>
                  <Button
                    variant="ghost"
                    loading={remove.isPending}
                    onClick={() => {
                      if (window.confirm(`Delete the automation “${draft.name}”?`)) {
                        remove.mutate(draft.id!);
                      }
                    }}
                  >
                    Delete
                  </Button>
                </>
              )}
            </div>
          </div>
        )}
      </section>
    </div>
  );
}

/** The "record matches" condition rows: field · operator · value, joined by and/or. */
function ConditionsEditor({
  tableId,
  config,
  onChange,
}: {
  tableId: string;
  config: NonNullable<AutomationDto['triggerConfig']> | Record<string, never>;
  onChange: (config: AutomationDto['triggerConfig']) => void;
}) {
  const fields = useQuery({
    queryKey: ['fields', tableId],
    queryFn: () => dataApi.listFields(tableId),
  });
  const conditions = ('conditions' in config ? config.conditions : undefined) ?? [];
  const conjunction = ('conjunction' in config ? config.conjunction : undefined) ?? 'and';

  const set = (next: typeof conditions) => onChange({ conjunction, conditions: next });

  return (
    <div className="mt-2 space-y-1">
      {conditions.map((condition, index) => (
        <div key={index} className="flex items-center gap-1">
          <span className="w-10 shrink-0 text-xs text-tertiary">
            {index === 0 ? 'If' : conjunction}
          </span>
          <select
            value={condition.fieldId}
            onChange={(event) =>
              set(conditions.map((c, i) => (i === index ? { ...c, fieldId: event.target.value } : c)))
            }
            className="h-7 min-w-0 flex-1 rounded border border-line bg-surface px-1 text-sm"
          >
            {(fields.data ?? []).map((f) => (
              <option key={f.id} value={f.id}>
                {f.name}
              </option>
            ))}
          </select>
          <select
            value={condition.operator}
            onChange={(event) =>
              set(conditions.map((c, i) => (i === index ? { ...c, operator: event.target.value } : c)))
            }
            className="h-7 w-28 rounded border border-line bg-surface px-1 text-sm"
          >
            {OPERATORS.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
          {!['isEmpty', 'isNotEmpty'].includes(condition.operator) && (
            <input
              value={condition.value ?? ''}
              onChange={(event) =>
                set(conditions.map((c, i) => (i === index ? { ...c, value: event.target.value } : c)))
              }
              placeholder="Value"
              className="h-7 w-28 rounded border border-line bg-surface px-1 text-sm"
            />
          )}
          <button
            type="button"
            aria-label="Remove condition"
            onClick={() => set(conditions.filter((_, i) => i !== index))}
            className="px-1 text-tertiary hover:text-danger-text"
          >
            ✕
          </button>
        </div>
      ))}

      <div className="flex items-center gap-2 pt-1">
        <Button
          size="sm"
          variant="ghost"
          onClick={() => {
            const first = fields.data?.[0]?.id;
            if (first) set([...conditions, { fieldId: first, operator: 'is', value: '' }]);
          }}
        >
          + Add condition
        </Button>
        {conditions.length > 1 && (
          <select
            value={conjunction}
            onChange={(event) =>
              onChange({ conjunction: event.target.value as 'and' | 'or', conditions })
            }
            className="h-7 rounded border border-line bg-surface px-1 text-sm"
          >
            <option value="and">all must match</option>
            <option value="or">any may match</option>
          </select>
        )}
      </div>
    </div>
  );
}

/** One action step: its type plus the config form that type needs. */
function ActionEditor({
  index,
  action,
  tableId,
  tables,
  onChange,
  onRemove,
}: {
  index: number;
  action: AutomationDto['actions'][number];
  tableId: string;
  tables: { id: string; name: string }[];
  onChange: (action: AutomationDto['actions'][number]) => void;
  onRemove: () => void;
}) {
  const config = (action.config ?? {}) as Record<string, unknown>;
  const setConfig = (patch: Record<string, unknown>) =>
    onChange({ ...action, config: { ...config, ...patch } });

  const targetTableId =
    action.type === 'create_record' ? String(config['tableId'] ?? '') || tables[0]?.id || '' : tableId;

  return (
    <div className="rounded border border-line bg-sunken/40 p-2">
      <div className="flex items-center gap-2">
        <span className="text-xs text-tertiary">{index + 1}.</span>
        <select
          value={action.type}
          onChange={(event) => onChange({ type: event.target.value, config: {} })}
          className="h-7 min-w-0 flex-1 rounded border border-line bg-surface px-1 text-sm"
        >
          {ACTION_TYPES.map((t) => (
            <option key={t.value} value={t.value}>
              {t.label}
            </option>
          ))}
        </select>
        <button
          type="button"
          aria-label="Remove action"
          onClick={onRemove}
          className="px-1 text-tertiary hover:text-danger-text"
        >
          ✕
        </button>
      </div>

      <div className="mt-2 space-y-1.5">
        {action.type === 'create_record' && (
          <select
            value={targetTableId}
            onChange={(event) => setConfig({ tableId: event.target.value, values: {} })}
            aria-label="Target table"
            className="h-7 w-full rounded border border-line bg-surface px-1 text-sm"
          >
            {tables.map((t) => (
              <option key={t.id} value={t.id}>
                {t.name}
              </option>
            ))}
          </select>
        )}

        {(action.type === 'update_record' || action.type === 'create_record') && (
          <ValuesEditor
            tableId={action.type === 'create_record' ? targetTableId : tableId}
            values={(config['values'] as Record<string, string>) ?? {}}
            onChange={(values) => setConfig({ values })}
          />
        )}

        {action.type === 'webhook' && (
          <input
            value={String(config['url'] ?? '')}
            onChange={(event) => setConfig({ url: event.target.value })}
            placeholder="https://example.com/hook"
            className="h-7 w-full rounded border border-line bg-surface px-2 text-sm"
          />
        )}

        {action.type === 'send_email' && (
          <>
            <input
              value={String(config['to'] ?? '')}
              onChange={(event) => setConfig({ to: event.target.value })}
              placeholder="someone@example.com"
              className="h-7 w-full rounded border border-line bg-surface px-2 text-sm"
            />
            <input
              value={String(config['subject'] ?? '')}
              onChange={(event) => setConfig({ subject: event.target.value })}
              placeholder="Subject — use {{Field Name}} to insert values"
              className="h-7 w-full rounded border border-line bg-surface px-2 text-sm"
            />
            <textarea
              value={String(config['body'] ?? '')}
              onChange={(event) => setConfig({ body: event.target.value })}
              placeholder="Body — {{Patient Name}} style placeholders are filled from the record"
              rows={3}
              className="w-full rounded border border-line bg-surface px-2 py-1 text-sm"
            />
          </>
        )}
      </div>
    </div>
  );
}

/** field → value rows for update/create actions. */
function ValuesEditor({
  tableId,
  values,
  onChange,
}: {
  tableId: string;
  values: Record<string, string>;
  onChange: (values: Record<string, string>) => void;
}) {
  const fields = useQuery({
    queryKey: ['fields', tableId],
    queryFn: () => dataApi.listFields(tableId),
    enabled: tableId !== '',
  });

  const writable = (fields.data ?? []).filter(
    (f: Field) => !['formula', 'rollup', 'lookup', 'autoNumber', 'createdTime', 'lastModifiedTime'].includes(f.type),
  );
  const entries = Object.entries(values);
  const unused = writable.filter((f) => !(f.id in values));

  return (
    <div className="space-y-1">
      {entries.map(([fieldId, value]) => (
        <div key={fieldId} className="flex items-center gap-1">
          <span className="w-36 shrink-0 truncate text-xs text-secondary">
            {writable.find((f) => f.id === fieldId)?.name ?? fieldId}
          </span>
          <input
            value={value}
            onChange={(event) => onChange({ ...values, [fieldId]: event.target.value })}
            placeholder="Value to set"
            className="h-7 min-w-0 flex-1 rounded border border-line bg-surface px-2 text-sm"
          />
          <button
            type="button"
            aria-label="Remove value"
            onClick={() => {
              const next = { ...values };
              delete next[fieldId];
              onChange(next);
            }}
            className="px-1 text-tertiary hover:text-danger-text"
          >
            ✕
          </button>
        </div>
      ))}
      {unused.length > 0 && (
        <select
          value=""
          onChange={(event) => {
            if (event.target.value) onChange({ ...values, [event.target.value]: '' });
          }}
          aria-label="Add a field to set"
          className="h-7 rounded border border-line bg-surface px-1 text-xs text-secondary"
        >
          <option value="">+ Set a field…</option>
          {unused.map((f) => (
            <option key={f.id} value={f.id}>
              {f.name}
            </option>
          ))}
        </select>
      )}
    </div>
  );
}

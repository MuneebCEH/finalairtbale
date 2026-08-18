'use client';

import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useRouter } from 'next/navigation';
import { useRef, useState } from 'react';

import { Button } from '@/components/ui/button';
import { Alert } from '@/components/ui/feedback';
import { ApiError, apiPost, apiRequest } from '@/lib/api-client';
import { cn } from '@/lib/cn';

import { generatePlan, type Plan } from './ai-builder';
import { dataApi } from './api';

/**
 * The AI workspace chat: describe what you want in plain language (English or Roman Urdu) and it
 * answers with a concrete plan — tables, typed fields, links, sample data, dashboard — which one
 * click then actually builds. The "AI" is the deterministic planner in ai-builder.ts; the chat
 * shape matters because a plan you can read before it runs is what makes auto-building feel safe
 * rather than magical.
 */

interface ChatMessage {
  role: 'user' | 'assistant';
  text: string;
  plan?: Plan;
}

export function AiBuilderChat({
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

  const [wsName, setWsName] = useState('');
  const [draft, setDraft] = useState('');
  const [messages, setMessages] = useState<ChatMessage[]>([
    {
      role: 'assistant',
      text:
        'Tell me what to build — I will create the tables, fields, links, sample data and a dashboard.\n\n' +
        'Examples:\n' +
        '• "a clinic system — patients and appointments"\n' +
        '• "sales CRM with deals pipeline"\n' +
        '• "Patients: Name, DOB, Phone, Fee Paid; Visits: Date, Status"\n' +
        '• inventory / school / HR / invoices / events / property…',
    },
  ]);
  const [progress, setProgress] = useState('');
  const listRef = useRef<HTMLDivElement>(null);

  const latestPlan = [...messages].reverse().find((m) => m.plan)?.plan ?? null;

  const ask = (text: string) => {
    const plan = generatePlan(text);
    setMessages((current) => [
      ...current,
      { role: 'user', text },
      { role: 'assistant', text: plan.summary, plan },
    ]);
    if (!wsName.trim()) setWsName(plan.baseName);
    setDraft('');
    setTimeout(() => listRef.current?.scrollTo({ top: listRef.current.scrollHeight, behavior: 'smooth' }), 50);
  };

  const build = useMutation({
    mutationFn: async () => {
      const plan = latestPlan;
      if (!plan) throw new Error('No plan yet');
      return executePlan(orgId, wsName.trim() || plan.baseName, plan, setProgress);
    },
    onSuccess: async (baseId) => {
      await queryClient.invalidateQueries({ queryKey: ['workspaces'] });
      router.push(`/app/b?org=${orgSlug}&base=${baseId}`);
    },
    onError: () => setProgress(''),
  });

  return (
    <div className="flex flex-col gap-3">
      {build.error instanceof ApiError && <Alert tone="danger">{build.error.message}</Alert>}

      <label className="flex flex-col gap-1 text-xs font-medium text-secondary">
        Workspace name
        <input
          value={wsName}
          onChange={(event) => setWsName(event.target.value)}
          placeholder="AI will suggest one — or type your own"
          className="h-9 max-w-sm rounded border border-line bg-surface px-2 text-sm font-normal text-primary"
        />
      </label>

      {/* The conversation */}
      <div
        ref={listRef}
        className="max-h-80 space-y-2 overflow-y-auto rounded-lg border border-line bg-sunken/40 p-3"
      >
        {messages.map((message, index) => (
          <div key={index} className={cn('flex', message.role === 'user' ? 'justify-end' : 'justify-start')}>
            <div
              className={cn(
                'max-w-[85%] whitespace-pre-wrap rounded-lg px-3 py-2 text-sm',
                message.role === 'user'
                  ? 'bg-accent text-inverted'
                  : 'border border-line bg-surface text-primary',
              )}
            >
              {message.role === 'assistant' && (
                <span aria-hidden="true" className="mr-1.5">🤖</span>
              )}
              {/* Poor man's **bold** so plan summaries read well without a markdown engine. */}
              {message.text.split('**').map((part, i) =>
                i % 2 === 1 ? <strong key={i}>{part}</strong> : <span key={i}>{part}</span>,
              )}

              {message.plan && <PlanPreview plan={message.plan} />}
            </div>
          </div>
        ))}
      </div>

      {build.isPending && progress && (
        <p className="flex items-center gap-2 text-sm text-accent-text">
          <span aria-hidden="true" className="inline-block h-3 w-3 animate-spin rounded-full border-2 border-current border-t-transparent" />
          {progress}
        </p>
      )}

      <form
        className="flex items-end gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          const text = draft.trim();
          if (text && !build.isPending) ask(text);
        }}
      >
        <textarea
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && !event.shiftKey) {
              event.preventDefault();
              const text = draft.trim();
              if (text && !build.isPending) ask(text);
            }
          }}
          placeholder='e.g. "build a clinic system" or "Products: Name, SKU, Price, Stock Qty"'
          aria-label="Describe what to build"
          rows={2}
          className="min-h-[2.5rem] flex-1 resize-none rounded border border-line bg-surface p-2 text-sm text-primary"
        />
        <Button type="submit" size="sm" variant="secondary" disabled={!draft.trim() || build.isPending}>
          Send
        </Button>
      </form>

      <div className="flex gap-2">
        <Button
          type="button"
          variant="primary"
          loading={build.isPending}
          disabled={!latestPlan}
          onClick={() => build.mutate()}
        >
          ✨ Build it
        </Button>
        <Button type="button" variant="ghost" onClick={onClose} disabled={build.isPending}>
          Cancel
        </Button>
      </div>
    </div>
  );
}

/** The plan, laid out for reading before committing to it. */
function PlanPreview({ plan }: { plan: Plan }) {
  return (
    <div className="mt-2 space-y-1.5 border-t border-line pt-2">
      {plan.tables.map((table) => (
        <div key={table.name} className="text-xs">
          <span className="font-semibold">▦ {table.name}</span>{' '}
          <span className="text-tertiary">
            — Name{table.fields.map((field) => `, ${field.name}`).join('')}
            {table.samples.length > 0 ? ` · ${table.samples.length} sample rows` : ''}
          </span>
        </div>
      ))}
      {plan.widgets.length > 0 && (
        <div className="text-xs">
          <span className="font-semibold">📊 Dashboard</span>{' '}
          <span className="text-tertiary">— {plan.widgets.map((w) => w.title).join(' · ')}</span>
        </div>
      )}
    </div>
  );
}

/**
 * Runs the plan against the real API, in dependency order: tables → plain fields → link fields
 * (need target table ids) → rollup/count fields (need link + target field ids) → sample records
 * (links resolved to real record ids) → dashboard widgets.
 */
async function executePlan(
  orgId: string,
  wsName: string,
  plan: Plan,
  onProgress: (message: string) => void,
): Promise<string> {
  onProgress('Creating workspace…');
  const ws = await apiPost<{ id: string }>(`/v1/organizations/${orgId}/workspaces`, { name: wsName });

  onProgress('Creating base…');
  const base = await dataApi.createBase(ws.id, plan.baseName);
  const seeded = await dataApi.listTables(base.id);

  // Tables — the base's seeded first table becomes the plan's first.
  const tableIds: Record<string, string> = {};
  for (let i = 0; i < plan.tables.length; i++) {
    const table = plan.tables[i]!;
    onProgress(`Creating table "${table.name}"…`);
    if (i === 0 && seeded[0]) {
      await dataApi.updateTable(seeded[0].id, { name: table.name });
      tableIds[table.name] = seeded[0].id;
    } else {
      const created = await dataApi.createTable(base.id, table.name);
      tableIds[table.name] = created.id;
    }
  }

  // Plain fields first.
  for (const table of plan.tables) {
    for (const field of table.fields) {
      if (field.type === 'linkedRecord' || field.type === 'rollup' || field.type === 'count' || field.type === 'lookup') continue;
      onProgress(`${table.name}: adding "${field.name}" (${field.type})…`);
      await dataApi.createField(tableIds[table.name]!, {
        name: field.name,
        type: field.type,
        ...(field.options ? { options: field.options } : {}),
      });
    }
  }

  // Link fields — they need the target table's id.
  for (const table of plan.tables) {
    for (const field of table.fields) {
      if (field.type !== 'linkedRecord' || !field.linkTo || !tableIds[field.linkTo]) continue;
      onProgress(`${table.name}: linking to ${field.linkTo}…`);
      await dataApi.createField(tableIds[table.name]!, {
        name: field.name,
        type: 'linkedRecord',
        options: { linkedTableId: tableIds[field.linkTo] },
      });
    }
  }

  // Field ids by name, table by table — rollups and sample rows both address fields by name.
  const fieldIdByName: Record<string, Record<string, string>> = {};
  for (const table of plan.tables) {
    const fields = await dataApi.listFields(tableIds[table.name]!);
    fieldIdByName[table.name] = Object.fromEntries(fields.map((field) => [field.name, field.id]));
  }

  // Rollup / count — they need the link field's id and the target table's field id.
  for (const table of plan.tables) {
    for (const field of table.fields) {
      if (field.type !== 'rollup' && field.type !== 'count' && field.type !== 'lookup') continue;
      const linkFieldId = field.via ? fieldIdByName[table.name]?.[field.via] : undefined;
      const linkPlanField = table.fields.find((f) => f.name === field.via);
      const targetTable = linkPlanField?.linkTo;
      const targetFieldId =
        field.target && targetTable ? fieldIdByName[targetTable]?.[field.target] : undefined;
      if (!linkFieldId || (field.type !== 'count' && !targetFieldId)) continue;

      onProgress(`${table.name}: adding ${field.type} "${field.name}"…`);
      await dataApi.createField(tableIds[table.name]!, {
        name: field.name,
        type: field.type,
        options: {
          linkFieldId,
          ...(targetFieldId ? { targetFieldId } : {}),
          ...(field.aggregation ? { aggregation: field.aggregation } : {}),
        },
      });
    }
  }

  // Sample records, in plan order (link targets come first in every template). Sample link
  // values are row indices into the target table's own samples; here they become real ids.
  const recordIds: Record<string, string[]> = {};
  for (const table of plan.tables) {
    if (table.samples.length === 0) continue;
    onProgress(`${table.name}: adding ${table.samples.length} sample records…`);
    const byName = fieldIdByName[table.name] ?? {};
    const linkFieldNames = new Set(table.fields.filter((f) => f.type === 'linkedRecord').map((f) => f.name));
    const linkTargets = Object.fromEntries(
      table.fields.filter((f) => f.type === 'linkedRecord' && f.linkTo).map((f) => [f.name, f.linkTo as string]),
    );

    const rows = table.samples.map((sample) => {
      const fields: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(sample)) {
        const fieldId = byName[key];
        if (!fieldId) continue;
        if (linkFieldNames.has(key) && Array.isArray(value)) {
          const targetIds = recordIds[linkTargets[key] ?? ''] ?? [];
          fields[fieldId] = value.map((index) => targetIds[index as number]).filter(Boolean);
        } else {
          fields[fieldId] = value;
        }
      }
      return { fields };
    });

    const created = await dataApi.createRecords(tableIds[table.name]!, rows);
    recordIds[table.name] = (created.records ?? []).map((record) => record.id);
  }

  // The starter dashboard.
  if (plan.widgets.length > 0) {
    onProgress('Building dashboard…');
    const widgets = plan.widgets
      .filter((widget) => tableIds[widget.table])
      .map((widget, index) => ({
        id: `wgt_ai_${index}`,
        type: widget.type,
        title: widget.title,
        tableId: tableIds[widget.table]!,
        ...(widget.agg ? { agg: widget.agg } : {}),
        ...(widget.fieldName ? { fieldId: fieldIdByName[widget.table]?.[widget.fieldName] } : {}),
        ...(widget.groupFieldName
          ? { groupFieldId: fieldIdByName[widget.table]?.[widget.groupFieldName] }
          : {}),
      }));
    await apiRequest(`/v1/bases/${base.id}/interfaces`, { method: 'PUT', body: { widgets } });
  }

  onProgress('Done!');
  return base.id;
}

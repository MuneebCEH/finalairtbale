'use client';

import { useEffect, useState } from 'react';

import { apiDelete, apiPatch, apiRequest } from '@/lib/api-client';

interface FormFieldEntry {
  fieldId: string;
  label: string | null;
  required: boolean;
  hidden: boolean;
}

interface FormConfig {
  fields: FormFieldEntry[];
  submitText: string;
  confirmationMessage: string;
}

interface FullForm {
  id: string;
  title: string;
  description: string | null;
  slug: string;
  isPublished: boolean;
  submissionCount: number;
  config: FormConfig;
  fields: { id: string; name: string; type: string }[];
}

const API_URL = process.env['NEXT_PUBLIC_API_URL'] ?? '';

/**
 * Configures a form: which fields appear, which are required, the copy, and whether it is live.
 * The public page it produces is served by the API at `/v1/f/{slug}`.
 */
export function FormBuilder({
  formId,
  onClose,
  onChanged,
}: {
  formId: string;
  onClose: () => void;
  onChanged: () => void;
}) {
  const [form, setForm] = useState<FullForm | null>(null);
  const [saving, setSaving] = useState(false);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    apiRequest<{ data: FullForm }>(`/v1/forms/${formId}`).then((r) => setForm(r.data));
  }, [formId]);

  if (!form) return <div className="p-4 text-sm text-tertiary">Loading form…</div>;

  const nameOf = (fieldId: string) => form.fields.find((f) => f.id === fieldId)?.name ?? fieldId;
  const patch = (changes: Partial<FullForm>) => setForm({ ...form, ...changes });
  const patchConfig = (changes: Partial<FormConfig>) =>
    setForm({ ...form, config: { ...form.config, ...changes } });
  const patchField = (fieldId: string, changes: Partial<FormFieldEntry>) =>
    patchConfig({
      fields: form.config.fields.map((f) => (f.fieldId === fieldId ? { ...f, ...changes } : f)),
    });

  const shareUrl = `${API_URL}/v1/f/${form.slug}`;

  const save = async (extra: Partial<FullForm> = {}) => {
    const next = { ...form, ...extra };
    setSaving(true);
    try {
      // apiPatch unwraps the `data` envelope, so this resolves to the FullForm directly.
      const result = await apiPatch<FullForm>(`/v1/forms/${form.id}`, {
        title: next.title,
        description: next.description,
        isPublished: next.isPublished,
        config: next.config,
      });
      setForm(result);
      onChanged();
    } finally {
      setSaving(false);
    }
  };

  const remove = async () => {
    if (!confirm('Delete this form? Its responses stay as records.')) return;
    await apiDelete(`/v1/forms/${form.id}`);
    onChanged();
    onClose();
  };

  return (
    <div className="mx-auto max-w-2xl px-4 py-4">
      <div className="mb-4 flex items-center gap-2">
        <button onClick={onClose} className="text-sm text-accent-text hover:underline">
          ← Forms
        </button>
        <span className="ml-auto text-xs text-tertiary">
          {form.submissionCount} {form.submissionCount === 1 ? 'response' : 'responses'}
        </span>
        <label className="flex items-center gap-1.5 text-sm">
          <input
            type="checkbox"
            checked={form.isPublished}
            onChange={(e) => save({ isPublished: e.target.checked })}
          />
          Published
        </label>
      </div>

      {form.isPublished && (
        <div className="mb-4 flex items-center gap-2 rounded-md border border-line bg-sunken px-3 py-2 text-xs">
          <span className="truncate text-secondary">{shareUrl}</span>
          <button
            onClick={() => {
              void navigator.clipboard?.writeText(shareUrl);
              setCopied(true);
              setTimeout(() => setCopied(false), 1500);
            }}
            className="ml-auto shrink-0 rounded bg-accent px-2 py-1 font-medium text-inverted"
          >
            {copied ? 'Copied' : 'Copy link'}
          </button>
          <a href={shareUrl} target="_blank" rel="noopener noreferrer" className="shrink-0 text-accent-text hover:underline">
            Open
          </a>
        </div>
      )}

      <div className="space-y-4 rounded-md border border-line bg-surface p-4">
        <div>
          <label className="mb-1 block text-xs text-secondary">Form title</label>
          <input
            value={form.title}
            onChange={(e) => patch({ title: e.target.value })}
            className="w-full rounded border border-line bg-canvas px-2 py-1.5 text-sm outline-none focus:border-accent"
          />
        </div>
        <div>
          <label className="mb-1 block text-xs text-secondary">Description</label>
          <textarea
            value={form.description ?? ''}
            onChange={(e) => patch({ description: e.target.value })}
            rows={2}
            className="w-full rounded border border-line bg-canvas px-2 py-1.5 text-sm outline-none focus:border-accent"
          />
        </div>

        <div>
          <p className="mb-2 text-xs font-medium text-secondary">Fields</p>
          <ul className="divide-y divide-line rounded border border-line">
            {form.config.fields.map((entry) => (
              <li key={entry.fieldId} className="flex items-center gap-3 px-3 py-2 text-sm">
                <label className="flex items-center gap-1.5">
                  <input
                    type="checkbox"
                    checked={!entry.hidden}
                    onChange={(e) => patchField(entry.fieldId, { hidden: !e.target.checked })}
                  />
                  <span className={entry.hidden ? 'text-tertiary line-through' : ''}>
                    {nameOf(entry.fieldId)}
                  </span>
                </label>
                <label className="ml-auto flex items-center gap-1.5 text-xs text-secondary">
                  <input
                    type="checkbox"
                    checked={entry.required}
                    disabled={entry.hidden}
                    onChange={(e) => patchField(entry.fieldId, { required: e.target.checked })}
                  />
                  Required
                </label>
              </li>
            ))}
          </ul>
        </div>

        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="mb-1 block text-xs text-secondary">Submit button</label>
            <input
              value={form.config.submitText}
              onChange={(e) => patchConfig({ submitText: e.target.value })}
              className="w-full rounded border border-line bg-canvas px-2 py-1.5 text-sm outline-none focus:border-accent"
            />
          </div>
          <div>
            <label className="mb-1 block text-xs text-secondary">Confirmation message</label>
            <input
              value={form.config.confirmationMessage}
              onChange={(e) => patchConfig({ confirmationMessage: e.target.value })}
              className="w-full rounded border border-line bg-canvas px-2 py-1.5 text-sm outline-none focus:border-accent"
            />
          </div>
        </div>

        <div className="flex items-center gap-2 border-t border-line pt-3">
          <button
            onClick={() => save()}
            disabled={saving}
            className="rounded bg-accent px-3 py-1.5 text-sm font-medium text-inverted disabled:opacity-60"
          >
            {saving ? 'Saving…' : 'Save changes'}
          </button>
          <button onClick={remove} className="ml-auto text-sm text-danger-text hover:underline">
            Delete form
          </button>
        </div>
      </div>
    </div>
  );
}

import { z } from 'zod';

/**
 * Form configuration.
 *
 * A form is a public write surface onto a private table, which makes it the only place in the
 * product where an anonymous stranger can create a record. Two things follow from that and shape
 * everything here:
 *
 *  1. **The form declares exactly which fields it accepts.** A submission is filtered against
 *     that list on the server, so a crafted request cannot set a column the form never showed —
 *     an approval flag, an internal price, an owner id.
 *  2. **Prefill is separate from the field list.** A prefilled value is still subject to the same
 *     filter; a link that prefills a hidden field sets nothing.
 */

const FIELD_ID = z.string().max(30);

/**
 * A rule that shows a field only when an earlier answer matches.
 *
 * Conditions reference *earlier* fields only. Allowing a forward reference lets a form depend on
 * an answer that has not been given, which renders as a field that flickers in and out as the
 * page is filled, and cannot be evaluated server-side at all.
 */
export const formConditionSchema = z
  .object({
    fieldId: FIELD_ID,
    operator: z.enum(['is', 'isNot', 'isEmpty', 'isNotEmpty', 'contains']),
    value: z.unknown().optional(),
  })
  .strict();

export const formFieldSchema = z
  .object({
    fieldId: FIELD_ID,
    /** Overrides the column's own name for people filling the form in. */
    label: z.string().max(255).optional(),
    helpText: z.string().max(1_000).optional(),
    required: z.boolean().optional(),
    /** Shown but not editable — for a value the form itself sets. */
    readOnly: z.boolean().optional(),
    showWhen: z.array(formConditionSchema).max(10).optional(),
  })
  .strict();

export const formPageSchema = z
  .object({
    title: z.string().max(255).optional(),
    description: z.string().max(2_000).optional(),
    fields: z.array(formFieldSchema).min(1).max(200),
  })
  .strict();

export const formConfigSchema = z
  .object({
    pages: z.array(formPageSchema).min(1).max(20),
    submitLabel: z.string().max(64).optional(),
    /** What the person sees after submitting. */
    confirmation: z
      .object({
        kind: z.enum(['message', 'redirect']),
        message: z.string().max(2_000).optional(),
        /** Only http(s): a redirect is a link the form's owner points a stranger's browser at. */
        url: z.string().max(2_048).optional(),
        allowAnother: z.boolean().optional(),
      })
      .strict()
      .optional(),
    branding: z
      .object({
        logoUrl: z.string().max(2_048).optional(),
        accentColour: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional(),
        hideBranding: z.boolean().optional(),
      })
      .strict()
      .optional(),
  })
  .strict()
  .superRefine((config, ctx) => {
    const seen = new Set<string>();
    // Order matters: a condition may only reference a field that appears before it.
    const ordered: string[] = [];

    for (const [pageIndex, page] of config.pages.entries()) {
      for (const [fieldIndex, field] of page.fields.entries()) {
        if (seen.has(field.fieldId)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['pages', pageIndex, 'fields', fieldIndex],
            message: 'this field appears on the form more than once',
          });
        }
        seen.add(field.fieldId);

        for (const condition of field.showWhen ?? []) {
          if (!ordered.includes(condition.fieldId)) {
            ctx.addIssue({
              code: z.ZodIssueCode.custom,
              path: ['pages', pageIndex, 'fields', fieldIndex, 'showWhen'],
              message: 'a rule can only depend on a field that comes earlier in the form',
            });
          }
        }

        ordered.push(field.fieldId);
      }
    }

    const confirmation = config.confirmation;
    if (confirmation?.kind === 'redirect') {
      // A redirect sends somebody's browser wherever the form's owner says. Restricting it to
      // http(s) keeps a form from becoming a javascript: launcher on a public page.
      const url = confirmation.url ?? '';
      let safe = false;
      try {
        safe = ['http:', 'https:'].includes(new URL(url).protocol);
      } catch {
        safe = false;
      }
      if (!safe) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['confirmation', 'url'],
          message: 'a redirect needs an http or https address',
        });
      }
    }
  });

export type FormConfig = z.infer<typeof formConfigSchema>;
export type FormField = z.infer<typeof formFieldSchema>;

/** Every field the form accepts, in order. The allowlist a submission is filtered against. */
export function formFieldIds(config: FormConfig): string[] {
  return config.pages.flatMap((page) => page.fields.map((field) => field.fieldId));
}

/**
 * Filters a submission down to what the form actually offered.
 *
 * This is the security boundary. A submission arrives from an anonymous browser and names
 * whatever fields it likes; everything not on the form is dropped, and read-only fields are
 * dropped too — they are shown to the person, not filled by them.
 *
 * Returns the rejected keys as well, so an operator reading the logs can tell a probing attempt
 * from a stale cached form.
 */
export function filterSubmission(
  config: FormConfig,
  submitted: Readonly<Record<string, unknown>>,
): { accepted: Record<string, unknown>; rejected: string[] } {
  const writable = new Set(
    config.pages.flatMap((page) =>
      page.fields.filter((field) => !field.readOnly).map((field) => field.fieldId),
    ),
  );

  const accepted: Record<string, unknown> = {};
  const rejected: string[] = [];

  for (const [fieldId, value] of Object.entries(submitted)) {
    if (writable.has(fieldId)) accepted[fieldId] = value;
    else rejected.push(fieldId);
  }

  return { accepted, rejected };
}

/**
 * Which required fields are missing from a submission.
 *
 * A field hidden by its own `showWhen` rule is not required — otherwise a form with conditional
 * sections can never be submitted, because it demands answers to questions it did not ask.
 */
export function missingRequired(
  config: FormConfig,
  submitted: Readonly<Record<string, unknown>>,
): string[] {
  const missing: string[] = [];

  for (const page of config.pages) {
    for (const field of page.fields) {
      if (!field.required || field.readOnly) continue;
      if (!isVisible(field, submitted)) continue;

      const value = submitted[field.fieldId];
      const empty =
        value === undefined ||
        value === null ||
        value === '' ||
        (Array.isArray(value) && value.length === 0);

      if (empty) missing.push(field.fieldId);
    }
  }

  return missing;
}

/** Evaluates a field's `showWhen` rules against the answers given so far. */
export function isVisible(field: FormField, answers: Readonly<Record<string, unknown>>): boolean {
  // All rules must hold. An "any of" form is expressible by putting the alternatives in one rule's
  // value; "all of" is the harder thing to build out of the other and so is what the list means.
  return (field.showWhen ?? []).every((condition) => {
    const value = answers[condition.fieldId];

    switch (condition.operator) {
      case 'isEmpty':
        return value === undefined || value === null || value === '';
      case 'isNotEmpty':
        return value !== undefined && value !== null && value !== '';
      case 'is':
        return value === condition.value;
      case 'isNot':
        return value !== condition.value;
      case 'contains':
        return Array.isArray(value)
          ? value.includes(condition.value)
          : String(value ?? '').includes(String(condition.value ?? ''));
    }
  });
}

/**
 * Whether a form is currently accepting submissions.
 *
 * Returns a reason rather than a boolean so the page can say "this form closed on Friday"
 * instead of a bare refusal — and so the reason is decided in one place rather than in the API
 * and again in the UI.
 */
export function submissionState(form: {
  isPublished: boolean;
  opensAt?: Date | null;
  closesAt?: Date | null;
  submissionLimit?: number | null;
  submissionCount: number;
}, now: Date = new Date()): { open: true } | { open: false; reason: 'unpublished' | 'notYetOpen' | 'closed' | 'full' } {
  if (!form.isPublished) return { open: false, reason: 'unpublished' };
  if (form.opensAt && now < form.opensAt) return { open: false, reason: 'notYetOpen' };
  if (form.closesAt && now >= form.closesAt) return { open: false, reason: 'closed' };
  if (form.submissionLimit !== null && form.submissionLimit !== undefined) {
    if (form.submissionCount >= form.submissionLimit) return { open: false, reason: 'full' };
  }
  return { open: true };
}

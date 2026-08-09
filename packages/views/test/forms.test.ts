import { describe, expect, it } from 'vitest';

import {
  filterSubmission,
  formConfigSchema,
  formFieldIds,
  isVisible,
  missingRequired,
  submissionState,
  type FormConfig,
} from '../src/forms';

/**
 * A form is the only place in the product where an anonymous stranger can create a record, which
 * makes `filterSubmission` a security boundary rather than a convenience. These tests are written
 * around what a crafted submission would try.
 */

const F = (n: number) => `fld_0000000000000000000000000${n}`;

const config = (fields: unknown[]): unknown => ({ pages: [{ fields }] });
const parse = (input: unknown) => formConfigSchema.safeParse(input);

const simple: FormConfig = formConfigSchema.parse(
  config([{ fieldId: F(1), required: true }, { fieldId: F(2) }]),
);

describe('form configuration', () => {
  it('accepts a form with one page of fields', () => {
    expect(parse(config([{ fieldId: F(1) }])).success).toBe(true);
  });

  it('refuses a form with no fields', () => {
    expect(parse({ pages: [{ fields: [] }] }).success).toBe(false);
    expect(parse({ pages: [] }).success).toBe(false);
  });

  it('refuses the same field twice', () => {
    // Two inputs writing one column; the last one silently wins.
    expect(parse(config([{ fieldId: F(1) }, { fieldId: F(1) }])).success).toBe(false);
  });

  it('allows a rule that depends on an earlier field', () => {
    const input = config([
      { fieldId: F(1) },
      { fieldId: F(2), showWhen: [{ fieldId: F(1), operator: 'is', value: 'yes' }] },
    ]);
    expect(parse(input).success).toBe(true);
  });

  it('refuses a rule that depends on a later field', () => {
    // A form cannot depend on an answer that has not been given; it would flicker as the page is
    // filled and cannot be evaluated on the server at all.
    const input = config([
      { fieldId: F(1), showWhen: [{ fieldId: F(2), operator: 'is', value: 'yes' }] },
      { fieldId: F(2) },
    ]);
    expect(parse(input).success).toBe(false);
  });

  it('refuses a rule that depends on the field it governs', () => {
    const input = config([
      { fieldId: F(1), showWhen: [{ fieldId: F(1), operator: 'isNotEmpty' }] },
    ]);
    expect(parse(input).success).toBe(false);
  });

  describe('confirmation redirects', () => {
    const withRedirect = (url: string) => ({
      pages: [{ fields: [{ fieldId: F(1) }] }],
      confirmation: { kind: 'redirect', url },
    });

    it('accepts http and https', () => {
      expect(parse(withRedirect('https://example.com/thanks')).success).toBe(true);
    });

    it('refuses anything that could run script', () => {
      // A form's redirect points a stranger's browser wherever the owner says.
      for (const url of ['javascript:alert(1)', 'data:text/html,<script>', 'not a url', '']) {
        expect(parse(withRedirect(url)).success, url).toBe(false);
      }
    });
  });
});

describe('filterSubmission', () => {
  it('accepts the fields the form offered', () => {
    const result = filterSubmission(simple, { [F(1)]: 'a', [F(2)]: 'b' });
    expect(result.accepted).toEqual({ [F(1)]: 'a', [F(2)]: 'b' });
    expect(result.rejected).toEqual([]);
  });

  it('drops a field the form never showed', () => {
    // The attack this exists for: setting an approval flag, an internal price, an owner id.
    const result = filterSubmission(simple, { [F(1)]: 'a', [F(9)]: 'approved' });
    expect(result.accepted).toEqual({ [F(1)]: 'a' });
    expect(result.rejected).toEqual([F(9)]);
  });

  it('drops a read-only field', () => {
    // Shown to the person, not filled by them.
    const withReadOnly = formConfigSchema.parse(
      config([{ fieldId: F(1) }, { fieldId: F(2), readOnly: true }]),
    );
    const result = filterSubmission(withReadOnly, { [F(1)]: 'a', [F(2)]: 'tampered' });
    expect(result.accepted).toEqual({ [F(1)]: 'a' });
    expect(result.rejected).toEqual([F(2)]);
  });

  it('reports what it rejected, so a probe is distinguishable from a stale form', () => {
    const result = filterSubmission(simple, { [F(8)]: 1, [F(9)]: 2 });
    expect(result.rejected.sort()).toEqual([F(8), F(9)].sort());
  });

  it('accepts an empty submission without inventing values', () => {
    expect(filterSubmission(simple, {}).accepted).toEqual({});
  });
});

describe('missingRequired', () => {
  it('names a required field left blank', () => {
    expect(missingRequired(simple, {})).toEqual([F(1)]);
    expect(missingRequired(simple, { [F(1)]: '' })).toEqual([F(1)]);
    expect(missingRequired(simple, { [F(1)]: [] })).toEqual([F(1)]);
  });

  it('is satisfied by a value', () => {
    expect(missingRequired(simple, { [F(1)]: 'x' })).toEqual([]);
  });

  it('does not demand an answer to a question it did not ask', () => {
    // A required field hidden by its own rule must not block submission, or a form with
    // conditional sections can never be sent.
    const conditional = formConfigSchema.parse(
      config([
        { fieldId: F(1) },
        {
          fieldId: F(2),
          required: true,
          showWhen: [{ fieldId: F(1), operator: 'is', value: 'yes' }],
        },
      ]),
    );

    expect(missingRequired(conditional, { [F(1)]: 'no' })).toEqual([]);
    expect(missingRequired(conditional, { [F(1)]: 'yes' })).toEqual([F(2)]);
  });

  it('never demands a read-only field', () => {
    const readOnly = formConfigSchema.parse(
      config([{ fieldId: F(1), required: true, readOnly: true }]),
    );
    expect(missingRequired(readOnly, {})).toEqual([]);
  });
});

describe('isVisible', () => {
  const field = (showWhen: unknown[]) => ({ fieldId: F(2), showWhen }) as never;

  it('shows a field with no rules', () => {
    expect(isVisible({ fieldId: F(1) } as never, {})).toBe(true);
  });

  it('evaluates each operator', () => {
    expect(isVisible(field([{ fieldId: F(1), operator: 'is', value: 'a' }]), { [F(1)]: 'a' })).toBe(true);
    expect(isVisible(field([{ fieldId: F(1), operator: 'is', value: 'a' }]), { [F(1)]: 'b' })).toBe(false);
    expect(isVisible(field([{ fieldId: F(1), operator: 'isNot', value: 'a' }]), { [F(1)]: 'b' })).toBe(true);
    expect(isVisible(field([{ fieldId: F(1), operator: 'isEmpty' }]), {})).toBe(true);
    expect(isVisible(field([{ fieldId: F(1), operator: 'isNotEmpty' }]), { [F(1)]: 'x' })).toBe(true);
  });

  it('requires every rule to hold', () => {
    const both = field([
      { fieldId: F(1), operator: 'isNotEmpty' },
      { fieldId: F(1), operator: 'is', value: 'yes' },
    ]);
    expect(isVisible(both, { [F(1)]: 'yes' })).toBe(true);
    expect(isVisible(both, { [F(1)]: 'no' })).toBe(false);
  });

  it('matches inside a list for contains', () => {
    expect(isVisible(field([{ fieldId: F(1), operator: 'contains', value: 'a' }]), { [F(1)]: ['a', 'b'] })).toBe(true);
  });
});

describe('submissionState', () => {
  const now = new Date('2026-03-15T12:00:00Z');
  const open = { isPublished: true, submissionCount: 0 };

  it('is open when published and unrestricted', () => {
    expect(submissionState(open, now)).toEqual({ open: true });
  });

  it('is closed while unpublished', () => {
    expect(submissionState({ ...open, isPublished: false }, now)).toEqual({
      open: false,
      reason: 'unpublished',
    });
  });

  it('respects an opening time', () => {
    const later = { ...open, opensAt: new Date('2026-04-01T00:00:00Z') };
    expect(submissionState(later, now)).toMatchObject({ reason: 'notYetOpen' });
  });

  it('respects a closing time', () => {
    const past = { ...open, closesAt: new Date('2026-03-01T00:00:00Z') };
    expect(submissionState(past, now)).toMatchObject({ reason: 'closed' });
  });

  it('closes exactly at the closing instant, not after it', () => {
    const atClose = { ...open, closesAt: now };
    expect(submissionState(atClose, now)).toMatchObject({ reason: 'closed' });
  });

  it('respects a submission limit', () => {
    expect(submissionState({ ...open, submissionLimit: 2, submissionCount: 2 }, now)).toMatchObject({
      reason: 'full',
    });
    expect(submissionState({ ...open, submissionLimit: 2, submissionCount: 1 }, now)).toEqual({ open: true });
  });

  it('treats no limit as unlimited rather than zero', () => {
    expect(submissionState({ ...open, submissionLimit: null, submissionCount: 999 }, now)).toEqual({
      open: true,
    });
  });
});

describe('formFieldIds', () => {
  it('lists every field in order across pages', () => {
    const multi = formConfigSchema.parse({
      pages: [{ fields: [{ fieldId: F(1) }] }, { fields: [{ fieldId: F(2) }] }],
    });
    expect(formFieldIds(multi)).toEqual([F(1), F(2)]);
  });
});

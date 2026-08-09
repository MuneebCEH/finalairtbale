import { describe, expect, it } from 'vitest';

import { IMPLEMENTED_FIELD_TYPES, contextFor, getFieldSpec } from '../src/registry';
import type { FieldDefinition } from '../src/registry';

/**
 * The field-type conformance suite.
 *
 * Every registered type is put through the same battery. The point is not to test each type's
 * cleverness — that is what the per-type tests below are for — but to make it impossible to
 * register a type that is missing a behaviour some other layer depends on. A spec that parses
 * but cannot serialise, or declares an operator it cannot compile, breaks the grid, the export,
 * or the filter builder at runtime rather than at build time.
 *
 * Referenced from docs/10-testing-strategy.md §3.3.
 */

function definitionFor(type: string): FieldDefinition {
  const spec = getFieldSpec(type);
  return {
    id: 'fld_01HAAAAAAAAAAAAAAAAAAAAAAA',
    name: `Test ${type}`,
    type,
    options: spec.defaultOptions(),
  };
}

describe.each(IMPLEMENTED_FIELD_TYPES)('conformance: %s', (type) => {
  const spec = getFieldSpec(type);
  const ctx = contextFor(definitionFor(type));

  it('declares a coherent identity', () => {
    expect(spec.type).toBe(type);
    expect(spec.label.length).toBeGreaterThan(0);
    expect(spec.operators.length).toBeGreaterThan(0);
  });

  it('validates its own default options', () => {
    // A type whose defaults its own schema rejects is broken the moment somebody creates a field.
    expect(spec.optionsSchema.safeParse(spec.defaultOptions()).success).toBe(true);
  });

  it('treats null, undefined and empty string as absent', () => {
    for (const input of [null, undefined, '']) {
      const result = spec.parse(input, ctx);
      if (spec.computed) {
        // Computed types refuse every write, including empty ones.
        expect(result.ok).toBe(false);
      } else {
        expect(result.ok, `${type} rejected ${JSON.stringify(input)}`).toBe(true);
        if (result.ok) expect(spec.isEmpty(result.value)).toBe(true);
      }
    }
  });

  it('renders an empty value as an empty string', () => {
    // Checkbox is the exception, and deliberately so: it has no "empty" state. An unticked box
    // is `false`, not unknown, and exporting it as blank would make a re-import ambiguous.
    if (type === 'checkbox') {
      expect(spec.toText(null, ctx)).toBe('false');
      return;
    }
    expect(spec.toText(null, ctx)).toBe('');
  });

  it('produces null for the slot of an empty value', () => {
    const slot = spec.toSlot(null, ctx);
    // Checkbox is the one type where absence is meaningfully `false` rather than unknown.
    if (type === 'checkbox') expect(slot).toBe(false);
    else expect(slot).toBeNull();
  });

  it('produces a slot value whose type matches its declared family', () => {
    const parsed = spec.parse(sampleFor(type), ctx);
    if (!parsed.ok) return; // computed types

    const slot = spec.toSlot(parsed.value, ctx);
    if (slot === null) {
      expect(spec.slotFamily).not.toBe('boolean');
      return;
    }
    switch (spec.slotFamily) {
      case 'string':
        expect(typeof slot).toBe('string');
        break;
      case 'number':
        expect(typeof slot).toBe('number');
        break;
      case 'boolean':
        expect(typeof slot).toBe('boolean');
        break;
      case 'date':
        expect(slot).toBeInstanceOf(Date);
        break;
      case null:
        expect(slot).toBeNull();
        break;
    }
  });

  it('round-trips losslessly through export text', () => {
    const parsed = spec.parse(sampleFor(type), ctx);
    if (!parsed.ok || parsed.value === null) return;

    const render = (value: unknown): string => (spec.toExportText ?? spec.toText).call(spec, value, ctx);
    const text = render(parsed.value);
    const reparsed = spec.fromText(text, ctx);
    if (!reparsed.ok) return; // types that legitimately refuse text import

    // Deep equality is the wrong assertion — a currency exports as "1234.5" and re-parses to the
    // number 1234.5, which is correct. What must hold is that exporting the re-imported value
    // produces the identical string: the value is stable under repeated export/import cycles.
    expect(render(reparsed.value)).toBe(text);
  });

  it('refuses direct writes when it is computed', () => {
    if (!spec.computed) return;
    expect(spec.parse('anything', ctx).ok).toBe(false);
    expect(spec.fromText('anything', ctx).ok).toBe(false);
  });

  it('serialises without throwing for both empty and populated values', () => {
    expect(() => spec.serialize(null, ctx)).not.toThrow();
    const parsed = spec.parse(sampleFor(type), ctx);
    if (parsed.ok) expect(() => spec.serialize(parsed.value, ctx)).not.toThrow();
  });
});

/** A representative valid input per type, used by the generic checks above. */
function sampleFor(type: string): unknown {
  switch (type) {
    case 'singleLineText':
    case 'longText':
      return 'Acme Corporation';
    case 'email':
      return 'Person@Example.com';
    case 'url':
      return 'example.com/path';
    case 'phone':
      return '+44 20 7946 0958';
    case 'barcode':
      return '5901234123457';
    case 'number':
      return '42';
    case 'decimal':
    case 'currency':
      return '1234.5';
    case 'percent':
      return '75';
    case 'rating':
      return 4;
    case 'progress':
      return 60;
    case 'duration':
      return '1:30';
    case 'checkbox':
      return 'yes';
    case 'singleSelect':
    case 'status':
      return 'todo';
    case 'multipleSelect':
      return [];
    case 'date':
      return '2026-03-04';
    case 'dateTime':
      return '2026-03-04T14:00:00Z';
    case 'user':
      return 'usr_01HUUUUUUUUUUUUUUUUUUUUUUU';
    case 'multipleUsers':
      return ['usr_01HUUUUUUUUUUUUUUUUUUUUUUU'];
    case 'attachment':
      return [];
    case 'json':
      return { a: 1 };
    default:
      return 'value';
  }
}

// ── Behaviours worth asserting individually ─────────────────────────────────

describe('coercion is narrow and deliberate', () => {
  const numberField = contextFor({
    id: 'fld_01HAAAAAAAAAAAAAAAAAAAAAAA',
    name: 'Amount',
    type: 'decimal',
    options: { precision: 2 },
  });

  it('accepts a formatted number from a paste', () => {
    const result = getFieldSpec('decimal').parse('$1,234.567', numberField);
    expect(result).toEqual({ ok: true, value: 1234.57 });
  });

  it('refuses text that is not a number rather than yielding NaN or zero', () => {
    // Silent coercion to 0 is how a spreadsheet loses a column of data without anybody noticing.
    expect(getFieldSpec('decimal').parse('banana', numberField).ok).toBe(false);
  });

  it('rounds half away from zero, including for negatives', () => {
    const spec = getFieldSpec('decimal');
    const ctx = contextFor({ id: 'fld_01HAAAAAAAAAAAAAAAAAAAAAAA', name: 'n', type: 'decimal', options: { precision: 0 } });
    expect(spec.parse('-0.5', ctx)).toEqual({ ok: true, value: -1 });
    expect(spec.parse('0.5', ctx)).toEqual({ ok: true, value: 1 });
  });
});

describe('urls', () => {
  const ctx = contextFor({ id: 'fld_01HAAAAAAAAAAAAAAAAAAAAAAA', name: 'Link', type: 'url', options: {} });

  it('assumes https for a bare host', () => {
    expect(getFieldSpec('url').parse('example.com', ctx)).toEqual({
      ok: true,
      value: 'https://example.com',
    });
  });

  it('refuses a javascript: URL', () => {
    // The grid renders this field as an anchor, so accepting it would be a stored XSS vector.
    expect(getFieldSpec('url').parse('javascript:alert(1)', ctx).ok).toBe(false);
    expect(getFieldSpec('url').parse('data:text/html,<script>', ctx).ok).toBe(false);
  });
});

describe('dates keep calendar days and instants apart', () => {
  const dateCtx = contextFor({ id: 'fld_01HAAAAAAAAAAAAAAAAAAAAAAA', name: 'Birthday', type: 'date', options: {} });

  it('anchors a date to midnight UTC so it cannot drift by a day', () => {
    const result = getFieldSpec('date').parse('2026-03-04', dateCtx);
    expect(result).toEqual({ ok: true, value: '2026-03-04T00:00:00.000Z' });
  });

  it('reads an unambiguous day-first date correctly', () => {
    const result = getFieldSpec('date').parse('25/12/2026', dateCtx);
    expect(result.ok && String(result.value).slice(0, 10)).toBe('2026-12-25');
  });
});

describe('selects store ids, not labels', () => {
  const ctx = contextFor({
    id: 'fld_01HAAAAAAAAAAAAAAAAAAAAAAA',
    name: 'Status',
    type: 'singleSelect',
    options: {
      choices: [
        { id: 'opt_a', label: 'In progress', position: 1 },
        { id: 'opt_b', label: 'Done', position: 2 },
      ],
    },
  });

  it('resolves a label to its id, so a paste of human text works', () => {
    expect(getFieldSpec('singleSelect').parse('In progress', ctx)).toEqual({ ok: true, value: 'opt_a' });
  });

  it('accepts the id directly', () => {
    expect(getFieldSpec('singleSelect').parse('opt_b', ctx)).toEqual({ ok: true, value: 'opt_b' });
  });

  it('rejects a value that is not an option', () => {
    const result = getFieldSpec('singleSelect').parse('Cancelled', ctx);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain('In progress');
  });

  it('sorts by the author-defined position, not alphabetically', () => {
    // "Done, In progress" alphabetically is useless; the board order is what people mean.
    const spec = getFieldSpec('singleSelect');
    expect(spec.toSlot('opt_a', ctx)).toBe('00001');
    expect(spec.toSlot('opt_b', ctx)).toBe('00002');
  });
});

describe('multi-select equality ignores order', () => {
  const ctx = contextFor({
    id: 'fld_01HAAAAAAAAAAAAAAAAAAAAAAA',
    name: 'Tags',
    type: 'multipleSelect',
    options: { choices: [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }] },
  });

  it('treats two orderings of the same set as unchanged', () => {
    // Otherwise reordering registers as an edit, creating a revision and a realtime broadcast
    // for a change nobody made.
    const spec = getFieldSpec('multipleSelect');
    expect(spec.equals?.(['a', 'b'], ['b', 'a'])).toBe(true);
    expect(spec.equals?.(['a'], ['a', 'b'])).toBe(false);
  });

  it('deduplicates selections', () => {
    expect(getFieldSpec('multipleSelect').parse(['a', 'a', 'b'], ctx)).toEqual({
      ok: true,
      value: ['a', 'b'],
    });
  });
});

describe('attachments never leak a stored URL', () => {
  it('omits the raw url from the serialised value', () => {
    const ctx = contextFor({ id: 'fld_01HAAAAAAAAAAAAAAAAAAAAAAA', name: 'Files', type: 'attachment', options: {} });
    const serialised = getFieldSpec('attachment').serialize(
      [{ id: 'att_1', filename: 'a.pdf', mimeType: 'application/pdf', size: 10, url: 'https://private/a.pdf' }] as never,
      ctx,
    ) as Array<Record<string, unknown>>;

    // The record service substitutes a freshly signed, short-lived URL on read. Emitting the
    // stored one here would hand out a permanent link to a private file.
    expect(serialised[0]).not.toHaveProperty('url');
    expect(serialised[0]?.['filename']).toBe('a.pdf');
  });
});

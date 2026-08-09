import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

/**
 * Every camelCase Prisma field must carry an `@map` to a snake_case column.
 *
 * This exists because of a bug that shipped: two fields had their `@map` appended *after* a
 * trailing `//` comment, so Prisma parsed it as comment text and silently kept the camelCase
 * column name. Nothing failed at build, at generate, or at `db push` — it surfaced only when
 * hand-written SQL elsewhere in this package referenced `scan_status` and Postgres reported an
 * unknown column. The query builder and the record repository both emit raw SQL against these
 * tables, so a column whose real name differs from the documented one is a live defect, not a
 * cosmetic one.
 *
 * The parser below deliberately strips comments *before* looking for `@map`, which is exactly the
 * step the original mapping script skipped.
 */

const SCHEMA = readFileSync(join(__dirname, '..', '..', 'prisma', 'schema.prisma'), 'utf8');

interface FieldLine {
  readonly model: string;
  readonly field: string;
  readonly line: number;
  readonly attributes: string;
}

/**
 * Only scalars become columns. A field typed as another model is a relation — it exists in the
 * client and not in the table, so it has no column to map and must not be flagged.
 */
const SCALAR_TYPES = new Set([
  'String',
  'Boolean',
  'Int',
  'BigInt',
  'Float',
  'Decimal',
  'DateTime',
  'Json',
  'Bytes',
]);

function parseFields(): FieldLine[] {
  const out: FieldLine[] = [];
  let model: string | null = null;

  SCHEMA.split('\n').forEach((raw, index) => {
    const modelStart = /^model\s+(\w+)\s*\{/.exec(raw);
    if (modelStart) {
      model = modelStart[1] ?? null;
      return;
    }
    if (raw.startsWith('}')) {
      model = null;
      return;
    }
    if (!model) return;

    // Strip the trailing line comment first — this is the whole point of the test.
    // `///` doc comments occupy a line of their own and are dropped by the same rule.
    const code = raw.split('//')[0] ?? '';
    const trimmed = code.trim();
    if (trimmed === '') return;
    // Block-level attributes (`@@index`, `@@map`) are not fields.
    if (trimmed.startsWith('@@')) return;

    const field = /^(\w+)\s+(\w+)/.exec(trimmed);
    if (!field?.[1] || !field[2]) return;
    if (!SCALAR_TYPES.has(field[2])) return;

    out.push({ model, field: field[1], line: index + 1, attributes: trimmed });
  });

  return out;
}

describe('prisma schema column naming', () => {
  const fields = parseFields();

  it('parses a plausible number of fields', () => {
    // A guard on the guard: if the parser breaks, every assertion below passes vacuously.
    expect(fields.length).toBeGreaterThan(300);
  });

  it('maps every camelCase field to a snake_case column', () => {
    const offenders = fields
      .filter((f) => /[A-Z]/.test(f.field))
      .filter((f) => !/@map\(/.test(f.attributes))
      .map((f) => `${f.model}.${f.field} (schema.prisma:${f.line})`);

    expect(offenders).toEqual([]);
  });

  it('never leaves an @map stranded inside a comment', () => {
    const stranded = SCHEMA.split('\n')
      .map((line, index) => ({ line, number: index + 1 }))
      .filter(({ line }) => {
        const comment = line.split('//').slice(1).join('//');
        return comment.includes('@map(');
      })
      .map(({ number }) => `schema.prisma:${number}`);

    expect(stranded).toEqual([]);
  });

  it('maps every model to a snake_case table', () => {
    const models = [...SCHEMA.matchAll(/^model\s+(\w+)\s*\{([\s\S]*?)^\}/gm)];
    const offenders = models
      .filter(([, , body]) => !/@@map\(/.test(body ?? ''))
      .map(([, name]) => name);

    expect(offenders).toEqual([]);
  });
});

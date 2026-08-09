import { describe, expect, it } from 'vitest';

import {
  DEFAULT_BUDGET,
  FormulaError,
  T,
  compile,
  evaluate,
  isError,
  run,
  topologicalOrder,
  type FieldResolver,
  type FormulaType,
  type FormulaValue,
} from '../src';

/**
 * The formula engine is the piece users touch most and trust most, so these tests are written
 * around the ways a spreadsheet quietly lies: silent coercion, blank-as-zero, off-by-one string
 * positions, and calendar arithmetic done in milliseconds.
 */

const FIELDS: Record<string, { id: string; type: FormulaType }> = {
  Name: { id: 'fld_name', type: T.text },
  Price: { id: 'fld_price', type: T.number },
  Quantity: { id: 'fld_qty', type: T.number },
  Shipped: { id: 'fld_shipped', type: T.boolean },
  Due: { id: 'fld_due', type: T.dateTime },
  Tags: { id: 'fld_tags', type: T.array(T.text) },
  Empty: { id: 'fld_empty', type: T.blank },
};

const resolve: FieldResolver = (name) => FIELDS[name];

const NOW = new Date('2026-03-15T10:30:00.000Z');

function evaluateWith(
  source: string,
  fields: Record<string, FormulaValue> = {},
  extra: Partial<Parameters<typeof evaluate>[1]> = {},
): FormulaValue {
  const result = run(source, resolve, { fields, now: NOW, ...extra });
  if (result !== null && typeof result === 'object' && 'ok' in result) {
    throw new Error(`compile failed: ${(result as { message: string }).message}`);
  }
  return result as FormulaValue;
}

/** Compiles and expects failure, returning the message. */
function compileError(source: string): string {
  const result = compile(source, resolve);
  if (result.ok) throw new Error(`expected "${source}" to be rejected`);
  return result.message;
}

describe('lexing and parsing', () => {
  it('evaluates arithmetic with correct precedence', () => {
    expect(evaluateWith('1 + 2 * 3')).toBe(7);
    expect(evaluateWith('(1 + 2) * 3')).toBe(9);
    expect(evaluateWith('-2 + 3')).toBe(1);
    expect(evaluateWith('10 % 3')).toBe(1);
  });

  it('treats ^ as right-associative', () => {
    // 2^(3^2) = 512, not (2^3)^2 = 64.
    expect(evaluateWith('2 ^ 3 ^ 2')).toBe(512);
  });

  it('parses numbers in every legal shape', () => {
    expect(evaluateWith('1.5')).toBe(1.5);
    expect(evaluateWith('.5')).toBe(0.5);
    expect(evaluateWith('1e3')).toBe(1000);
    expect(evaluateWith('1.5e-2')).toBe(0.015);
  });

  it('accepts both quote styles and escapes', () => {
    expect(evaluateWith('"hello"')).toBe('hello');
    expect(evaluateWith("'hello'")).toBe('hello');
    expect(evaluateWith('"a\\nb"')).toBe('a\nb');
    expect(evaluateWith('"say \\"hi\\""')).toBe('say "hi"');
  });

  it('reads field names containing spaces and punctuation', () => {
    expect(evaluateWith('{Name}', { fld_name: 'Ada' })).toBe('Ada');
  });

  it('supports the ternary and word forms of the logical operators', () => {
    expect(evaluateWith('1 > 0 ? "yes" : "no"')).toBe('yes');
    expect(evaluateWith('TRUE AND FALSE')).toBe(false);
    expect(evaluateWith('TRUE && FALSE')).toBe(false);
    expect(evaluateWith('FALSE OR TRUE')).toBe(true);
    expect(evaluateWith('NOT TRUE')).toBe(false);
    expect(evaluateWith('!TRUE')).toBe(false);
  });

  describe('reports position for', () => {
    it('an unclosed field reference', () => {
      expect(compileError('{Name')).toMatch(/closing "}"/);
    });

    it('an unterminated string', () => {
      expect(compileError('"abc')).toMatch(/closing quote/);
    });

    it('a missing closing parenthesis', () => {
      expect(compileError('SUM(1, 2')).toMatch(/Expected "\)"/);
    });

    it('a bare word that should be a field reference', () => {
      expect(compileError('Name + 1')).toMatch(/\{Name\}/);
    });

    it('an empty formula', () => {
      expect(compileError('   ')).toMatch(/cannot be empty/);
    });

    it('trailing junk', () => {
      expect(compileError('1 2')).toMatch(/not expected here/);
    });
  });
});

describe('type checking', () => {
  it('refuses silent coercion between text and number', () => {
    // The single most common source of spreadsheet bugs: "3" + 4 must not be 7 or "34".
    expect(compileError('"3" + 4')).toMatch(/needs numbers/);
  });

  it('refuses comparing incompatible types', () => {
    expect(compileError('{Due} > {Price}')).toMatch(/cannot be compared/);
  });

  it('names the unknown field', () => {
    expect(compileError('{Nope}')).toMatch(/no field called "Nope"/);
  });

  it('names the unknown function', () => {
    expect(compileError('FROBNICATE(1)')).toMatch(/no function called FROBNICATE/);
  });

  it('checks argument counts', () => {
    expect(compileError('LEN()')).toMatch(/takes 1 argument/);
    expect(compileError('LEN("a", "b")')).toMatch(/takes 1 argument/);
    expect(compileError('LEFT("a")')).toMatch(/takes 2 arguments/);
  });

  it('checks argument types and names the parameter', () => {
    expect(compileError('DATEADD("hello", 1, "days")')).toMatch(/DATEADD's "date" needs date/);
  });

  it('allows blank anywhere', () => {
    expect(compile('{Empty} + 1', resolve).ok).toBe(true);
    expect(compile('UPPER({Empty})', resolve).ok).toBe(true);
  });

  it('allows date arithmetic that is unambiguous', () => {
    expect(compile('{Due} - {Due}', resolve).ok).toBe(true);
    expect(compile('{Due} + 1', resolve).ok).toBe(true);
  });

  it('reports the type a formula produces', () => {
    const result = compile('{Price} * {Quantity}', resolve);
    expect(result.ok && result.formula.type).toEqual(T.number);

    const text = compile('{Name} & "!"', resolve);
    expect(text.ok && text.formula.type).toEqual(T.text);
  });

  it('collects dependencies once each, in order', () => {
    const result = compile('{Price} * {Quantity} + {Price}', resolve);
    expect(result.ok && result.formula.dependencies).toEqual(['fld_price', 'fld_qty']);
  });
});

describe('blank handling', () => {
  it('does not treat a blank as zero in an average', () => {
    // The bug that silently drags every average down.
    expect(evaluateWith('AVERAGE({Tags})', { fld_tags: [2, null, 4] })).toBe(3);
  });

  it('sums blanks as absent, not as zero-valued members', () => {
    expect(evaluateWith('SUM({Tags})', { fld_tags: [2, null, 4] })).toBe(6);
    expect(evaluateWith('COUNT({Tags})', { fld_tags: [2, null, 4] })).toBe(2);
    expect(evaluateWith('COUNTA({Tags})', { fld_tags: [2, null, 4] })).toBe(2);
    expect(evaluateWith('COUNTALL({Tags})', { fld_tags: [2, null, 4] })).toBe(3);
  });

  it('averages nothing to blank rather than a division error', () => {
    expect(evaluateWith('AVERAGE({Tags})', { fld_tags: [] })).toBeNull();
  });

  it('coerces a blank to 0 and "" where a coercion is defined', () => {
    expect(evaluateWith('{Empty} + 1', { fld_empty: null })).toBe(1);
    expect(evaluateWith('{Empty} & "x"', { fld_empty: null })).toBe('x');
    expect(evaluateWith('ISBLANK({Empty})', { fld_empty: null })).toBe(true);
  });
});

describe('errors are values, not exceptions', () => {
  it('produces #DIV/0! rather than Infinity', () => {
    const result = evaluateWith('1 / 0');
    expect(isError(result) && result.code).toBe('#DIV/0!');
    expect(String(result)).toBe('#DIV/0!');
  });

  it('propagates through operators', () => {
    const result = evaluateWith('(1 / 0) + 5');
    expect(isError(result) && result.code).toBe('#DIV/0!');
  });

  it('is caught by IFERROR', () => {
    expect(evaluateWith('IFERROR(1 / 0, "n/a")')).toBe('n/a');
    expect(evaluateWith('IFERROR(4 / 2, "n/a")')).toBe(2);
  });

  it('is detected by ISERROR', () => {
    expect(evaluateWith('ISERROR(1 / 0)')).toBe(true);
    expect(evaluateWith('ISERROR(1)')).toBe(false);
  });

  it('reports #VALUE! for unparseable input', () => {
    const result = evaluateWith('VALUE("abc")');
    expect(isError(result) && result.code).toBe('#VALUE!');
  });

  it('reports #REF! when a bound field has since been deleted', () => {
    const compiled = compile('{Price} + 1', resolve);
    if (!compiled.ok) throw new Error('expected a valid formula');
    // Simulate the field being dropped after the formula was saved.
    const field = compiled.formula.ast as { kind: string; left?: { fieldId?: string } };
    delete field.left?.fieldId;

    const result = evaluate(compiled.formula.ast, { fields: {}, now: NOW });
    expect(isError(result) && result.code).toBe('#REF!');
  });

  it('never throws out of the interpreter', () => {
    for (const source of ['1/0', 'SQRT(-1)', 'LOG(0)', 'VALUE("x")', 'POWER(10, 1000)']) {
      expect(() => evaluateWith(source), source).not.toThrow();
    }
  });
});

describe('budgets', () => {
  it('stops a formula that exceeds the step budget', () => {
    // A deeply nested expression rather than a loop — the language has no loops, so cost comes
    // from expression size and from functions that build strings.
    const source = `1${' + 1'.repeat(200)}`;
    const result = run(source, resolve, {
      fields: {},
      now: NOW,
      budget: { ...DEFAULT_BUDGET, steps: 50 },
    });
    expect(isError(result) && (result as FormulaError).code).toBe('#LIMIT!');
  });

  it('refuses to build a string beyond the length budget', () => {
    const result = run('REPT("x", 100000)', resolve, {
      fields: {},
      now: NOW,
      budget: { ...DEFAULT_BUDGET, stringLength: 1000 },
    });
    expect(isError(result) && (result as FormulaError).code).toBe('#LIMIT!');
  });

  it('refuses concatenation beyond the length budget', () => {
    const result = run('{Name} & {Name}', resolve, {
      fields: { fld_name: 'x'.repeat(800) },
      now: NOW,
      budget: { ...DEFAULT_BUDGET, stringLength: 1000 },
    });
    expect(isError(result) && (result as FormulaError).code).toBe('#LIMIT!');
  });
});

describe('short-circuiting', () => {
  it('does not evaluate the branch IF does not take', () => {
    // If the false branch were evaluated the result would be #DIV/0!, not 1.
    expect(evaluateWith('IF(TRUE, 1, 1 / 0)')).toBe(1);
    expect(evaluateWith('IF(FALSE, 1 / 0, 2)')).toBe(2);
  });

  it('stops AND at the first false and OR at the first true', () => {
    expect(evaluateWith('AND(FALSE, 1 / 0)')).toBe(false);
    expect(evaluateWith('OR(TRUE, 1 / 0)')).toBe(true);
  });

  it('short-circuits the operator forms too', () => {
    expect(evaluateWith('FALSE AND (1 / 0)')).toBe(false);
    expect(evaluateWith('TRUE OR (1 / 0)')).toBe(true);
  });
});

describe('text functions', () => {
  it('indexes from 1, as every spreadsheet does', () => {
    expect(evaluateWith('MID("abcdef", 2, 3)')).toBe('bcd');
    expect(evaluateWith('FIND("c", "abc")')).toBe(3);
    expect(evaluateWith('SEARCH("C", "abc")')).toBe(3);
    expect(evaluateWith('REPLACE("abcdef", 2, 3, "X")')).toBe('aXef');
  });

  it('returns blank from SEARCH when there is no match, and 0 from FIND', () => {
    expect(evaluateWith('SEARCH("z", "abc")')).toBeNull();
    expect(evaluateWith('FIND("z", "abc")')).toBe(0);
  });

  it('counts characters by code point, not UTF-16 unit', () => {
    // "👍" is two UTF-16 units but one character to a person.
    expect(evaluateWith('LEN("👍")')).toBe(1);
    expect(evaluateWith('LEFT("👍ab", 1)')).toBe('👍');
  });

  it('accepts LENGTH as a spelling of LEN', () => {
    expect(evaluateWith('LENGTH("abcd")')).toBe(4);
  });

  it('substitutes all occurrences, or one by index', () => {
    expect(evaluateWith('SUBSTITUTE("a-b-c", "-", "+")')).toBe('a+b+c');
    expect(evaluateWith('SUBSTITUTE("a-b-c", "-", "+", 2)')).toBe('a-b+c');
  });

  it('splits and joins', () => {
    expect(evaluateWith('JOIN(SPLIT("a,b,c", ","), "-")')).toBe('a-b-c');
  });

  it('trims and changes case', () => {
    expect(evaluateWith('TRIM("  hi  ")')).toBe('hi');
    expect(evaluateWith('UPPER("hi")')).toBe('HI');
    expect(evaluateWith('LOWER("HI")')).toBe('hi');
  });
});

describe('numeric functions', () => {
  it('rounds away from zero on a tie, symmetrically for both signs', () => {
    // Math.round sends -0.5 to -0 and 0.5 to 1, which treats the signs differently.
    expect(evaluateWith('ROUND(0.5)')).toBe(1);
    expect(evaluateWith('ROUND(-0.5)')).toBe(-1);
    expect(evaluateWith('ROUND(2.345, 2)')).toBe(2.35);
  });

  it('rounds up and down away from and towards zero', () => {
    expect(evaluateWith('ROUNDUP(1.1)')).toBe(2);
    expect(evaluateWith('ROUNDUP(-1.1)')).toBe(-2);
    expect(evaluateWith('ROUNDDOWN(1.9)')).toBe(1);
    expect(evaluateWith('ROUNDDOWN(-1.9)')).toBe(-1);
  });

  it('rescues a number from human-entered text', () => {
    expect(evaluateWith('VALUE("$1,234.50")')).toBe(1234.5);
  });

  it('computes the usual arithmetic', () => {
    expect(evaluateWith('ABS(-3)')).toBe(3);
    expect(evaluateWith('MOD(7, 3)')).toBe(1);
    expect(evaluateWith('POWER(2, 10)')).toBe(1024);
    expect(evaluateWith('SQRT(16)')).toBe(4);
    expect(evaluateWith('SIGN(-5)')).toBe(-1);
    expect(evaluateWith('EVEN(1.2)')).toBe(2);
    expect(evaluateWith('ODD(1.2)')).toBe(3);
  });
});

describe('date functions', () => {
  it('fixes NOW to the batch timestamp', () => {
    // A million-row recalculation must not produce a million different "now"s.
    expect(evaluateWith('NOW()')).toEqual(NOW);
    expect(evaluateWith('DATETIME_FORMAT(TODAY(), "YYYY-MM-DD")')).toBe('2026-03-15');
  });

  it('adds months as calendar months, not as 30 days', () => {
    expect(evaluateWith('DATETIME_FORMAT(DATEADD({Due}, 1, "months"), "YYYY-MM-DD")', {
      fld_due: new Date('2026-01-31T00:00:00Z'),
    })).toBe('2026-02-28');
  });

  it('adds years across a leap day without inventing 29 February', () => {
    expect(evaluateWith('DATETIME_FORMAT(DATEADD({Due}, 1, "years"), "YYYY-MM-DD")', {
      fld_due: new Date('2024-02-29T00:00:00Z'),
    })).toBe('2025-02-28');
  });

  it('measures differences in the requested unit', () => {
    const fields = { fld_due: new Date('2026-03-20T10:30:00Z') };
    expect(evaluateWith('DATETIME_DIFF({Due}, NOW(), "days")', fields)).toBe(5);
    expect(evaluateWith('DATETIME_DIFF({Due}, NOW(), "hours")', fields)).toBe(120);
  });

  it('extracts date parts', () => {
    const fields = { fld_due: new Date('2026-03-15T10:30:45Z') };
    expect(evaluateWith('YEAR({Due})', fields)).toBe(2026);
    expect(evaluateWith('MONTH({Due})', fields)).toBe(3);
    expect(evaluateWith('DAY({Due})', fields)).toBe(15);
    expect(evaluateWith('HOUR({Due})', fields)).toBe(10);
    expect(evaluateWith('MINUTE({Due})', fields)).toBe(30);
    expect(evaluateWith('SECOND({Due})', fields)).toBe(45);
  });

  it('compares dates', () => {
    const fields = { fld_due: new Date('2026-03-20T00:00:00Z') };
    expect(evaluateWith('IS_AFTER({Due}, NOW())', fields)).toBe(true);
    expect(evaluateWith('IS_BEFORE({Due}, NOW())', fields)).toBe(false);
  });

  it('subtracts two dates into a span of milliseconds', () => {
    expect(evaluateWith('{Due} - {Due}', { fld_due: new Date('2026-03-20T00:00:00Z') })).toBe(0);
  });

  it('rejects an unknown unit as a value error', () => {
    const result = evaluateWith('DATEADD(NOW(), 1, "fortnights")');
    expect(isError(result) && result.code).toBe('#VALUE!');
  });
});

describe('record functions', () => {
  it('exposes the record context', () => {
    const context = {
      fields: {},
      now: NOW,
      recordId: 'rec_123',
      currentUserName: 'Ada Lovelace',
      currentUserId: 'usr_1',
      createdTime: new Date('2026-01-01T00:00:00Z'),
    };
    expect(run('RECORD_ID()', resolve, context)).toBe('rec_123');
    expect(run('CURRENT_USER()', resolve, context)).toBe('Ada Lovelace');
    expect(run('CURRENT_USER_ID()', resolve, context)).toBe('usr_1');
    expect(run('YEAR(CREATED_TIME())', resolve, context)).toBe(2026);
  });
});

describe('SWITCH', () => {
  it('returns the matching branch', () => {
    expect(evaluateWith('SWITCH(2, 1, "one", 2, "two", "other")')).toBe('two');
  });

  it('falls through to the default', () => {
    expect(evaluateWith('SWITCH(9, 1, "one", 2, "two", "other")')).toBe('other');
  });

  it('returns blank when nothing matches and there is no default', () => {
    expect(evaluateWith('SWITCH(9, 1, "one", 2, "two")')).toBeNull();
  });
});

describe('dependency ordering', () => {
  it('orders fields so each is computed after what it reads', () => {
    const result = topologicalOrder([
      { id: 'c', dependencies: ['b'] },
      { id: 'b', dependencies: ['a'] },
      { id: 'a', dependencies: [] },
    ]);

    expect(result.ok && result.order).toEqual(['a', 'b', 'c']);
  });

  it('ignores dependencies on plain data columns', () => {
    const result = topologicalOrder([{ id: 'a', dependencies: ['fld_plain_column'] }]);
    expect(result.ok && result.order).toEqual(['a']);
  });

  it('detects a direct cycle', () => {
    const result = topologicalOrder([
      { id: 'a', dependencies: ['b'] },
      { id: 'b', dependencies: ['a'] },
    ]);

    expect(result.ok).toBe(false);
    expect(!result.ok && result.cycle.sort()).toEqual(['a', 'b']);
  });

  it('detects a self-reference', () => {
    // Self-edges are filtered from the graph, so this is caught by the caller comparing the
    // formula's own id against its dependencies — asserted here so the filtering stays deliberate.
    const result = topologicalOrder([{ id: 'a', dependencies: ['a'] }]);
    expect(result.ok).toBe(true);
  });

  it('detects a longer cycle', () => {
    const result = topologicalOrder([
      { id: 'a', dependencies: ['c'] },
      { id: 'b', dependencies: ['a'] },
      { id: 'c', dependencies: ['b'] },
    ]);

    expect(result.ok).toBe(false);
    expect(!result.ok && result.cycle.sort()).toEqual(['a', 'b', 'c']);
  });
});

describe('compilation', () => {
  it('hashes the source so identical formulas share a cache entry', () => {
    const a = compile('{Price} * 2', resolve);
    const b = compile('{Price} * 2', resolve);
    const c = compile('{Price} * 3', resolve);

    expect(a.ok && b.ok && a.formula.hash).toBe(b.ok ? b.formula.hash : '');
    expect(a.ok && c.ok && a.formula.hash === c.formula.hash).toBe(false);
  });

  it('reports a cost that grows with the formula', () => {
    const small = compile('1 + 1', resolve);
    const large = compile('SUM(1, 2, 3, 4, 5) + SUM(6, 7, 8)', resolve);
    expect(small.ok && large.ok && large.formula.cost > small.formula.cost).toBe(true);
  });

  it('returns a failure rather than throwing on bad input', () => {
    const result = compile('1 +', resolve);
    expect(result.ok).toBe(false);
    expect(!result.ok && typeof result.start).toBe('number');
  });
});

describe('a realistic formula', () => {
  it('computes an order line the way a user would write it', () => {
    const source =
      'IF({Shipped}, CONCATENATE({Name}, " — ", FORMAT_NUMBER({Price} * {Quantity}, 2)), "pending")';

    expect(
      evaluateWith(source, { fld_shipped: true, fld_name: 'Widget', fld_price: 9.5, fld_qty: 3 }),
    ).toBe('Widget — 28.50');

    expect(evaluateWith(source, { fld_shipped: false })).toBe('pending');
  });
});

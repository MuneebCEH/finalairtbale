import { describe, expect, it } from 'vitest';

import { LinearRegex, RegexSyntaxError, compileRegex } from '../src/regex';

/**
 * The point of this engine is that it has no worst case. The last block is the one that matters:
 * patterns that make a backtracking engine hang must finish here in milliseconds.
 */

const match = (pattern: string, input: string) => new LinearRegex(pattern).test(input);

describe('literals and wildcards', () => {
  it('matches a literal anywhere in the input', () => {
    expect(match('abc', 'xxabcxx')).toBe(true);
    expect(match('abc', 'xxabxx')).toBe(false);
  });

  it('matches any character with a dot', () => {
    expect(match('a.c', 'abc')).toBe(true);
    expect(match('a.c', 'ac')).toBe(false);
  });

  it('escapes metacharacters', () => {
    expect(match('a\\.c', 'a.c')).toBe(true);
    expect(match('a\\.c', 'abc')).toBe(false);
  });
});

describe('quantifiers', () => {
  it('handles star, plus and question mark', () => {
    expect(match('ab*c', 'ac')).toBe(true);
    expect(match('ab*c', 'abbbc')).toBe(true);
    expect(match('ab+c', 'ac')).toBe(false);
    expect(match('ab+c', 'abc')).toBe(true);
    expect(match('ab?c', 'ac')).toBe(true);
    expect(match('ab?c', 'abc')).toBe(true);
    expect(match('ab?c', 'abbc')).toBe(false);
  });

  it('applies a quantifier to a group', () => {
    expect(match('(ab)+c', 'ababc')).toBe(true);
    expect(match('(ab)+c', 'abac')).toBe(false);
  });
});

describe('alternation and groups', () => {
  it('matches either branch', () => {
    expect(match('cat|dog', 'a dog here')).toBe(true);
    expect(match('cat|dog', 'a bird here')).toBe(false);
  });

  it('respects grouping', () => {
    expect(match('^(cat|dog)s$', 'dogs')).toBe(true);
    expect(match('^(cat|dog)s$', 'birds')).toBe(false);
  });
});

describe('character classes', () => {
  it('matches a set and a range', () => {
    expect(match('[abc]', 'b')).toBe(true);
    expect(match('[a-z]+', 'hello')).toBe(true);
    expect(match('^[a-z]+$', 'Hello')).toBe(false);
  });

  it('negates a class', () => {
    expect(match('^[^0-9]+$', 'abc')).toBe(true);
    expect(match('^[^0-9]+$', 'ab3')).toBe(false);
  });

  it('supports the shorthands', () => {
    expect(match('^\\d+$', '12345')).toBe(true);
    expect(match('^\\d+$', '12a45')).toBe(false);
    expect(match('^\\w+$', 'a_1')).toBe(true);
    expect(match('\\s', 'a b')).toBe(true);
    expect(match('^\\S+$', 'a b')).toBe(false);
  });

  it('treats a trailing hyphen as a literal', () => {
    expect(match('^[a-]+$', 'a-a')).toBe(true);
  });
});

describe('anchors', () => {
  it('anchors to the start and end', () => {
    expect(match('^abc', 'abcdef')).toBe(true);
    expect(match('^abc', 'xabcdef')).toBe(false);
    expect(match('abc$', 'xxabc')).toBe(true);
    expect(match('abc$', 'abcxx')).toBe(false);
    expect(match('^abc$', 'abc')).toBe(true);
    expect(match('^abc$', 'abcd')).toBe(false);
  });
});

describe('extract and replace', () => {
  it('extracts the first match', () => {
    expect(new LinearRegex('\\d+').extract('order 1234 shipped')).toBe('1234');
    expect(new LinearRegex('\\d+').extract('no digits')).toBeNull();
  });

  it('replaces every match', () => {
    expect(new LinearRegex('\\d+').replace('a1b22c333', '#')).toBe('a#b#c#');
  });

  it('leaves input without a match alone', () => {
    expect(new LinearRegex('\\d+').replace('abc', '#')).toBe('abc');
  });

  it('terminates on a pattern that can match nothing', () => {
    // `a*` matches the empty string at every position; without advancing past a zero-width match
    // this loops forever.
    expect(() => new LinearRegex('a*').replace('bbb', '-')).not.toThrow();
  });
});

describe('case insensitivity', () => {
  it('matches either case when asked', () => {
    expect(new LinearRegex('hello', true).test('HELLO')).toBe(true);
    expect(new LinearRegex('hello', false).test('HELLO')).toBe(false);
  });
});

describe('syntax errors are reported, not thrown as something else', () => {
  const invalid = ['(abc', 'abc)', '[abc', 'a\\', '[z-a]'];

  for (const pattern of invalid) {
    it(JSON.stringify(pattern), () => {
      expect(() => new LinearRegex(pattern)).toThrow(RegexSyntaxError);
    });
  }

  it('refuses an over-long pattern', () => {
    expect(() => new LinearRegex('a'.repeat(600))).toThrow(/at most/);
  });
});

describe('no catastrophic backtracking', () => {
  /**
   * These are the patterns that hang a backtracking engine. Each finishes here in milliseconds
   * because the simulation carries the whole state set forward and never revisits a state.
   */
  // The expected answers are what a *correct* engine gives, which is not always "no match":
  // `(a|a)*` matches the empty string, so anchored at the end it matches at the final position.
  // The property under test here is the time taken, not the verdict.
  const evil: Array<[string, string, boolean]> = [
    ['(a+)+$', `${'a'.repeat(40)}b`, false],
    ['(a|a)*$', `${'a'.repeat(40)}b`, true],
    ['(a*)*b', 'a'.repeat(40), false],
    ['(x+x+)+y', 'x'.repeat(40), false],
  ];

  for (const [pattern, input, expected] of evil) {
    it(`${pattern} finishes quickly`, () => {
      const started = Date.now();
      const regex = new LinearRegex(pattern);
      expect(regex.test(input)).toBe(expected);
      // A backtracking engine takes exponential time on these; this must be effectively instant.
      expect(Date.now() - started).toBeLessThan(1_000);
    });
  }

  it('stays fast on a long input', () => {
    const started = Date.now();
    expect(new LinearRegex('^[a-z]+$').test('a'.repeat(50_000))).toBe(true);
    expect(Date.now() - started).toBeLessThan(2_000);
  });
});

describe('compileRegex', () => {
  it('returns the same compiled machine for the same pattern', () => {
    expect(compileRegex('\\d+')).toBe(compileRegex('\\d+'));
  });

  it('keeps case-sensitive and insensitive versions apart', () => {
    expect(compileRegex('abc', true)).not.toBe(compileRegex('abc', false));
  });
});

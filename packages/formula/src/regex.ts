/**
 * A linear-time regular expression engine.
 *
 * ## Why not `RegExp`
 *
 * JavaScript's engine backtracks. `(a+)+b` against a string of forty `a`s takes longer than the
 * universe has existed, and a formula is user input evaluated once per record — so a single
 * pattern in one field can stop a recalculation of a whole table, and no timeout saves the rows
 * already queued behind it. docs/07 §5 requires the closure to be *by construction*.
 *
 * This compiles to a Thompson NFA and simulates it over the input while tracking the whole set of
 * reachable states at once. That set can never exceed the number of states in the pattern, so the
 * work is O(pattern × input) with no backtracking to explode. It is slower than `RegExp` on
 * patterns `RegExp` handles well, and it has no worst case, which is the trade being made.
 *
 * ## The supported subset
 *
 * Literals, `.`, character classes (`[a-z]`, `[^a-z]`, with `\d \w \s` and their negations),
 * `* + ?`, alternation, groups, and the anchors `^` and `$`. Backreferences and lookaround are
 * deliberately absent: neither can be simulated in linear time, and supporting them would give
 * back the property this exists to guarantee.
 */

interface State {
  /** Character test; absent for epsilon transitions and the accepting state. */
  readonly matches?: (code: number) => boolean;
  /** Indices into the state table. */
  out: number[];
}

export class RegexSyntaxError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RegexSyntaxError';
  }
}

/** Bounds the pattern so a pathological one cannot build a huge automaton. */
const MAX_PATTERN_LENGTH = 512;
const MAX_STATES = 4_096;

export class LinearRegex {
  private readonly states: State[] = [];
  private readonly start: number;
  private readonly accept: number;
  private readonly anchoredStart: boolean;
  private readonly anchoredEnd: boolean;

  constructor(pattern: string, private readonly ignoreCase = false) {
    if (pattern.length > MAX_PATTERN_LENGTH) {
      throw new RegexSyntaxError(`A pattern may be at most ${MAX_PATTERN_LENGTH} characters.`);
    }

    let source = pattern;
    this.anchoredStart = source.startsWith('^');
    if (this.anchoredStart) source = source.slice(1);
    this.anchoredEnd = source.endsWith('$') && !source.endsWith('\\$');
    if (this.anchoredEnd) source = source.slice(0, -1);

    const parser = new Parser(source, this.ignoreCase, this);
    const fragment = parser.parseAlternation();
    if (!parser.atEnd) throw new RegexSyntaxError(`Unexpected "${parser.peek()}" in pattern.`);

    this.accept = this.addState({ out: [] });
    for (const dangling of fragment.out) this.states[dangling]!.out.push(this.accept);
    this.start = fragment.start;
  }

  /** Internal: used by the parser to build the automaton. */
  addState(state: State): number {
    if (this.states.length >= MAX_STATES) {
      throw new RegexSyntaxError('That pattern is too complex.');
    }
    this.states.push(state);
    return this.states.length - 1;
  }

  /**
   * Whether the pattern matches anywhere in `input`.
   *
   * Unanchored patterns are handled by restarting the state set at each position rather than by
   * prefixing `.*`, which keeps the state count equal to the pattern's own.
   */
  test(input: string): boolean {
    return this.search(input) !== null;
  }

  /** The first matching substring, or null. */
  extract(input: string): string | null {
    const found = this.search(input);
    return found === null ? null : input.slice(found.start, found.end);
  }

  /** Replaces every non-overlapping match. */
  replace(input: string, replacement: string): string {
    let out = '';
    let index = 0;

    while (index <= input.length) {
      const found = this.search(input, index);
      if (found === null) break;

      out += input.slice(index, found.start) + replacement;
      // A zero-width match must still advance, or this loops forever on `a*`.
      index = found.end > found.start ? found.end : found.start + 1;
      if (found.end === found.start && found.start < input.length) out += input[found.start];
    }

    return out + input.slice(Math.min(index, input.length));
  }

  private search(input: string, from = 0): { start: number; end: number } | null {
    const codes = [...input].map((char) =>
      this.ignoreCase ? char.toLowerCase().codePointAt(0)! : char.codePointAt(0)!,
    );

    const firstStart = this.anchoredStart ? from : from;
    const lastStart = this.anchoredStart ? from : codes.length;

    for (let start = firstStart; start <= lastStart; start += 1) {
      const end = this.runFrom(codes, start);
      if (end !== null) {
        if (this.anchoredEnd && end !== codes.length) continue;
        return { start, end };
      }
      if (this.anchoredStart) break;
    }

    return null;
  }

  /**
   * Runs the automaton from one starting position, returning the longest match end.
   *
   * The whole set of reachable states advances together, one input character at a time. That is
   * what removes backtracking: a state already in the set is never explored twice.
   */
  private runFrom(codes: readonly number[], start: number): number | null {
    let current = new Set<number>();
    this.addWithEpsilon(this.start, current);

    let longest = current.has(this.accept) ? start : null;

    for (let index = start; index < codes.length; index += 1) {
      const next = new Set<number>();
      const code = codes[index]!;

      for (const stateIndex of current) {
        const state = this.states[stateIndex]!;
        if (state.matches?.(code)) {
          for (const target of state.out) this.addWithEpsilon(target, next);
        }
      }

      if (next.size === 0) break;
      current = next;
      if (current.has(this.accept)) longest = index + 1;
    }

    return longest;
  }

  /** Adds a state and everything reachable from it without consuming input. */
  private addWithEpsilon(index: number, into: Set<number>): void {
    if (into.has(index)) return;
    into.add(index);

    const state = this.states[index]!;
    // Epsilon transitions are those on a state with no character test.
    if (!state.matches) {
      for (const target of state.out) this.addWithEpsilon(target, into);
    }
  }
}

interface Fragment {
  readonly start: number;
  /** State indices whose `out` still needs wiring to whatever follows. */
  readonly out: number[];
}

class Parser {
  private index = 0;

  constructor(
    private readonly source: string,
    private readonly ignoreCase: boolean,
    private readonly machine: LinearRegex,
  ) {}

  get atEnd(): boolean {
    return this.index >= this.source.length;
  }

  peek(): string {
    return this.source[this.index] ?? '';
  }

  parseAlternation(): Fragment {
    let left = this.parseConcatenation();

    while (this.peek() === '|') {
      this.index += 1;
      const right = this.parseConcatenation();
      // A branch state with no character test: an epsilon fork into both sides.
      const fork = this.machine.addState({ out: [left.start, right.start] });
      left = { start: fork, out: [...left.out, ...right.out] };
    }

    return left;
  }

  private parseConcatenation(): Fragment {
    let fragment: Fragment | null = null;

    while (!this.atEnd && this.peek() !== '|' && this.peek() !== ')') {
      const piece = this.parseRepetition();
      fragment = fragment ? this.concat(fragment, piece) : piece;
    }

    // An empty branch (`a|`) matches the empty string, which needs a state to hang the fragment on.
    if (!fragment) {
      const empty = this.machine.addState({ out: [] });
      return { start: empty, out: [empty] };
    }

    return fragment;
  }

  private concat(first: Fragment, second: Fragment): Fragment {
    for (const dangling of first.out) {
      (this.machine as unknown as { states: State[] }).states[dangling]!.out.push(second.start);
    }
    return { start: first.start, out: second.out };
  }

  private parseRepetition(): Fragment {
    const atom = this.parseAtom();
    const operator = this.peek();

    if (operator === '*') {
      this.index += 1;
      const split = this.machine.addState({ out: [atom.start] });
      for (const dangling of atom.out) {
        (this.machine as unknown as { states: State[] }).states[dangling]!.out.push(split);
      }
      return { start: split, out: [split] };
    }

    if (operator === '+') {
      this.index += 1;
      const split = this.machine.addState({ out: [atom.start] });
      for (const dangling of atom.out) {
        (this.machine as unknown as { states: State[] }).states[dangling]!.out.push(split);
      }
      return { start: atom.start, out: [split] };
    }

    if (operator === '?') {
      this.index += 1;
      const split = this.machine.addState({ out: [atom.start] });
      return { start: split, out: [...atom.out, split] };
    }

    return atom;
  }

  private parseAtom(): Fragment {
    const char = this.peek();

    if (char === '(') {
      this.index += 1;
      const inner = this.parseAlternation();
      if (this.peek() !== ')') throw new RegexSyntaxError('A group is missing its ")".');
      this.index += 1;
      return inner;
    }

    if (char === '[') return this.parseClass();

    if (char === '.') {
      this.index += 1;
      return this.charState(() => true);
    }

    if (char === '\\') {
      this.index += 1;
      const escaped = this.peek();
      if (escaped === '') throw new RegexSyntaxError('The pattern ends with a "\\".');
      this.index += 1;
      const test = shorthand(escaped);
      if (test) return this.charState(test);
      return this.literal(escaped);
    }

    if (char === '' || char === ')' || char === '|') {
      throw new RegexSyntaxError('Expected something to match here.');
    }

    this.index += 1;
    return this.literal(char);
  }

  private parseClass(): Fragment {
    this.index += 1; // consume '['
    const negated = this.peek() === '^';
    if (negated) this.index += 1;

    const tests: Array<(code: number) => boolean> = [];

    while (!this.atEnd && this.peek() !== ']') {
      let char = this.peek();
      this.index += 1;

      if (char === '\\') {
        const escaped = this.peek();
        this.index += 1;
        const test = shorthand(escaped);
        if (test) {
          tests.push(test);
          continue;
        }
        char = escaped;
      }

      // A range, unless the '-' is the last character before ']'.
      if (this.peek() === '-' && this.source[this.index + 1] !== ']' && this.index + 1 < this.source.length) {
        this.index += 1;
        const upper = this.peek();
        this.index += 1;
        const from = this.code(char);
        const to = this.code(upper);
        if (to < from) throw new RegexSyntaxError(`"${char}-${upper}" is not a valid range.`);
        tests.push((code) => code >= from && code <= to);
        continue;
      }

      const target = this.code(char);
      tests.push((code) => code === target);
    }

    if (this.peek() !== ']') throw new RegexSyntaxError('A character class is missing its "]".');
    this.index += 1;

    const inside = (code: number): boolean => tests.some((test) => test(code));
    return this.charState(negated ? (code) => !inside(code) : inside);
  }

  private literal(char: string): Fragment {
    const target = this.code(char);
    return this.charState((code) => code === target);
  }

  private code(char: string): number {
    return (this.ignoreCase ? char.toLowerCase() : char).codePointAt(0) ?? 0;
  }

  private charState(matches: (code: number) => boolean): Fragment {
    const index = this.machine.addState({ matches, out: [] });
    return { start: index, out: [index] };
  }
}

/** `\d \w \s` and their negations. */
function shorthand(char: string): ((code: number) => boolean) | null {
  const digit = (code: number) => code >= 48 && code <= 57;
  const word = (code: number) =>
    digit(code) || (code >= 65 && code <= 90) || (code >= 97 && code <= 122) || code === 95;
  const space = (code: number) => code === 32 || (code >= 9 && code <= 13);

  switch (char) {
    case 'd':
      return digit;
    case 'D':
      return (code) => !digit(code);
    case 'w':
      return word;
    case 'W':
      return (code) => !word(code);
    case 's':
      return space;
    case 'S':
      return (code) => !space(code);
    default:
      return null;
  }
}

/** Compiled patterns are cached: a formula is evaluated once per record, and compiled once. */
const cache = new Map<string, LinearRegex>();
const CACHE_LIMIT = 500;

export function compileRegex(pattern: string, ignoreCase = false): LinearRegex {
  const key = `${ignoreCase ? 'i' : ''}:${pattern}`;
  const existing = cache.get(key);
  if (existing) return existing;

  const compiled = new LinearRegex(pattern, ignoreCase);
  if (cache.size >= CACHE_LIMIT) cache.delete(cache.keys().next().value as string);
  cache.set(key, compiled);
  return compiled;
}

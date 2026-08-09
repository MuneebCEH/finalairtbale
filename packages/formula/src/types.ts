/**
 * The formula language's value and type universe.
 *
 * Two rules shape everything here, both from docs/07-formula-engine.md §1:
 *
 *  - **Evaluation is total.** Nothing in the interpreter throws. Division by zero, a bad cast, a
 *    missing reference — all produce a typed error *value* that propagates like NaN and can be
 *    caught with `IFERROR`. A formula in one cell must never be able to fail a request.
 *  - **Blank is not zero.** It unifies with anything and coerces where a coercion is defined, but
 *    it stays distinguishable, because "no value" and "the number zero" are different facts about
 *    a record and a spreadsheet that conflates them lies quietly.
 */

export type FormulaType =
  | { readonly k: 'text' }
  | { readonly k: 'number' }
  | { readonly k: 'boolean' }
  | { readonly k: 'date'; readonly hasTime: boolean }
  | { readonly k: 'duration' }
  | { readonly k: 'array'; readonly of: FormulaType }
  | { readonly k: 'record' }
  | { readonly k: 'blank' }
  | { readonly k: 'error' }
  | { readonly k: 'any' };

export const T = {
  text: { k: 'text' } as const,
  number: { k: 'number' } as const,
  boolean: { k: 'boolean' } as const,
  date: { k: 'date', hasTime: false } as const,
  dateTime: { k: 'date', hasTime: true } as const,
  duration: { k: 'duration' } as const,
  record: { k: 'record' } as const,
  blank: { k: 'blank' } as const,
  error: { k: 'error' } as const,
  any: { k: 'any' } as const,
  array: (of: FormulaType): FormulaType => ({ k: 'array', of }),
} satisfies Record<string, FormulaType | ((of: FormulaType) => FormulaType)>;

/** The error values a formula can produce. Exactly the set in docs/07 §6. */
export const ERROR_CODES = [
  '#TYPE!',
  '#DIV/0!',
  '#VALUE!',
  '#REF!',
  '#CYCLE!',
  '#LIMIT!',
  '#N/A',
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];

/**
 * An error as a *value*, not an exception.
 *
 * `detail` explains the specific failure for the editor; the code is what propagates and what
 * `ISERROR` sees. Deliberately a class so `instanceof` is the check, rather than a duck-typed
 * shape that a user's text value could accidentally imitate.
 */
export class FormulaError {
  constructor(
    readonly code: ErrorCode,
    readonly detail?: string,
  ) {}

  toString(): string {
    return this.code;
  }
}

export const isError = (value: unknown): value is FormulaError => value instanceof FormulaError;

/** Every value the interpreter can hold. `null` is blank. */
export type FormulaValue =
  | string
  | number
  | boolean
  | Date
  | null
  | FormulaError
  | readonly FormulaValue[];

/** A parse or type error, with a source span so the editor can put a caret under it. */
export class FormulaCompileError extends Error {
  constructor(
    message: string,
    readonly start: number,
    readonly end: number,
  ) {
    super(message);
    this.name = 'FormulaCompileError';
  }
}

/**
 * Evaluation budgets.
 *
 * A formula runs once per record, so a million-row recalculation runs it a million times. Every
 * axis a hostile or merely thoughtless formula could exhaust is bounded, and exceeding any of
 * them yields `#LIMIT!` rather than a hang — see docs/07 §1.2.
 */
export interface Budget {
  readonly steps: number;
  readonly depth: number;
  readonly stringLength: number;
  readonly arrayLength: number;
}

export const DEFAULT_BUDGET: Budget = {
  steps: 10_000,
  depth: 64,
  stringLength: 100_000,
  arrayLength: 10_000,
};

/** Renders a type for an error message. */
export function typeName(type: FormulaType): string {
  switch (type.k) {
    case 'array':
      return `array of ${typeName(type.of)}`;
    case 'date':
      return type.hasTime ? 'date and time' : 'date';
    default:
      return type.k;
  }
}

/**
 * Whether a value of type `from` is acceptable where `to` is expected.
 *
 * The coercion table is short on purpose (docs/07 §3). `"3" + 4` is a type error, not `7` and not
 * `"34"`: silent coercion is where most spreadsheet bugs are born, and the whole point of
 * checking formulas before they are saved is to refuse the ambiguity rather than guess at it.
 */
export function assignable(from: FormulaType, to: FormulaType): boolean {
  if (to.k === 'any' || from.k === 'any') return true;
  // An error flows anywhere; it propagates rather than being caught by the checker.
  if (from.k === 'error') return true;
  // Blank unifies with everything: an empty cell is a legal argument to anything.
  if (from.k === 'blank') return true;
  if (from.k === to.k) {
    if (from.k === 'array' && to.k === 'array') return assignable(from.of, to.of);
    return true;
  }
  // A duration is a number of seconds and may be used as one.
  if (from.k === 'duration' && to.k === 'number') return true;
  return false;
}

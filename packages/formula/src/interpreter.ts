import type { Node } from './ast';
import { asBoolean, asNumber, asText, lookupFunction, looseEquals, type CallContext } from './functions';
import { DEFAULT_BUDGET, FormulaError, isError, type Budget, type FormulaValue } from './types';

/**
 * Tree-walking interpreter.
 *
 * Two invariants, both from docs/07 §1:
 *
 *  - **It never throws.** Every failure becomes a `FormulaError` value that propagates like NaN.
 *    A formula in one cell of one record must not be able to fail a request that reads a page.
 *  - **It is bounded.** Steps, recursion depth, string length and array length are all capped;
 *    exceeding any yields `#LIMIT!`. A formula is run once per record, so an unbounded one is an
 *    outage, not a slow query.
 */

export interface EvaluationContext {
  /** Current values by field id. */
  readonly fields: Readonly<Record<string, FormulaValue>>;
  /** Fixed across the batch so a million-row recalculation agrees on "now". */
  readonly now: Date;
  readonly timezone?: string;
  readonly locale?: string;
  readonly recordId?: string | null;
  readonly createdTime?: Date | null;
  readonly lastModifiedTime?: Date | null;
  readonly currentUserId?: string | null;
  readonly currentUserName?: string | null;
  readonly budget?: Budget;
}

export function evaluate(node: Node, context: EvaluationContext): FormulaValue {
  const budget = context.budget ?? DEFAULT_BUDGET;
  let steps = 0;

  /** Thrown internally to unwind to the top; never escapes `evaluate`. */
  class BudgetExceeded extends Error {}

  const spend = (): void => {
    steps += 1;
    if (steps > budget.steps) throw new BudgetExceeded();
  };

  const base: Omit<CallContext, 'evaluate'> = {
    now: context.now,
    timezone: context.timezone ?? 'UTC',
    locale: context.locale ?? 'en',
    recordId: context.recordId ?? null,
    createdTime: context.createdTime ?? null,
    lastModifiedTime: context.lastModifiedTime ?? null,
    currentUserId: context.currentUserId ?? null,
    currentUserName: context.currentUserName ?? null,
    stringLimit: budget.stringLength,
    arrayLimit: budget.arrayLength,
  };

  function run(node: Node, depth: number): FormulaValue {
    spend();
    if (depth > budget.depth) throw new BudgetExceeded();

    switch (node.kind) {
      case 'literal':
        return node.value;

      case 'field': {
        // A formula that survived the checker has a bound id. An unbound one means the field was
        // deleted after the formula was saved, which is exactly what #REF! is for.
        if (!node.fieldId) return new FormulaError('#REF!', `no field named "${node.name}"`);
        return context.fields[node.fieldId] ?? null;
      }

      case 'unary': {
        const operand = run(node.operand, depth + 1);
        if (isError(operand)) return operand;
        if (node.operator === 'NOT') {
          const value = asBoolean(operand);
          return isError(value) ? value : !value;
        }
        const number = asNumber(operand);
        if (isError(number)) return number;
        return node.operator === '-' ? -number : number;
      }

      case 'binary':
        return runBinary(node, depth);

      case 'conditional': {
        const condition = asBoolean(run(node.condition, depth + 1));
        if (isError(condition)) return condition;
        return run(condition ? node.whenTrue : node.whenFalse, depth + 1);
      }

      case 'call':
        return runCall(node, depth);
    }
  }

  function runBinary(node: Extract<Node, { kind: 'binary' }>, depth: number): FormulaValue {
    // AND and OR short-circuit, so the right side is not evaluated when the left decides it.
    if (node.operator === 'AND' || node.operator === 'OR') {
      const left = asBoolean(run(node.left, depth + 1));
      if (isError(left)) return left;
      if (node.operator === 'AND' && !left) return false;
      if (node.operator === 'OR' && left) return true;
      const right = asBoolean(run(node.right, depth + 1));
      return isError(right) ? right : right;
    }

    const left = run(node.left, depth + 1);
    if (isError(left)) return left;
    const right = run(node.right, depth + 1);
    if (isError(right)) return right;

    switch (node.operator) {
      case '&': {
        const a = asText(left);
        if (isError(a)) return a;
        const b = asText(right);
        if (isError(b)) return b;
        if (a.length + b.length > budget.stringLength) {
          return new FormulaError('#LIMIT!', 'the result grew too long');
        }
        return a + b;
      }

      case '=':
        return looseEquals(left, right);
      case '!=':
        return !looseEquals(left, right);

      case '<':
      case '<=':
      case '>':
      case '>=':
        return compare(node.operator, left, right);

      case '+':
      case '-': {
        // Date arithmetic, mirroring what the checker allowed.
        if (left instanceof Date && right instanceof Date && node.operator === '-') {
          return left.getTime() - right.getTime();
        }
        if (left instanceof Date) {
          const offset = asNumber(right);
          if (isError(offset)) return offset;
          return new Date(left.getTime() + (node.operator === '+' ? offset : -offset));
        }
        return arithmetic(node.operator, left, right);
      }

      default:
        return arithmetic(node.operator, left, right);
    }
  }

  function arithmetic(operator: string, left: FormulaValue, right: FormulaValue): FormulaValue {
    const a = asNumber(left);
    if (isError(a)) return a;
    const b = asNumber(right);
    if (isError(b)) return b;

    switch (operator) {
      case '+':
        return a + b;
      case '-':
        return a - b;
      case '*':
        return a * b;
      case '/':
        return b === 0 ? new FormulaError('#DIV/0!') : a / b;
      case '%':
        return b === 0 ? new FormulaError('#DIV/0!') : a % b;
      case '^': {
        const result = a ** b;
        return Number.isFinite(result) ? result : new FormulaError('#VALUE!', 'the result is not finite');
      }
      default:
        return new FormulaError('#TYPE!', `unknown operator "${operator}"`);
    }
  }

  function compare(operator: string, left: FormulaValue, right: FormulaValue): FormulaValue {
    // Text compares lexicographically; everything else numerically (dates via their timestamp).
    if (typeof left === 'string' && typeof right === 'string') {
      switch (operator) {
        case '<':
          return left < right;
        case '<=':
          return left <= right;
        case '>':
          return left > right;
        default:
          return left >= right;
      }
    }

    const a = asNumber(left);
    if (isError(a)) return a;
    const b = asNumber(right);
    if (isError(b)) return b;

    switch (operator) {
      case '<':
        return a < b;
      case '<=':
        return a <= b;
      case '>':
        return a > b;
      default:
        return a >= b;
    }
  }

  function runCall(node: Extract<Node, { kind: 'call' }>, depth: number): FormulaValue {
    const spec = lookupFunction(node.name);
    if (!spec) return new FormulaError('#REF!', `no function named ${node.name}`);

    // Lazy functions receive an evaluator instead of values, so IF only runs the branch it takes
    // and IFERROR can catch an error the other side would have raised.
    if (spec.lazy) {
      const context: CallContext = {
        ...base,
        evaluate: (index) => {
          const arg = node.args[index];
          return arg === undefined ? null : run(arg, depth + 1);
        },
      };
      // Placeholders: a lazy function reads only the argument count from this array.
      return spec.call(node.args.map(() => null), context);
    }

    const args: FormulaValue[] = [];
    for (const arg of node.args) {
      const value = run(arg, depth + 1);
      // Errors propagate through strict functions without calling them, which is what makes
      // `IFERROR(1/0, "n/a")` work while `ABS(1/0)` stays #DIV/0!.
      if (isError(value)) return value;
      args.push(value);
    }

    return spec.call(args, base as CallContext);
  }

  try {
    return run(node, 0);
  } catch (error) {
    // The only exception that reaches here is the budget unwind. Anything else would be a bug in
    // the interpreter, and turning it into a value would hide it — so it is reported as #TYPE!
    // with the detail attached rather than crashing the caller.
    if (error instanceof BudgetExceeded) {
      return new FormulaError('#LIMIT!', 'this formula is too expensive to evaluate');
    }
    return new FormulaError('#TYPE!', error instanceof Error ? error.message : 'evaluation failed');
  }
}

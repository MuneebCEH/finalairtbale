import type { Node } from './ast';
import { lookupFunction, type FunctionSpec } from './functions';
import { FormulaCompileError, T, assignable, typeName, type FormulaType } from './types';

/**
 * Static type checker.
 *
 * Runs before a formula is ever saved, so `DATEADD("hello", 1, "days")` is refused at the point
 * of writing with a caret under the offending argument — not discovered as `#TYPE!` scattered
 * through a column three weeks later (docs/07 §3).
 */

export interface FieldResolver {
  /** Resolves a field name to its id and formula type, or undefined when there is no such field. */
  (name: string): { id: string; type: FormulaType } | undefined;
}

export interface CheckResult {
  readonly type: FormulaType;
  /** Field ids this formula reads, in first-seen order. The dependency graph's edges. */
  readonly dependencies: readonly string[];
  /** Sum of the cost weights, used to reject formulas that are too expensive to run per-row. */
  readonly cost: number;
}

export function check(node: Node, resolve: FieldResolver): CheckResult {
  const dependencies: string[] = [];
  const seen = new Set<string>();
  let cost = 0;

  function visit(node: Node): FormulaType {
    cost += 1;

    switch (node.kind) {
      case 'literal': {
        const type =
          node.value === null
            ? T.blank
            : typeof node.value === 'number'
              ? T.number
              : typeof node.value === 'boolean'
                ? T.boolean
                : T.text;
        node.type = type;
        return type;
      }

      case 'field': {
        const field = resolve(node.name);
        if (!field) {
          throw new FormulaCompileError(
            `There is no field called "${node.name}" in this table.`,
            node.start,
            node.end,
          );
        }
        node.fieldId = field.id;
        if (!seen.has(field.id)) {
          seen.add(field.id);
          dependencies.push(field.id);
        }
        node.type = field.type;
        return field.type;
      }

      case 'unary': {
        const operand = visit(node.operand);
        if (node.operator === 'NOT') {
          node.type = T.boolean;
          return T.boolean;
        }
        requireAssignable(operand, T.number, node.operand, `${node.operator} needs a number`);
        node.type = T.number;
        return T.number;
      }

      case 'binary':
        return visitBinary(node);

      case 'conditional': {
        visit(node.condition);
        const whenTrue = visit(node.whenTrue);
        const whenFalse = visit(node.whenFalse);
        // The two branches need not agree; the result is their union, which collapses to `any`
        // unless they are the same. Forcing them to match would reject the common and reasonable
        // `{Score} > 5 ? "high" : BLANK()`.
        const type = unify(whenTrue, whenFalse);
        node.type = type;
        return type;
      }

      case 'call':
        return visitCall(node);
    }
  }

  function visitBinary(node: Extract<Node, { kind: 'binary' }>): FormulaType {
    const left = visit(node.left);
    const right = visit(node.right);

    switch (node.operator) {
      case '&': {
        node.type = T.text;
        return T.text;
      }

      case 'AND':
      case 'OR': {
        node.type = T.boolean;
        return T.boolean;
      }

      case '=':
      case '!=': {
        node.type = T.boolean;
        return T.boolean;
      }

      case '<':
      case '<=':
      case '>':
      case '>=': {
        // Ordering is defined for numbers, dates and text, but not across them: comparing a date
        // with a number is almost always a mistake in a formula, and silently coercing hides it.
        if (!comparable(left, right)) {
          throw new FormulaCompileError(
            `${typeName(left)} and ${typeName(right)} cannot be compared with "${node.operator}".`,
            node.start,
            node.end,
          );
        }
        node.type = T.boolean;
        return T.boolean;
      }

      case '+':
      case '-': {
        // Date minus date is a duration; date plus/minus a number shifts it. Both are useful and
        // both are unambiguous, so they are allowed where a bare `"3" + 4` is not.
        if (left.k === 'date' && right.k === 'date' && node.operator === '-') {
          node.type = T.duration;
          return T.duration;
        }
        if (left.k === 'date' && assignable(right, T.number)) {
          node.type = left;
          return left;
        }
        requireAssignable(left, T.number, node.left, `"${node.operator}" needs numbers`);
        requireAssignable(right, T.number, node.right, `"${node.operator}" needs numbers`);
        node.type = T.number;
        return T.number;
      }

      default: {
        requireAssignable(left, T.number, node.left, `"${node.operator}" needs numbers`);
        requireAssignable(right, T.number, node.right, `"${node.operator}" needs numbers`);
        node.type = T.number;
        return T.number;
      }
    }
  }

  function visitCall(node: Extract<Node, { kind: 'call' }>): FormulaType {
    const spec = lookupFunction(node.name);
    if (!spec) {
      throw new FormulaCompileError(
        `There is no function called ${node.name}.`,
        node.nameStart,
        node.nameEnd,
      );
    }

    cost += spec.cost ?? 1;

    const required = spec.params.filter((p) => !p.optional).length;
    const maximum = spec.rest ? Infinity : spec.params.length;

    if (node.args.length < required || node.args.length > maximum) {
      throw new FormulaCompileError(describeArity(spec, node.args.length), node.start, node.end);
    }

    const argTypes = node.args.map(visit);

    node.args.forEach((arg, index) => {
      const expected = spec.params[index]?.type ?? spec.rest ?? T.any;
      const actual = argTypes[index] as FormulaType;
      if (!assignable(actual, expected)) {
        const parameter = spec.params[index]?.name ?? 'value';
        throw new FormulaCompileError(
          `${spec.name}'s "${parameter}" needs ${typeName(expected)}, but this is ${typeName(actual)}.`,
          arg.start,
          arg.end,
        );
      }
    });

    const type = typeof spec.returns === 'function' ? spec.returns(argTypes) : spec.returns;
    node.type = type;
    return type;
  }

  function requireAssignable(actual: FormulaType, expected: FormulaType, at: Node, message: string): void {
    if (assignable(actual, expected)) return;
    throw new FormulaCompileError(`${message}, but this is ${typeName(actual)}.`, at.start, at.end);
  }

  const type = visit(node);
  return { type, dependencies, cost };
}

/** Two types unify to themselves when equal, to the non-blank one when one is blank, else `any`. */
function unify(a: FormulaType, b: FormulaType): FormulaType {
  if (a.k === b.k) return a;
  if (a.k === 'blank') return b;
  if (b.k === 'blank') return a;
  return T.any;
}

function comparable(a: FormulaType, b: FormulaType): boolean {
  if (a.k === 'any' || b.k === 'any' || a.k === 'blank' || b.k === 'blank' || a.k === 'error' || b.k === 'error') {
    return true;
  }
  const ordered = (type: FormulaType): string | null =>
    type.k === 'number' || type.k === 'duration'
      ? 'number'
      : type.k === 'date'
        ? 'date'
        : type.k === 'text'
          ? 'text'
          : null;

  const left = ordered(a);
  const right = ordered(b);
  return left !== null && left === right;
}

function describeArity(spec: FunctionSpec, given: number): string {
  const required = spec.params.filter((p) => !p.optional).length;
  const optional = spec.params.length - required;

  const expected = spec.rest
    ? `at least ${required}`
    : optional > 0
      ? `between ${required} and ${spec.params.length}`
      : `${required}`;

  return `${spec.name} takes ${expected} argument${expected === '1' ? '' : 's'}, but ${given} ${given === 1 ? 'was' : 'were'} given.`;
}

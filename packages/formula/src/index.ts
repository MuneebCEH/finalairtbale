import { createHash } from 'node:crypto';

import type { Node } from './ast';
import { check, type FieldResolver } from './checker';
import { evaluate, type EvaluationContext } from './interpreter';
import { parse } from './parser';
import { FormulaCompileError, type FormulaType, type FormulaValue } from './types';

export * from './types';
export { LinearRegex, RegexSyntaxError, compileRegex } from './regex';
export * from './ast';
export { parse } from './parser';
export { tokenize } from './lexer';
export { check, type FieldResolver } from './checker';
export { evaluate, type EvaluationContext } from './interpreter';
export { FUNCTIONS, lookupFunction, type FunctionSpec, type Parameter } from './functions';

/**
 * A formula that has been parsed, resolved and type-checked.
 *
 * Compilation happens once per formula; evaluation happens once per record. A million-row
 * recalculation must not parse a million times, so this is the unit that gets cached — keyed by
 * `hash`, which covers the source text and nothing else, plus the schema version at the call site.
 */
export interface CompiledFormula {
  readonly ast: Node;
  readonly type: FormulaType;
  /** Field ids this formula reads. These are the dependency graph's edges. */
  readonly dependencies: readonly string[];
  readonly cost: number;
  readonly hash: string;
}

export interface CompileResult {
  readonly ok: true;
  readonly formula: CompiledFormula;
}

export interface CompileFailure {
  readonly ok: false;
  readonly message: string;
  readonly start: number;
  readonly end: number;
}

/**
 * Parses and type-checks a formula.
 *
 * Returns a result rather than throwing: a bad formula is ordinary user input arriving over an
 * API, not an exceptional condition, and the caller needs the message and span to show a caret.
 */
export function compile(source: string, resolve: FieldResolver): CompileResult | CompileFailure {
  try {
    const ast = parse(source);
    const { type, dependencies, cost } = check(ast, resolve);

    return {
      ok: true,
      formula: {
        ast,
        type,
        dependencies,
        cost,
        hash: createHash('sha256').update(source).digest('hex').slice(0, 32),
      },
    };
  } catch (error) {
    if (error instanceof FormulaCompileError) {
      return { ok: false, message: error.message, start: error.start, end: error.end };
    }
    throw error;
  }
}

/** Compiles and evaluates in one step. For tests and one-off evaluation, not for bulk recalc. */
export function run(
  source: string,
  resolve: FieldResolver,
  context: EvaluationContext,
): FormulaValue | CompileFailure {
  const result = compile(source, resolve);
  if (!result.ok) return result;
  return evaluate(result.formula.ast, context);
}

/**
 * Orders formula fields so each is computed after everything it reads.
 *
 * Returns the evaluation order, or the members of a cycle when one exists. Kahn's algorithm: a
 * node enters the queue once every field it depends on has been emitted, so anything still
 * holding an unmet dependency at the end is part of a cycle — which is precisely the set the
 * caller must refuse to save (docs/07 §7).
 */
export function topologicalOrder(
  fields: ReadonlyArray<{ id: string; dependencies: readonly string[] }>,
): { ok: true; order: string[] } | { ok: false; cycle: string[] } {
  const known = new Set(fields.map((field) => field.id));
  const remaining = new Map<string, Set<string>>();
  const dependents = new Map<string, string[]>();

  for (const field of fields) {
    // Only edges between formula fields matter here; a dependency on a plain data column is
    // always satisfied and would otherwise deadlock the queue.
    const edges = field.dependencies.filter((id) => known.has(id) && id !== field.id);
    remaining.set(field.id, new Set(edges));
    for (const edge of edges) {
      dependents.set(edge, [...(dependents.get(edge) ?? []), field.id]);
    }
  }

  const queue = fields.filter((field) => (remaining.get(field.id) as Set<string>).size === 0).map((f) => f.id);
  const order: string[] = [];

  while (queue.length > 0) {
    const id = queue.shift() as string;
    order.push(id);
    for (const dependent of dependents.get(id) ?? []) {
      const pending = remaining.get(dependent) as Set<string>;
      pending.delete(id);
      if (pending.size === 0) queue.push(dependent);
    }
  }

  if (order.length !== fields.length) {
    const cycle = fields.map((f) => f.id).filter((id) => !order.includes(id));
    return { ok: false, cycle };
  }

  return { ok: true, order };
}

import type { FormulaType } from './types';

/**
 * The abstract syntax tree.
 *
 * Every node carries its source span so the type checker can report against the exact text the
 * user wrote, and a mutable `type` the checker fills in on its pass.
 */

export interface NodeBase {
  readonly start: number;
  readonly end: number;
  /** Assigned by the type checker. Absent until then. */
  type?: FormulaType;
}

export interface LiteralNode extends NodeBase {
  readonly kind: 'literal';
  readonly value: string | number | boolean | null;
}

export interface FieldNode extends NodeBase {
  readonly kind: 'field';
  /** The name as written, kept for error messages and for re-rendering the formula. */
  readonly name: string;
  /** Bound by the resolver. Absent when the field could not be found. */
  fieldId?: string;
}

export interface UnaryNode extends NodeBase {
  readonly kind: 'unary';
  readonly operator: '-' | '+' | 'NOT';
  readonly operand: Node;
}

export interface BinaryNode extends NodeBase {
  readonly kind: 'binary';
  readonly operator: BinaryOperator;
  readonly left: Node;
  readonly right: Node;
}

export type BinaryOperator =
  | '+' | '-' | '*' | '/' | '%' | '^'
  | '&'
  | '=' | '!=' | '<' | '<=' | '>' | '>='
  | 'AND' | 'OR';

export interface ConditionalNode extends NodeBase {
  readonly kind: 'conditional';
  readonly condition: Node;
  readonly whenTrue: Node;
  readonly whenFalse: Node;
}

export interface CallNode extends NodeBase {
  readonly kind: 'call';
  /** Upper-cased at parse time; the language is case-insensitive for function names. */
  readonly name: string;
  readonly args: Node[];
  /** The span of the name alone, for "no such function" errors. */
  readonly nameStart: number;
  readonly nameEnd: number;
}

export type Node = LiteralNode | FieldNode | UnaryNode | BinaryNode | ConditionalNode | CallNode;

/** Walks every node depth-first. Used by the resolver, the optimiser and the dependency scan. */
export function walk(node: Node, visit: (node: Node) => void): void {
  visit(node);
  switch (node.kind) {
    case 'unary':
      walk(node.operand, visit);
      break;
    case 'binary':
      walk(node.left, visit);
      walk(node.right, visit);
      break;
    case 'conditional':
      walk(node.condition, visit);
      walk(node.whenTrue, visit);
      walk(node.whenFalse, visit);
      break;
    case 'call':
      for (const arg of node.args) walk(arg, visit);
      break;
    default:
      break;
  }
}

import type { BinaryOperator, Node } from './ast';
import { tokenize, type Token } from './lexer';
import { FormulaCompileError } from './types';

/**
 * Precedence-climbing parser for the grammar in docs/07-formula-engine.md §4.
 *
 * Written by hand rather than generated, and deliberately so: the whole engine exists to avoid
 * `eval`, and pulling in an expression library that compiles to JavaScript would reintroduce
 * exactly the hazard the design forbids (§1.1).
 *
 * Binding powers, loosest first. `^` is right-associative; everything else is left.
 */
const BINDING: ReadonlyArray<{ operators: readonly string[]; right?: boolean }> = [
  { operators: ['OR', '||'] },
  { operators: ['AND', '&&'] },
  { operators: ['=', '!=', '<', '<=', '>', '>='] },
  { operators: ['&'] },
  { operators: ['+', '-'] },
  { operators: ['*', '/', '%'] },
  { operators: ['^'], right: true },
];

/** Word forms of operators. Case-insensitive, like function names. */
const WORD_OPERATORS = new Set(['AND', 'OR', 'NOT']);

export function parse(source: string): Node {
  const tokens = tokenize(source);
  let position = 0;

  const peek = (): Token => tokens[position] as Token;
  const next = (): Token => tokens[position++] as Token;

  const at = (kind: Token['kind'], value?: string): boolean => {
    const token = peek();
    if (token.kind !== kind) return false;
    if (value === undefined) return true;
    return kind === 'identifier' ? token.value.toUpperCase() === value : token.value === value;
  };

  const expect = (kind: Token['kind'], value: string): Token => {
    if (!at(kind, value)) {
      const token = peek();
      const found = token.kind === 'eof' ? 'the end of the formula' : `"${token.value}"`;
      throw new FormulaCompileError(`Expected "${value}" but found ${found}.`, token.start, token.end);
    }
    return next();
  };

  /** True when the current token is the given binary operator, in symbol or word form. */
  const atOperator = (operator: string): boolean =>
    WORD_OPERATORS.has(operator) ? at('identifier', operator) : at('operator', operator);

  function parseExpression(level = 0): Node {
    if (level >= BINDING.length) return parseUnary();

    const rung = BINDING[level] as { operators: readonly string[]; right?: boolean };
    let left = parseExpression(level + 1);

    for (;;) {
      const operator = rung.operators.find(atOperator);
      if (!operator) break;
      next();

      // Right-associative operators recurse at their own level so `2^3^2` groups as `2^(3^2)`.
      const right = rung.right ? parseExpression(level) : parseExpression(level + 1);

      left = {
        kind: 'binary',
        // `||` and `&&` are spellings of OR and AND; normalising here keeps the checker and the
        // interpreter from having to know about both.
        operator: normaliseOperator(operator),
        left,
        right,
        start: left.start,
        end: right.end,
      };

      if (rung.right) break;
    }

    return left;
  }

  function parseUnary(): Node {
    if (at('operator', '-') || at('operator', '+') || at('operator', '!') || at('identifier', 'NOT')) {
      const token = next();
      const operand = parseUnary();
      const operator = token.value === '!' || token.value.toUpperCase() === 'NOT' ? 'NOT' : (token.value as '-' | '+');
      return { kind: 'unary', operator, operand, start: token.start, end: operand.end };
    }
    return parsePrimary();
  }

  function parsePrimary(): Node {
    const token = peek();

    if (token.kind === 'number') {
      next();
      return { kind: 'literal', value: Number(token.value), start: token.start, end: token.end };
    }

    if (token.kind === 'string') {
      next();
      return { kind: 'literal', value: token.value, start: token.start, end: token.end };
    }

    if (token.kind === 'fieldRef') {
      next();
      return { kind: 'field', name: token.value, start: token.start, end: token.end };
    }

    if (token.kind === 'identifier') {
      const upper = token.value.toUpperCase();

      // TRUE/FALSE/BLANK are literals, but only when not followed by "(" — `TRUE()` is the
      // function form and both spellings are in the catalogue.
      if ((upper === 'TRUE' || upper === 'FALSE' || upper === 'BLANK') && tokens[position + 1]?.value !== '(') {
        next();
        return {
          kind: 'literal',
          value: upper === 'BLANK' ? null : upper === 'TRUE',
          start: token.start,
          end: token.end,
        };
      }

      next();
      if (!at('punctuation', '(')) {
        throw new FormulaCompileError(
          `"${token.value}" is not a value. Field names go in braces, like {${token.value}}.`,
          token.start,
          token.end,
        );
      }
      next(); // consume '('

      const args: Node[] = [];
      if (!at('punctuation', ')')) {
        args.push(parseTernary());
        while (at('punctuation', ',')) {
          next();
          args.push(parseTernary());
        }
      }
      const close = expect('punctuation', ')');

      return {
        kind: 'call',
        name: upper,
        args,
        start: token.start,
        end: close.end,
        nameStart: token.start,
        nameEnd: token.end,
      };
    }

    if (token.kind === 'punctuation' && token.value === '(') {
      next();
      const inner = parseTernary();
      expect('punctuation', ')');
      return inner;
    }

    const found = token.kind === 'eof' ? 'the formula ended early' : `found "${token.value}"`;
    throw new FormulaCompileError(`Expected a value here, but ${found}.`, token.start, token.end);
  }

  function parseTernary(): Node {
    const condition = parseExpression();
    if (!at('punctuation', '?')) return condition;

    next();
    const whenTrue = parseTernary();
    expect('punctuation', ':');
    const whenFalse = parseTernary();

    return {
      kind: 'conditional',
      condition,
      whenTrue,
      whenFalse,
      start: condition.start,
      end: whenFalse.end,
    };
  }

  if (source.trim() === '') {
    throw new FormulaCompileError('A formula cannot be empty.', 0, 0);
  }

  const result = parseTernary();

  if (peek().kind !== 'eof') {
    const token = peek();
    throw new FormulaCompileError(
      `"${token.value}" is not expected here. Is an operator missing?`,
      token.start,
      token.end,
    );
  }

  return result;
}

function normaliseOperator(operator: string): BinaryOperator {
  if (operator === '||') return 'OR';
  if (operator === '&&') return 'AND';
  return operator.toUpperCase() as BinaryOperator;
}

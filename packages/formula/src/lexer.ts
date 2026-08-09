import { FormulaCompileError } from './types';

/**
 * Tokeniser.
 *
 * Every token carries its source span. That is not bookkeeping for its own sake: the editor puts
 * a caret under the offending argument, and an error that can only say "type mismatch somewhere"
 * is an error a user cannot act on.
 */

export type TokenKind =
  | 'number'
  | 'string'
  | 'identifier'
  | 'fieldRef'
  | 'operator'
  | 'punctuation'
  | 'eof';

export interface Token {
  readonly kind: TokenKind;
  /** For strings and field references, the decoded content, not the source text. */
  readonly value: string;
  readonly start: number;
  readonly end: number;
}

/** Multi-character operators must be tested before their single-character prefixes. */
const OPERATORS = ['!=', '<=', '>=', '&&', '||', '=', '<', '>', '+', '-', '*', '/', '%', '^', '&', '!'];

const PUNCTUATION = ['(', ')', ',', '?', ':'];

export function tokenize(source: string): Token[] {
  const tokens: Token[] = [];
  let index = 0;

  const push = (kind: TokenKind, value: string, start: number): void => {
    tokens.push({ kind, value, start, end: index });
  };

  while (index < source.length) {
    const char = source[index] as string;

    if (char === ' ' || char === '\t' || char === '\n' || char === '\r') {
      index += 1;
      continue;
    }

    // ── Field reference: {Field Name} ──
    // Braces, not bare identifiers, because field names contain spaces, punctuation and digits.
    // The resolver later binds the name to a field id so a rename does not break the formula.
    if (char === '{') {
      const start = index;
      index += 1;
      let name = '';
      while (index < source.length && source[index] !== '}') {
        // Escaped brace, so a field genuinely named "a}b" is expressible.
        if (source[index] === '\\' && index + 1 < source.length) {
          name += source[index + 1];
          index += 2;
          continue;
        }
        name += source[index];
        index += 1;
      }
      if (index >= source.length) {
        throw new FormulaCompileError('This field reference is missing its closing "}".', start, index);
      }
      index += 1; // consume '}'
      push('fieldRef', name, start);
      continue;
    }

    // ── String literal ──
    if (char === '"' || char === "'") {
      const quote = char;
      const start = index;
      index += 1;
      let text = '';
      while (index < source.length && source[index] !== quote) {
        if (source[index] === '\\' && index + 1 < source.length) {
          const escaped = source[index + 1] as string;
          text +=
            escaped === 'n' ? '\n' : escaped === 't' ? '\t' : escaped === 'r' ? '\r' : escaped;
          index += 2;
          continue;
        }
        text += source[index];
        index += 1;
      }
      if (index >= source.length) {
        throw new FormulaCompileError('This text value is missing its closing quote.', start, index);
      }
      index += 1; // consume closing quote
      push('string', text, start);
      continue;
    }

    // ── Number ──
    if (isDigit(char) || (char === '.' && isDigit(source[index + 1] ?? ''))) {
      const start = index;
      while (index < source.length && isDigit(source[index] as string)) index += 1;
      if (source[index] === '.') {
        index += 1;
        while (index < source.length && isDigit(source[index] as string)) index += 1;
      }
      // Scientific notation, but only when an exponent actually follows: "1e" is not a number,
      // and treating it as one would swallow the following identifier.
      if (source[index] === 'e' || source[index] === 'E') {
        const mark = index;
        index += 1;
        if (source[index] === '+' || source[index] === '-') index += 1;
        if (isDigit(source[index] ?? '')) {
          while (index < source.length && isDigit(source[index] as string)) index += 1;
        } else {
          index = mark;
        }
      }
      push('number', source.slice(start, index), start);
      continue;
    }

    // ── Identifier / keyword ──
    if (isIdentifierStart(char)) {
      const start = index;
      while (index < source.length && isIdentifierPart(source[index] as string)) index += 1;
      push('identifier', source.slice(start, index), start);
      continue;
    }

    // ── Operator ──
    const operator = OPERATORS.find((op) => source.startsWith(op, index));
    if (operator) {
      const start = index;
      index += operator.length;
      push('operator', operator, start);
      continue;
    }

    if (PUNCTUATION.includes(char)) {
      const start = index;
      index += 1;
      push('punctuation', char, start);
      continue;
    }

    throw new FormulaCompileError(`"${char}" is not something a formula can contain.`, index, index + 1);
  }

  tokens.push({ kind: 'eof', value: '', start: index, end: index });
  return tokens;
}

const isDigit = (char: string): boolean => char >= '0' && char <= '9';

const isIdentifierStart = (char: string): boolean =>
  (char >= 'a' && char <= 'z') || (char >= 'A' && char <= 'Z') || char === '_';

const isIdentifierPart = (char: string): boolean => isIdentifierStart(char) || isDigit(char);

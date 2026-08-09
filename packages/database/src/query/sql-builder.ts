/**
 * A tiny parameterised-SQL accumulator.
 *
 * Every dynamic value goes through `bind()`, which returns a `$n` placeholder and stores the
 * value. Identifiers go through `ident()`, which accepts only names from a fixed allowlist —
 * the slot columns and the handful of system columns — so a field id can never reach the
 * statement text.
 *
 * The rule this enforces: **the statement text is assembled only from constants and allowlisted
 * identifiers; everything derived from user input is a bind parameter.** That is what makes the
 * dynamic query builder safe despite building SQL from a user-authored filter tree.
 */
export class SqlBuilder {
  private readonly parts: string[] = [];
  private readonly params: unknown[] = [];

  /** Appends literal SQL. Callers pass constants only — never interpolated user input. */
  push(sql: string): this {
    this.parts.push(sql);
    return this;
  }

  /** Binds a value and returns its placeholder. */
  bind(value: unknown): string {
    this.params.push(value);
    return `$${this.params.length}`;
  }

  /** Binds several values and returns a parenthesised placeholder list. */
  bindList(values: readonly unknown[]): string {
    if (values.length === 0) return '(NULL)';
    return `(${values.map((value) => this.bind(value)).join(', ')})`;
  }

  get sql(): string {
    return this.parts.join(' ');
  }

  get values(): readonly unknown[] {
    return this.params;
  }

  get parameterCount(): number {
    return this.params.length;
  }
}

/**
 * Columns the query builder is permitted to name.
 *
 * An allowlist rather than an escaping function. Escaping is a decision you can get wrong;
 * membership of a fixed set is not.
 */
const ALLOWED_COLUMNS: ReadonlySet<string> = new Set([
  'id',
  'organization_id',
  'table_id',
  'data',
  'version',
  'auto_number',
  'created_at',
  'created_by',
  'updated_at',
  'updated_by',
  'deleted_at',
  's0', 's1', 's2', 's3',
  'n0', 'n1', 'n2', 'n3',
  'd0', 'd1', 'd2',
  'b0', 'b1',
]);

export function ident(column: string): string {
  if (!ALLOWED_COLUMNS.has(column)) {
    throw new Error(`Refusing to build SQL with the unrecognised column "${column}".`);
  }
  return `r.${column}`;
}

/**
 * A JSONB path expression for an unpromoted field.
 *
 * The field id is bound as a parameter rather than interpolated, so even here no user-controlled
 * text enters the statement. `->>` yields text; the caller casts when it needs another type.
 */
export function jsonPath(builder: SqlBuilder, fieldId: string): string {
  return `(r.data ->> ${builder.bind(fieldId)})`;
}

/** Field ids are ULIDs with a prefix; anything else is rejected before it reaches a query. */
export function assertFieldId(fieldId: string): void {
  if (!/^fld_[0-9A-HJKMNP-TV-Z]{26}$/.test(fieldId)) {
    throw new Error(`Malformed field id: ${fieldId}`);
  }
}

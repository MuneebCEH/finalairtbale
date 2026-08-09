# Tessera — Formula Engine Design

## 1. Hard constraints

1. **No arbitrary code execution.** No `eval`, no `new Function`, no `vm`, no `isolated-vm`, no
   expression library that compiles to JS. The engine is a hand-written lexer → parser →
   type-checker → tree-walking interpreter over a **fixed function table**.
2. **Bounded cost.** Every evaluation carries a step budget, a call-depth budget, a string-length
   budget, and an array-length budget. Exceeding any of them raises a `FormulaError`, never a hang.
3. **Total.** Evaluation never throws out of the interpreter. Division by zero, bad casts, and
   missing values produce typed error values that propagate like NaN, catchable with `IFERROR`.
4. **Deterministic per evaluation batch.** `NOW()` is fixed to the batch timestamp so a recalc of
   1M rows does not produce 1M different "now"s.

## 2. Pipeline

```
source text
   │  Lexer            → tokens (with source offsets, kept for error positions)
   │  Parser           → AST (Pratt / precedence-climbing for binary operators)
   │  Resolver         → field references bound to field ids; {Name} → fld_… (rename-safe)
   │  Type checker     → each node annotated with a FormulaType; errors with positions
   │  Cycle checker    → prospective dependency graph → Tarjan SCC → reject cycles
   │  Optimiser        → constant folding, short-circuit marking, common subexpression hoisting
   ↓  CompiledFormula  { ast, type, dependencies: FieldRef[], cost: number, hash: string }
      Interpreter      (per record) → FormulaValue
```

`CompiledFormula` is cached in-process (LRU, keyed by `formulaHash + schemaVersion`) and in Redis,
so a 1M-row recalc parses once and evaluates a million times.

## 3. Type system

```ts
type FormulaType =
  | { k: 'text' } | { k: 'number' } | { k: 'boolean' }
  | { k: 'date'; hasTime: boolean } | { k: 'duration' }
  | { k: 'array'; of: FormulaType }          // from lookups / multi-select
  | { k: 'record' }                          // linked record handle
  | { k: 'blank' }                           // empty; unifies with anything
  | { k: 'error' }
  | { k: 'any' };                            // only from explicitly dynamic sources
```

Static checking catches `DATEADD("hello", 1, 'days')` before it is saved, with the caret at the
offending argument. Implicit coercions are **explicit and few**: `blank → 0 | "" | false` in
arithmetic/text/logical positions; `number → text` in text functions; nothing else. `"3" + 4` is a
type error, not `7` and not `"34"` — silent coercion is the source of most spreadsheet bugs.

## 4. Grammar

```ebnf
expr        := ternary
ternary     := or ( "?" expr ":" expr )?
or          := and ( ("OR" | "||") and )*
and         := not ( ("AND" | "&&") not )*
not         := ("NOT" | "!")? comparison
comparison  := concat ( ("=" | "!=" | "<" | "<=" | ">" | ">=") concat )*
concat      := additive ( "&" additive )*
additive    := multiplicative ( ("+" | "-") multiplicative )*
multiplicative := unary ( ("*" | "/" | "%") unary )*
unary       := ("-" | "+")? power
power       := primary ( "^" unary )?
primary     := NUMBER | STRING | TRUE | FALSE | BLANK
             | fieldRef | funcCall | "(" expr ")"
fieldRef    := "{" IDENT_WITH_SPACES "}"
funcCall    := IDENT "(" ( expr ("," expr)* )? ")"
```

## 5. Function catalogue

Registered in `packages/formula/src/functions/*`. Each entry declares its signature (including
variadic and optional parameters), return type, purity, cost weight, and documentation used by the
editor's autocomplete panel.

**Text** — `CONCATENATE` `LEFT` `RIGHT` `MID` `LEN`/`LENGTH` `LOWER` `UPPER` `TRIM` `REPLACE`
`SUBSTITUTE` `SEARCH` `FIND` `REPT` `T` `ENCODE_URL_COMPONENT` `REGEX_MATCH` `REGEX_EXTRACT`
`REGEX_REPLACE`¹ `SPLIT` `JOIN`

**Numeric** — `ABS` `ROUND` `ROUNDUP` `ROUNDDOWN` `FLOOR` `CEILING` `INT` `MOD` `POWER` `SQRT`
`EXP` `LOG` `VALUE` `EVEN` `ODD` `SIGN`

**Aggregation** (over arrays from lookups/rollups) — `SUM` `AVERAGE` `MIN` `MAX` `COUNT` `COUNTA`
`COUNTALL` `ARRAYJOIN` `ARRAYUNIQUE` `ARRAYCOMPACT` `ARRAYFLATTEN` `ARRAYSLICE`

**Logical** — `IF` `AND` `OR` `NOT` `XOR` `SWITCH` `BLANK` `TRUE` `FALSE` `ISBLANK` `ISERROR`
`IFERROR` `ERROR`

**Date/time** — `TODAY` `NOW` `DATEADD` `DATESUB` `DATETIME_DIFF` `DATETIME_FORMAT`
`DATETIME_PARSE` `YEAR` `MONTH` `DAY` `HOUR` `MINUTE` `SECOND` `WEEKDAY` `WEEKNUM`
`WORKDAY` `WORKDAY_DIFF` `IS_AFTER` `IS_BEFORE` `IS_SAME` `SET_TIMEZONE` `SET_LOCALE`

**Formatting** — `FORMAT_NUMBER` `FORMAT_CURRENCY` `FORMAT_PERCENT`

**Record** — `RECORD_ID` `CREATED_TIME` `LAST_MODIFIED_TIME` `CURRENT_USER` `CURRENT_USER_ID`

¹ `REGEX_*` compile with a **linear-time engine (RE2 semantics)**, not the JS `RegExp`, and are
capped at 1,000 characters of input. Catastrophic backtracking is a denial-of-service vector and
is closed by construction, not by a timeout.

## 6. Error values

| Value | Produced by |
|---|---|
| `#TYPE!` | Argument type mismatch at runtime (should be rare — the checker catches most) |
| `#DIV/0!` | Division or modulo by zero |
| `#VALUE!` | `VALUE("abc")`, unparseable date |
| `#REF!` | Reference to a deleted field (until the formula is repaired) |
| `#CYCLE!` | Should be unreachable; a safety net if a graph edge is corrupted |
| `#LIMIT!` | Step/depth/size budget exceeded |
| `#N/A` | Rollup over an empty link set where the function requires input |

Errors propagate through operators (any error operand → the error) and are caught by
`IFERROR(value, fallback)` and inspected by `ISERROR(value)`.

## 7. Dependency graph & recalculation

Saving a formula field:

```
1. Compile → dependencies: FieldRef[]  (direct fields, and lookup/rollup paths via link fields)
2. Build the prospective graph = current field_dependencies ∪ new edges
3. Tarjan SCC → any component of size > 1, or a self-edge → reject with the cycle path shown
4. Persist field + replace its dependency edges, inside one transaction
5. Enqueue a full backfill for the new field (priority: bulk)
```

Changing a value:

```
changed field ids → BFS over field_dependencies (cached per base)
                  → dependent (fieldId, recordId) set, computed by walking record_links
                    for cross-table edges
                  → topological levels → batched recalc jobs (see 05-background-jobs)
```

**Only affected cells recalculate.** A change to `{Notes}` on one record recalculates the formula
fields that read `{Notes}` on that record and any rollups on parents that aggregate it — not the
table.

**Synchronous vs asynchronous.** If the affected set is ≤ 200 cells and depth ≤ 3, the recalc runs
inside the request transaction so the user sees the new value immediately. Otherwise the API
returns with the dependent cells marked `computing` and the worker fills them in, streaming deltas
over the realtime channel. The grid renders a subtle shimmer on computing cells; it never shows a
stale value as if it were fresh.

## 8. Rollups and lookups

- **Lookup** — `lookup(linkField, targetField)` returns `array<T>`. Implemented as an indexed join
  through `record_links`; the value is materialised into the dependent record's `data` so view
  queries can filter/sort on it without a join.
- **Rollup** — `rollup(linkField, targetField, aggregator)` where aggregator ∈ `SUM AVERAGE MIN MAX
  COUNT COUNTA CONCATENATE ARRAYJOIN ARRAYUNIQUE AND OR XOR`. Also materialised.
- Materialisation is what makes 1M-row rollup views fast: the aggregate is computed once on write,
  not on every read. The cost is write amplification, bounded by the dependency BFS.

## 9. Editor experience

The formula editor (`packages/ui/src/formula-editor`) provides:

- **Syntax highlighting** from the same lexer the server uses — one tokeniser, compiled to both
  targets, so the editor can never disagree with the backend.
- **Autocomplete** for functions (with signature + description + example) and `{Field}` references,
  filtered by the types valid in the current argument position.
- **Inline diagnostics** with the exact source range underlined.
- **Live preview** against the currently selected record, and against 3 sample records.
- **Dependency panel** listing what the formula reads and what would break if a referenced field
  were deleted.
- Field references are stored as ids; renaming a field rewrites the *display* only, so formulas
  never break on rename.

## 10. Security review of this design

| Vector | Mitigation |
|---|---|
| Code execution | No dynamic evaluation anywhere in the pipeline |
| ReDoS | RE2-semantics regex engine, input cap |
| CPU exhaustion | Step/depth budgets, per-tenant recalc concurrency cap, cost-weighted functions |
| Memory exhaustion | Array and string length caps; arrays are lazily windowed above 10k elements |
| Data exfiltration via formula | Formulas can only reference fields in the same base, and the compiler resolves references against the *caller's permitted field set* — a formula cannot read a field the editor cannot see |
| Formula injection through imported CSV | Imported values are data, never parsed as formulas. Formula fields are only created through the schema API |
| CSV injection on export | Leading `= + - @ \t \r` are escaped on export (see security doc T7) |

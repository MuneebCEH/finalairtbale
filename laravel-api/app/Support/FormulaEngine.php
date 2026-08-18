<?php

namespace App\Support;

use App\Models\Field;

/**
 * The formula engine: evaluates Airtable-style expressions server-side and injects the results
 * into record DTOs at read time.
 *
 * A formula lives in the field's `options.formula` as plain text — `{Price} * {Qty}`,
 * `IF({Status} = "Paid", "✓", "pending")` — and is parsed by a hand-rolled recursive-descent
 * parser. Never `eval()`: user text must not become PHP. Any parse or evaluation error yields
 * null (a blank cell), because a half-broken formula must not take the whole records request
 * down with it.
 *
 * Computed on read rather than stored: the value can never go stale when a referenced cell
 * changes, and the storage layer stays ignorant of derivation. The cost is that formulas are
 * not filterable/sortable server-side — acceptable for v1.
 */
final class FormulaEngine
{
    /** Formula-in-formula references are allowed, but only this deep. */
    private const MAX_DEPTH = 3;

    /** @var array<string, array{formulas: array<string,string>, names: array<string,string>, types: array<string,string>}> */
    private static array $cache = [];

    /**
     * Compute every formula field of the table into each DTO's `fields`. DTO shape is the one
     * RecordController::dto builds; `fields` may be an array or the `(object)[]` empty cast.
     *
     * @param array<int, array<string,mixed>> $dtos
     * @return array<int, array<string,mixed>>
     */
    public static function inject(string $tableId, array $dtos): array
    {
        $meta = self::tableMeta($tableId);
        if ($meta['formulas'] === []) {
            return $dtos;
        }

        foreach ($dtos as &$dto) {
            $fields = (array) ($dto['fields'] ?? []);
            foreach ($meta['formulas'] as $fieldId => $formula) {
                $fields[$fieldId] = self::evaluate($formula, $fields, $meta, 0);
            }
            $dto['fields'] = $fields === [] ? (object) [] : $fields;
        }

        return $dtos;
    }

    /** One DTO — the create/update/show responses. */
    public static function injectOne(string $tableId, array $dto): array
    {
        return self::inject($tableId, [$dto])[0];
    }

    /** Public for tests: evaluate a formula against a bare name=>value map. */
    public static function evalForTest(string $formula, array $valuesByName): mixed
    {
        $names = [];
        $data = [];
        $i = 0;
        foreach ($valuesByName as $name => $value) {
            $id = 'fld_test'.$i++;
            $names[$name] = $id;
            $data[$id] = $value;
        }

        return self::evaluate($formula, $data, ['formulas' => [], 'names' => $names, 'types' => []], 0);
    }

    // ── Internals ────────────────────────────────────────────────────────────

    private static function tableMeta(string $tableId): array
    {
        if (isset(self::$cache[$tableId])) {
            return self::$cache[$tableId];
        }

        $fields = Field::where('table_id', $tableId)->whereNull('deleted_at')
            ->get(['id', 'name', 'type', 'options']);

        $formulas = [];
        $names = [];
        $types = [];
        foreach ($fields as $f) {
            $names[$f->name] = $f->id;
            $types[$f->id] = $f->type;
            if ($f->type === 'formula') {
                $formula = (string) (((array) ($f->options ?? []))['formula'] ?? '');
                if (trim($formula) !== '') {
                    $formulas[$f->id] = $formula;
                }
            }
        }

        return self::$cache[$tableId] = ['formulas' => $formulas, 'names' => $names, 'types' => $types];
    }

    private static function evaluate(string $formula, array $data, array $meta, int $depth): mixed
    {
        if ($depth > self::MAX_DEPTH) {
            return null;
        }

        try {
            $tokens = self::tokenize($formula);
            $parser = new FormulaParser($tokens, function (string $name) use ($data, $meta, $depth) {
                $fieldId = $meta['names'][$name] ?? null;
                if ($fieldId === null) {
                    return null;
                }
                // A reference to another formula field computes that formula first.
                if (isset($meta['formulas'][$fieldId])) {
                    return self::evaluate($meta['formulas'][$fieldId], $data, $meta, $depth + 1);
                }

                return $data[$fieldId] ?? null;
            });

            return $parser->parse();
        } catch (\Throwable) {
            return null;
        }
    }

    /** @return array<int, array{t: string, v: string|float}> */
    private static function tokenize(string $src): array
    {
        $tokens = [];
        $len = strlen($src);
        $i = 0;

        while ($i < $len) {
            $ch = $src[$i];

            if (ctype_space($ch)) {
                $i++;
                continue;
            }

            // {Field Name}
            if ($ch === '{') {
                $end = strpos($src, '}', $i);
                if ($end === false) {
                    throw new \RuntimeException('Unclosed field reference');
                }
                $tokens[] = ['t' => 'field', 'v' => trim(substr($src, $i + 1, $end - $i - 1))];
                $i = $end + 1;
                continue;
            }

            // "string" or 'string'
            if ($ch === '"' || $ch === "'") {
                $quote = $ch;
                $out = '';
                $i++;
                while ($i < $len && $src[$i] !== $quote) {
                    if ($src[$i] === '\\' && $i + 1 < $len) {
                        $i++;
                    }
                    $out .= $src[$i++];
                }
                if ($i >= $len) {
                    throw new \RuntimeException('Unclosed string');
                }
                $i++;
                $tokens[] = ['t' => 'str', 'v' => $out];
                continue;
            }

            // Numbers (digits, optional decimal part)
            if (ctype_digit($ch) || ($ch === '.' && $i + 1 < $len && ctype_digit($src[$i + 1]))) {
                $start = $i;
                while ($i < $len && (ctype_digit($src[$i]) || $src[$i] === '.')) {
                    $i++;
                }
                $tokens[] = ['t' => 'num', 'v' => (float) substr($src, $start, $i - $start)];
                continue;
            }

            // Function names
            if (ctype_alpha($ch) || $ch === '_') {
                $start = $i;
                while ($i < $len && (ctype_alnum($src[$i]) || $src[$i] === '_')) {
                    $i++;
                }
                $tokens[] = ['t' => 'ident', 'v' => substr($src, $start, $i - $start)];
                continue;
            }

            // Two-char operators before one-char ones.
            $two = substr($src, $i, 2);
            if (in_array($two, ['!=', '<>', '>=', '<='], true)) {
                $tokens[] = ['t' => 'op', 'v' => $two === '<>' ? '!=' : $two];
                $i += 2;
                continue;
            }
            if (strpos('+-*/&=><(),', $ch) !== false) {
                $tokens[] = ['t' => 'op', 'v' => $ch];
                $i++;
                continue;
            }

            throw new \RuntimeException("Unexpected character '{$ch}'");
        }

        return $tokens;
    }
}

/**
 * Recursive-descent parser+evaluator over the token stream. Precedence, loosest to tightest:
 * comparison → additive (+ - &) → multiplicative (* /) → unary minus → primary.
 */
final class FormulaParser
{
    private int $pos = 0;

    /** @param array<int, array{t: string, v: string|float}> $tokens */
    public function __construct(
        private readonly array $tokens,
        /** @var callable(string): mixed resolves a {Field Name} to its raw cell value */
        private readonly mixed $resolveField,
    ) {
    }

    public function parse(): mixed
    {
        if ($this->tokens === []) {
            return null;
        }
        $value = $this->comparison();
        if ($this->pos < count($this->tokens)) {
            throw new \RuntimeException('Trailing tokens');
        }

        return self::finish($value);
    }

    private function comparison(): mixed
    {
        $left = $this->additive();
        $op = $this->peekOp(['=', '!=', '>', '<', '>=', '<=']);
        if ($op === null) {
            return $left;
        }
        $this->pos++;
        $right = $this->additive();

        // Numeric comparison when both sides read as numbers, string comparison otherwise —
        // so {Total} > 100 and {Status} = "Paid" both mean what they look like.
        if (self::isNumericish($left) && self::isNumericish($right)) {
            $l = self::toNum($left);
            $r = self::toNum($right);
        } else {
            $l = self::toStr($left);
            $r = self::toStr($right);
        }

        return match ($op) {
            '=' => $l == $r,
            '!=' => $l != $r,
            '>' => $l > $r,
            '<' => $l < $r,
            '>=' => $l >= $r,
            '<=' => $l <= $r,
        };
    }

    private function additive(): mixed
    {
        $value = $this->multiplicative();
        while (($op = $this->peekOp(['+', '-', '&'])) !== null) {
            $this->pos++;
            $right = $this->multiplicative();
            $value = match ($op) {
                '+' => self::toNum($value) + self::toNum($right),
                '-' => self::toNum($value) - self::toNum($right),
                '&' => self::toStr($value).self::toStr($right),
            };
        }

        return $value;
    }

    private function multiplicative(): mixed
    {
        $value = $this->unary();
        while (($op = $this->peekOp(['*', '/'])) !== null) {
            $this->pos++;
            $right = $this->unary();
            if ($op === '*') {
                $value = self::toNum($value) * self::toNum($right);
            } else {
                $divisor = self::toNum($right);
                $value = $divisor == 0.0 ? null : self::toNum($value) / $divisor;
            }
        }

        return $value;
    }

    private function unary(): mixed
    {
        if ($this->peekOp(['-']) !== null) {
            $this->pos++;

            return -self::toNum($this->unary());
        }

        return $this->primary();
    }

    private function primary(): mixed
    {
        $token = $this->tokens[$this->pos] ?? throw new \RuntimeException('Unexpected end of formula');

        if ($token['t'] === 'num' || $token['t'] === 'str') {
            $this->pos++;

            return $token['v'];
        }

        if ($token['t'] === 'field') {
            $this->pos++;

            return ($this->resolveField)((string) $token['v']);
        }

        if ($token['t'] === 'ident') {
            $this->pos++;
            $this->expect('(');
            $args = [];
            if ($this->peekOp([')']) === null) {
                $args[] = $this->comparison();
                while ($this->peekOp([',']) !== null) {
                    $this->pos++;
                    $args[] = $this->comparison();
                }
            }
            $this->expect(')');

            return $this->call(strtoupper((string) $token['v']), $args);
        }

        if ($token['t'] === 'op' && $token['v'] === '(') {
            $this->pos++;
            $value = $this->comparison();
            $this->expect(')');

            return $value;
        }

        throw new \RuntimeException('Unexpected token');
    }

    private function call(string $name, array $args): mixed
    {
        return match ($name) {
            'IF' => self::truthy($args[0] ?? null) ? ($args[1] ?? null) : ($args[2] ?? null),
            'AND' => array_reduce($args, fn ($carry, $a) => $carry && self::truthy($a), true),
            'OR' => array_reduce($args, fn ($carry, $a) => $carry || self::truthy($a), false),
            'NOT' => ! self::truthy($args[0] ?? null),
            'BLANK' => null,
            'ISBLANK' => ($args[0] ?? null) === null || ($args[0] ?? null) === '',
            'CONCAT', 'CONCATENATE' => implode('', array_map(self::toStr(...), $args)),
            'UPPER' => mb_strtoupper(self::toStr($args[0] ?? '')),
            'LOWER' => mb_strtolower(self::toStr($args[0] ?? '')),
            'TRIM' => trim(self::toStr($args[0] ?? '')),
            'LEN' => mb_strlen(self::toStr($args[0] ?? '')),
            'LEFT' => mb_substr(self::toStr($args[0] ?? ''), 0, (int) self::toNum($args[1] ?? 0)),
            'RIGHT' => mb_substr(self::toStr($args[0] ?? ''), -max(1, (int) self::toNum($args[1] ?? 1))),
            'MID' => mb_substr(self::toStr($args[0] ?? ''), max(0, (int) self::toNum($args[1] ?? 1) - 1), (int) self::toNum($args[2] ?? 0)),
            'SUBSTITUTE' => str_replace(self::toStr($args[1] ?? ''), self::toStr($args[2] ?? ''), self::toStr($args[0] ?? '')),
            'ROUND' => round(self::toNum($args[0] ?? 0), (int) self::toNum($args[1] ?? 0)),
            'CEILING' => ceil(self::toNum($args[0] ?? 0)),
            'FLOOR' => floor(self::toNum($args[0] ?? 0)),
            'INT' => (float) floor(self::toNum($args[0] ?? 0)),
            'ABS' => abs(self::toNum($args[0] ?? 0)),
            'MOD' => self::toNum($args[1] ?? 0) == 0.0 ? null : fmod(self::toNum($args[0] ?? 0), self::toNum($args[1] ?? 0)),
            'POWER' => pow(self::toNum($args[0] ?? 0), self::toNum($args[1] ?? 0)),
            'SQRT' => self::toNum($args[0] ?? 0) < 0 ? null : sqrt(self::toNum($args[0] ?? 0)),
            'MIN' => $args === [] ? null : min(array_map(self::toNum(...), $args)),
            'MAX' => $args === [] ? null : max(array_map(self::toNum(...), $args)),
            'SUM' => array_sum(array_map(self::toNum(...), $args)),
            'AVERAGE' => $args === [] ? null : array_sum(array_map(self::toNum(...), $args)) / count($args),
            'TODAY' => date('Y-m-d'),
            'NOW' => date('Y-m-d H:i'),
            'YEAR' => self::datePart($args[0] ?? null, 'Y'),
            'MONTH' => self::datePart($args[0] ?? null, 'n'),
            'DAY' => self::datePart($args[0] ?? null, 'j'),
            'WEEKDAY' => self::datePart($args[0] ?? null, 'w'),
            'DAYS_DIFF', 'DATETIME_DIFF' => self::daysDiff($args[0] ?? null, $args[1] ?? null),
            default => throw new \RuntimeException("Unknown function {$name}"),
        };
    }

    // ── Coercion ─────────────────────────────────────────────────────────────

    private static function truthy(mixed $value): bool
    {
        if ($value === null || $value === false || $value === '' || $value === 0 || $value === 0.0) {
            return false;
        }
        if (is_array($value)) {
            return $value !== [];
        }

        return true;
    }

    private static function isNumericish(mixed $value): bool
    {
        return is_int($value) || is_float($value) || is_bool($value) || $value === null
            || (is_string($value) && is_numeric(trim($value)));
    }

    private static function toNum(mixed $value): float
    {
        if (is_int($value) || is_float($value)) {
            return (float) $value;
        }
        if (is_bool($value)) {
            return $value ? 1.0 : 0.0;
        }
        if (is_string($value) && is_numeric(trim($value))) {
            return (float) trim($value);
        }

        return 0.0;
    }

    private static function toStr(mixed $value): string
    {
        if ($value === null) {
            return '';
        }
        if (is_bool($value)) {
            return $value ? 'true' : 'false';
        }
        if (is_float($value)) {
            // 12.0 prints as "12": formulas concatenating numbers should not grow ".0" tails.
            return $value == floor($value) && abs($value) < 1e15
                ? (string) (int) $value
                : rtrim(rtrim(number_format($value, 6, '.', ''), '0'), '.');
        }
        if (is_array($value)) {
            return implode(', ', array_map(
                fn ($item) => is_scalar($item) ? (string) $item : (is_array($item) ? (string) ($item['label'] ?? $item['filename'] ?? '') : ''),
                $value,
            ));
        }
        if (is_object($value)) {
            return '';
        }

        return (string) $value;
    }

    private static function datePart(mixed $value, string $format): ?int
    {
        $time = is_string($value) && $value !== '' ? strtotime($value) : false;

        return $time === false ? null : (int) date($format, $time);
    }

    private static function daysDiff(mixed $a, mixed $b): ?float
    {
        $ta = is_string($a) && $a !== '' ? strtotime($a) : false;
        $tb = is_string($b) && $b !== '' ? strtotime($b) : false;
        if ($ta === false || $tb === false) {
            return null;
        }

        return floor(($ta - $tb) / 86400);
    }

    /** Round float artefacts and shed the .0 on whole numbers so JSON stays clean. */
    private static function finish(mixed $value): mixed
    {
        if (is_float($value)) {
            $rounded = round($value, 8);

            return $rounded == floor($rounded) && abs($rounded) < 1e15 ? (int) $rounded : $rounded;
        }

        return $value;
    }

    private function peekOp(array $ops): ?string
    {
        $token = $this->tokens[$this->pos] ?? null;
        if ($token !== null && $token['t'] === 'op' && in_array($token['v'], $ops, true)) {
            return (string) $token['v'];
        }

        return null;
    }

    private function expect(string $op): void
    {
        if ($this->peekOp([$op]) === null) {
            throw new \RuntimeException("Expected '{$op}'");
        }
        $this->pos++;
    }
}

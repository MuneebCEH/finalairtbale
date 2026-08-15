<?php

namespace App\Support;

use App\Exceptions\ApiException;
use Illuminate\Database\Eloquent\Builder;

/**
 * Translates a filter/sort/group query (listRecordsSchema) into SQL over the records' `data` JSON.
 *
 * Safety: field ids are validated against the table's real fields before they are ever placed in a
 * JSON path, and every user value is a bound parameter — so neither can inject SQL. Operators come
 * from a fixed table. This is the MySQL/MariaDB equivalent of the NestJS query engine; sorting is
 * lexical over the JSON text for now (numeric/typed sort via promoted slots is the next step).
 */
class RecordQueryEngine
{
    /** @param array<string,string> $fieldTypes  validated fieldId => type */
    public function __construct(private readonly array $fieldTypes)
    {
    }

    public function apply(Builder $query, array $input): Builder
    {
        if (! empty($input['filter'])) {
            [$sql, $bindings] = $this->group($input['filter']);
            if ($sql !== '') {
                $query->whereRaw($sql, $bindings);
            }
        }

        if (! empty($input['search'])) {
            $query->whereRaw('LOWER(CAST(data AS CHAR)) LIKE ?', ['%'.mb_strtolower($input['search']).'%']);
        }

        // group keys act as the leading sort keys.
        foreach (array_merge($input['group'] ?? [], $input['sort'] ?? []) as $s) {
            // A half-built toolbar entry ("+ Add" clicked, no field picked yet) arrives with an
            // empty fieldId. Ordering by nothing means "skip it" — it must not be a 500.
            if (empty($s['fieldId']) || ! is_string($s['fieldId'])) {
                continue;
            }
            $this->assertField($s['fieldId']);
            $query->orderByRaw($this->jsonText($s['fieldId']).' '.(($s['direction'] ?? 'asc') === 'desc' ? 'desc' : 'asc'));
        }
        $query->orderBy('id'); // stable tiebreak

        return $query;
    }

    /** @return array{0:string,1:array} */
    private function group(array $group): array
    {
        $conjunction = ($group['conjunction'] ?? 'and') === 'or' ? ' OR ' : ' AND ';
        $parts = [];
        $bindings = [];

        foreach (($group['conditions'] ?? []) as $node) {
            if (isset($node['conjunction'])) {
                [$sql, $b] = $this->group($node);
            } else {
                [$sql, $b] = $this->condition($node);
            }
            if ($sql !== '') {
                $parts[] = $sql;
                $bindings = array_merge($bindings, $b);
            }
        }

        if (empty($parts)) {
            return ['', []];
        }

        return ['('.implode($conjunction, $parts).')', $bindings];
    }

    /** @return array{0:string,1:array} */
    private function condition(array $c): array
    {
        $fieldId = $c['fieldId'] ?? '';
        // A condition whose field was never picked filters nothing rather than erroring.
        if ($fieldId === '' || $fieldId === null) {
            return ['', []];
        }
        $this->assertField($fieldId);
        $op = $c['operator'] ?? 'is';
        $value = $c['value'] ?? null;

        $text = $this->jsonText($fieldId);           // JSON_UNQUOTE(JSON_EXTRACT(data,'$."f"'))
        $num = "CAST({$text} AS DECIMAL(38,10))";
        $dt = "CAST({$text} AS DATETIME)";
        $raw = $this->jsonRaw($fieldId);             // JSON_EXTRACT(data,'$."f"') for array ops

        switch ($op) {
            case 'is': return ["{$text} <=> ?", [$this->scalar($value)]];
            case 'isNot': return ["NOT ({$text} <=> ?)", [$this->scalar($value)]];
            case 'contains': return ["{$text} LIKE ?", ['%'.$this->like($value).'%']];
            case 'doesNotContain': return ["({$text} NOT LIKE ? OR {$text} IS NULL)", ['%'.$this->like($value).'%']];
            case 'startsWith': return ["{$text} LIKE ?", [$this->like($value).'%']];
            case 'endsWith': return ["{$text} LIKE ?", ['%'.$this->like($value)]];
            case 'isEmpty': return ["({$text} IS NULL OR {$text} = '')", []];
            case 'isNotEmpty': return ["({$text} IS NOT NULL AND {$text} != '')", []];
            case 'gt': return ["{$num} > ?", [$this->scalar($value)]];
            case 'gte': return ["{$num} >= ?", [$this->scalar($value)]];
            case 'lt': return ["{$num} < ?", [$this->scalar($value)]];
            case 'lte': return ["{$num} <= ?", [$this->scalar($value)]];
            case 'isBefore': return ["{$dt} < ?", [$this->scalar($value)]];
            case 'isAfter': return ["{$dt} > ?", [$this->scalar($value)]];
            case 'isAnyOf': return $this->inList($text, $value, false);
            case 'isNoneOf': return $this->inList($text, $value, true);
            case 'hasAnyOf': return $this->jsonContains($raw, $value, false);
            case 'hasAllOf': return $this->jsonContains($raw, $value, true);
            default:
                throw new ApiException('MALFORMED_REQUEST', "Unsupported filter operator: {$op}.");
        }
    }

    private function inList(string $expr, mixed $value, bool $negate): array
    {
        $values = array_values(array_filter((array) $value, fn ($v) => $v !== null));
        if (empty($values)) {
            return ['', []];
        }
        $ph = implode(',', array_fill(0, count($values), '?'));

        return $negate
            ? ["({$expr} NOT IN ({$ph}) OR {$expr} IS NULL)", array_map([$this, 'scalar'], $values)]
            : ["{$expr} IN ({$ph})", array_map([$this, 'scalar'], $values)];
    }

    private function jsonContains(string $rawExpr, mixed $value, bool $all): array
    {
        $values = array_values((array) $value);
        if (empty($values)) {
            return ['', []];
        }
        $parts = [];
        $bindings = [];
        foreach ($values as $v) {
            $parts[] = "JSON_CONTAINS({$rawExpr}, ?)";
            $bindings[] = json_encode($v);
        }

        return ['('.implode($all ? ' AND ' : ' OR ', $parts).')', $bindings];
    }

    private function jsonText(string $fieldId): string
    {
        return "JSON_UNQUOTE(JSON_EXTRACT(data, '\$.\"{$fieldId}\"'))";
    }

    private function jsonRaw(string $fieldId): string
    {
        return "JSON_EXTRACT(data, '\$.\"{$fieldId}\"')";
    }

    private function scalar(mixed $value): string|int|float|null
    {
        if (is_bool($value)) {
            return $value ? 'true' : 'false';
        }

        return is_scalar($value) || $value === null ? $value : json_encode($value);
    }

    private function like(mixed $value): string
    {
        return addcslashes((string) $this->scalar($value), '%_\\');
    }

    private function assertField(string $fieldId): void
    {
        if (! array_key_exists($fieldId, $this->fieldTypes)) {
            throw ApiException::validation([
                ['path' => 'filter', 'code' => 'unknown_field', 'message' => "unknown field id: {$fieldId}"],
            ]);
        }
    }
}

<?php

namespace App\Support;

use App\Models\Field;
use App\Models\Record;
use App\Models\Table;

/**
 * Linked-record expansion.
 *
 * On disk a linked-record cell is stored as a plain array of record ids. On the way out it is
 * expanded to `[{id, label}]` — the label being the linked record's primary-field value — so the
 * grid can render titles without a second round trip. On the way in, whatever shape the client
 * sent (ids or {id,label} objects) is normalised back to bare ids.
 */
final class RecordLinks
{
    private const LINK_TYPES = ['linkedRecord', 'parentRecord'];

    /** @return array<string,string>  fieldId => linkedTableId, for this table's link fields */
    public static function linkFields(string $tableId): array
    {
        return Field::where('table_id', $tableId)->whereNull('deleted_at')
            ->whereIn('type', self::LINK_TYPES)
            ->get()
            ->mapWithKeys(fn (Field $f) => [$f->id => ($f->options['linkedTableId'] ?? null)])
            ->filter()
            ->all();
    }

    /**
     * Resolves every linked id referenced across the given records to its title.
     *
     * @param array<string,string> $linkFields  fieldId => linkedTableId
     * @return array<string,string>             linkedRecordId => title
     */
    public static function labelMap(array $linkFields, iterable $records): array
    {
        if (empty($linkFields)) {
            return [];
        }

        $ids = [];
        foreach ($records as $record) {
            $data = (array) ($record->data ?? []);
            foreach ($linkFields as $fieldId => $_tableId) {
                foreach (self::asIds($data[$fieldId] ?? null) as $id) {
                    $ids[$id] = true;
                }
            }
        }
        if (empty($ids)) {
            return [];
        }

        // Each linked table's primary field, so we know which data key holds the title.
        $primaryByTable = Table::whereIn('id', array_values(array_unique($linkFields)))
            ->pluck('primary_field_id', 'id')->all();

        $labels = [];
        foreach (Record::whereIn('id', array_keys($ids))->whereNull('deleted_at')->get(['id', 'table_id', 'data']) as $row) {
            $pf = $primaryByTable[$row->table_id] ?? null;
            $title = $pf ? ((array) $row->data)[$pf] ?? null : null;
            $labels[$row->id] = is_string($title) && $title !== '' ? $title : 'Untitled';
        }

        return $labels;
    }

    /**
     * Expands the link fields of one record's data to `[{id, label}]`.
     *
     * @param array<string,string> $linkFields
     * @param array<string,string> $labels
     */
    public static function expand(array $data, array $linkFields, array $labels): array
    {
        foreach ($linkFields as $fieldId => $_tableId) {
            if (! array_key_exists($fieldId, $data)) {
                continue;
            }
            $data[$fieldId] = array_map(
                fn (string $id) => ['id' => $id, 'label' => $labels[$id] ?? 'Untitled'],
                self::asIds($data[$fieldId]),
            );
        }

        return $data;
    }

    /** Normalises an incoming link value (ids or {id,...} objects) to a de-duplicated id array. */
    public static function normalize(mixed $value): array
    {
        return array_values(array_unique(self::asIds($value)));
    }

    /** Pulls bare ids out of a string, an id array, or an array of {id} objects. */
    private static function asIds(mixed $value): array
    {
        if (is_string($value) && $value !== '') {
            return [$value];
        }
        if (! is_array($value)) {
            return [];
        }

        $ids = [];
        foreach ($value as $item) {
            $id = is_array($item) ? ($item['id'] ?? null) : $item;
            if (is_string($id) && $id !== '') {
                $ids[] = $id;
            }
        }

        return $ids;
    }
}

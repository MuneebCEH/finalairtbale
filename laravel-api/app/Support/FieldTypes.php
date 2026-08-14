<?php

namespace App\Support;

/** The field-type vocabulary, mirrored from packages/types/src/fields.ts (FIELD_TYPES). */
final class FieldTypes
{
    public const ALL = [
        'singleLineText', 'longText', 'richText',
        'number', 'decimal', 'currency', 'percent', 'rating', 'progress', 'duration',
        'checkbox',
        'singleSelect', 'multipleSelect', 'status',
        'date', 'dateTime',
        'email', 'phone', 'url', 'address', 'geolocation', 'barcode', 'json',
        'user', 'multipleUsers',
        'attachment',
        'linkedRecord', 'parentRecord', 'childRecords', 'dependency',
        'lookup', 'rollup', 'count', 'formula',
        'autoNumber', 'recordId', 'createdTime', 'lastModifiedTime', 'createdBy', 'lastModifiedBy',
        'button',
    ];

    /** Types whose value is derived, never written directly through the records API. */
    public const COMPUTED = [
        'lookup', 'rollup', 'count', 'formula',
        'autoNumber', 'recordId', 'createdTime', 'lastModifiedTime', 'createdBy', 'lastModifiedBy', 'button',
    ];
}

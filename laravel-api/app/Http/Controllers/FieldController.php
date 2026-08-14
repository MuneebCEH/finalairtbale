<?php

namespace App\Http\Controllers;

use App\Exceptions\ApiException;
use App\Models\Field;
use App\Support\FieldTypes;
use App\Support\Permissions;
use App\Support\TenantContext;
use Illuminate\Http\Request;
use Illuminate\Validation\Rule;

class FieldController extends Controller
{
    public function list(Request $request, string $tableId)
    {
        $this->tenant($request, 'field:read');

        $fields = Field::where('table_id', $tableId)->whereNull('deleted_at')
            ->orderBy('position')->orderBy('created_at')->get()
            ->map(fn (Field $f) => $this->dto($f))->all();

        return response()->json(['data' => $fields]);
    }

    public function create(Request $request, string $tableId)
    {
        $tenant = $this->tenant($request, 'field:create');
        $this->strict($request, ['name', 'type', 'description', 'options', 'isRequired', 'isUnique', 'position']);
        $data = $request->validate([
            'name' => ['required', 'string', 'min:1', 'max:120'],
            'type' => ['required', Rule::in(FieldTypes::ALL)],
            'description' => ['sometimes', 'nullable', 'string', 'max:2000'],
            'options' => ['sometimes', 'array'],
            'isRequired' => ['sometimes', 'boolean'],
            'isUnique' => ['sometimes', 'boolean'],
            'position' => ['sometimes', 'integer', 'min:0'],
        ]);

        if (Field::where('table_id', $tableId)->where('name', $data['name'])->exists()) {
            throw new ApiException('DUPLICATE_RESOURCE', 'A field with that name already exists in this table.');
        }

        $position = $data['position'] ?? (Field::where('table_id', $tableId)->max('position') + 1);

        $field = Field::create([
            'organization_id' => $tenant->organizationId,
            'table_id' => $tableId,
            'name' => $data['name'],
            'type' => $data['type'],
            'description' => $data['description'] ?? null,
            'options' => $data['options'] ?? [],
            'is_required' => $data['isRequired'] ?? false,
            'is_unique' => $data['isUnique'] ?? false,
            'position' => $position,
            'created_by_id' => $tenant->userId(),
        ]);

        return response()->json(['data' => $this->dto($field)], 201);
    }

    public function update(Request $request, string $tableId, string $fieldId)
    {
        $this->tenant($request, 'field:update');
        $this->strict($request, ['name', 'description', 'options', 'isRequired', 'position']);
        $data = $request->validate([
            'name' => ['sometimes', 'string', 'min:1', 'max:120'],
            'description' => ['sometimes', 'nullable', 'string', 'max:2000'],
            'options' => ['sometimes', 'array'],
            'isRequired' => ['sometimes', 'boolean'],
            'position' => ['sometimes', 'integer', 'min:0'],
        ]);

        $field = Field::where('table_id', $tableId)->whereKey($fieldId)->whereNull('deleted_at')->first()
            ?? throw ApiException::notFound('Field not found.');

        $map = ['name' => 'name', 'description' => 'description', 'options' => 'options',
                'isRequired' => 'is_required', 'position' => 'position'];
        foreach ($map as $in => $col) {
            if (array_key_exists($in, $data)) {
                $field->{$col} = $data[$in];
            }
        }
        $field->save();

        return response()->json(['data' => $this->dto($field)]);
    }

    public function delete(Request $request, string $tableId, string $fieldId)
    {
        $this->tenant($request, 'field:delete');

        $field = Field::where('table_id', $tableId)->whereKey($fieldId)->whereNull('deleted_at')->first()
            ?? throw ApiException::notFound('Field not found.');

        if ($field->is_primary) {
            throw new ApiException('MALFORMED_REQUEST', 'The primary field cannot be deleted.');
        }
        $field->delete();

        return response()->noContent();
    }

    private function tenant(Request $request, string $action): TenantContext
    {
        /** @var TenantContext $tenant */
        $tenant = $request->attributes->get('tenant');
        Permissions::authorize($tenant, $action);

        return $tenant;
    }

    private function dto(Field $f): array
    {
        return [
            'id' => $f->id,
            'tableId' => $f->table_id,
            'name' => $f->name,
            'type' => $f->type,
            'description' => $f->description,
            'position' => (int) $f->position,
            'isPrimary' => (bool) $f->is_primary,
            'isRequired' => (bool) $f->is_required,
            'isUnique' => (bool) $f->is_unique,
            'options' => $f->options ?? (object) [],
            'createdAt' => $f->created_at?->copy()->utc()->format('Y-m-d\TH:i:s.v\Z'),
        ];
    }

    private function strict(Request $request, array $allowed): void
    {
        $unknown = array_diff(array_keys($request->all()), $allowed);
        if (! empty($unknown)) {
            throw ApiException::validation(array_map(
                fn ($key) => ['path' => $key, 'code' => 'unrecognized_keys', 'message' => 'unexpected property'],
                array_values($unknown),
            ));
        }
    }
}

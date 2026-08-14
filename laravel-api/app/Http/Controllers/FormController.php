<?php

namespace App\Http\Controllers;

use App\Exceptions\ApiException;
use App\Models\Field;
use App\Models\Form;
use App\Models\Table;
use App\Support\FieldTypes;
use App\Support\Permissions;
use App\Support\TenantContext;
use Illuminate\Http\Request;
use Illuminate\Support\Str;

/**
 * Form management (authenticated). A form belongs to a table; its `config` is the ordered field
 * list plus the submit text and confirmation message. The public page and submission handler live
 * in PublicFormController.
 */
class FormController extends Controller
{
    public function index(Request $request, string $tableId)
    {
        $this->tenant($request, 'table:read');

        $forms = Form::where('table_id', $tableId)->whereNull('deleted_at')
            ->orderBy('created_at')->get()
            ->map(fn (Form $f) => $this->summary($f))->all();

        return response()->json(['data' => $forms]);
    }

    public function store(Request $request, string $tableId)
    {
        $tenant = $this->tenant($request, 'table:update');

        /** @var Table $table */
        $table = Table::whereKey($tableId)->whereNull('deleted_at')->first()
            ?? throw ApiException::notFound('Table not found.');

        $fields = Field::where('table_id', $tableId)->whereNull('deleted_at')
            ->whereNotIn('type', FieldTypes::COMPUTED)
            ->orderBy('position')->get();

        $config = [
            'fields' => $fields->map(fn (Field $f) => [
                'fieldId' => $f->id,
                'label' => null,
                'required' => (bool) $f->is_required,
                'hidden' => false,
            ])->all(),
            'submitText' => 'Submit',
            'confirmationMessage' => 'Thanks for your response!',
        ];

        $form = Form::create([
            'organization_id' => $tenant->organizationId,
            'base_id' => $table->base_id,
            'table_id' => $tableId,
            'title' => $table->name.' form',
            'slug' => strtolower(Str::random(16)),
            'config' => $config,
            'is_published' => false,
            'created_by' => $tenant->userId(),
        ]);

        return response()->json(['data' => $this->full($form)], 201);
    }

    public function show(Request $request, string $formId)
    {
        $this->tenant($request, 'table:read');

        return response()->json(['data' => $this->full($this->form($request))]);
    }

    public function update(Request $request, string $formId)
    {
        $this->tenant($request, 'table:update');
        $data = $request->validate([
            'title' => ['sometimes', 'string', 'min:1', 'max:200'],
            'description' => ['sometimes', 'nullable', 'string', 'max:2000'],
            'isPublished' => ['sometimes', 'boolean'],
            'config' => ['sometimes', 'array'],
        ]);

        $form = $this->form($request);
        if (array_key_exists('title', $data)) $form->title = $data['title'];
        if (array_key_exists('description', $data)) $form->description = $data['description'];
        if (array_key_exists('isPublished', $data)) $form->is_published = $data['isPublished'];
        if (array_key_exists('config', $data)) $form->config = array_merge((array) $form->config, $data['config']);
        $form->save();

        return response()->json(['data' => $this->full($form)]);
    }

    public function destroy(Request $request, string $formId)
    {
        $this->tenant($request, 'table:update');
        $this->form($request)->delete();

        return response()->noContent();
    }

    // ── Helpers ──────────────────────────────────────────────────────────────

    private function tenant(Request $request, string $action): TenantContext
    {
        /** @var TenantContext $tenant */
        $tenant = $request->attributes->get('tenant');
        Permissions::authorize($tenant, $action);

        return $tenant;
    }

    private function form(Request $request): Form
    {
        return $request->attributes->get('resolved_form') ?? throw ApiException::notFound('Form not found.');
    }

    /** The shape the base's Forms list expects (FormSummary). */
    private function summary(Form $f): array
    {
        return [
            'id' => $f->id,
            'title' => $f->title,
            'slug' => $f->slug,
            'isPublished' => (bool) $f->is_published,
            'submissionCount' => (int) $f->submission_count,
        ];
    }

    private function full(Form $f): array
    {
        // The builder needs field names/types to label the toggles; ship them alongside the config.
        $fields = Field::where('table_id', $f->table_id)->whereNull('deleted_at')
            ->whereNotIn('type', FieldTypes::COMPUTED)
            ->orderBy('position')->get(['id', 'name', 'type'])
            ->map(fn (Field $x) => ['id' => $x->id, 'name' => $x->name, 'type' => $x->type])->all();

        return array_merge($this->summary($f), [
            'tableId' => $f->table_id,
            'baseId' => $f->base_id,
            'description' => $f->description,
            'config' => $f->config,
            'fields' => $fields,
        ]);
    }
}

<?php

namespace App\Http\Controllers;

use App\Exceptions\ApiException;
use App\Models\Automation;
use App\Models\Record;
use App\Models\Table;
use App\Support\AutomationRunner;
use App\Support\Permissions;
use App\Support\TenantContext;
use Illuminate\Http\Request;

/**
 * Airtable-style automations: "when something happens on this table, run these steps".
 * The builder UI edits them here; {@see AutomationRunner} executes them when records change.
 */
class AutomationController extends Controller
{
    private const TRIGGERS = ['record_created', 'record_updated', 'record_matches'];
    private const ACTION_TYPES = ['update_record', 'create_record', 'webhook', 'send_email'];

    /** GET /v1/bases/{baseId}/automations */
    public function list(Request $request, string $baseId)
    {
        $this->authorizeAction($request, 'base:read');
        $base = $request->attributes->get('resolved_base') ?? abort(404);

        $automations = Automation::where('base_id', $base->id)->whereNull('deleted_at')
            ->orderBy('created_at')->get()->map(fn (Automation $a) => $this->dto($a))->all();

        return response()->json(['data' => $automations]);
    }

    /** POST /v1/bases/{baseId}/automations */
    public function create(Request $request, string $baseId)
    {
        $tenant = $this->authorizeAction($request, 'table:update');
        $base = $request->attributes->get('resolved_base') ?? abort(404);
        $data = $this->validated($request);

        $table = Table::whereKey($data['tableId'])->whereNull('deleted_at')
            ->where('base_id', $base->id)->first();
        if (! $table) {
            throw ApiException::notFound('That table is not in this base.');
        }

        $automation = Automation::create([
            'organization_id' => $tenant->organizationId,
            'base_id' => $base->id,
            'table_id' => $table->id,
            'name' => $data['name'],
            'enabled' => $data['enabled'] ?? false,
            'trigger_type' => $data['triggerType'] ?? 'record_created',
            'trigger_config' => $data['triggerConfig'] ?? null,
            'actions' => $data['actions'] ?? [],
            'created_by' => $tenant->userId(),
        ]);

        return response()->json(['data' => $this->dto($automation)], 201);
    }

    /** PATCH /v1/automations/{automationId} */
    public function update(Request $request, string $automationId)
    {
        $this->authorizeAction($request, 'table:update');
        /** @var Automation $automation */
        $automation = $request->attributes->get('resolved_automation') ?? abort(404);
        $data = $this->validated($request, updating: true);

        if (isset($data['tableId'])) {
            $table = Table::whereKey($data['tableId'])->whereNull('deleted_at')
                ->where('base_id', $automation->base_id)->first();
            if (! $table) {
                throw ApiException::notFound('That table is not in this base.');
            }
            $automation->table_id = $table->id;
        }

        foreach (['name' => 'name', 'enabled' => 'enabled'] as $in => $col) {
            if (array_key_exists($in, $data)) {
                $automation->{$col} = $data[$in];
            }
        }
        if (array_key_exists('triggerType', $data)) {
            $automation->trigger_type = $data['triggerType'];
        }
        if (array_key_exists('triggerConfig', $data)) {
            $automation->trigger_config = $data['triggerConfig'];
        }
        if (array_key_exists('actions', $data)) {
            $automation->actions = $data['actions'];
        }
        $automation->save();

        return response()->json(['data' => $this->dto($automation)]);
    }

    /** DELETE /v1/automations/{automationId} */
    public function delete(Request $request, string $automationId)
    {
        $this->authorizeAction($request, 'table:update');
        ($request->attributes->get('resolved_automation') ?? abort(404))->delete();

        return response()->noContent();
    }

    /**
     * POST /v1/automations/{automationId}/test — run the steps once against the table's newest
     * record, ignoring the trigger, so the builder can be tried without waiting for a real event.
     */
    public function test(Request $request, string $automationId)
    {
        $this->authorizeAction($request, 'table:update');
        /** @var Automation $automation */
        $automation = $request->attributes->get('resolved_automation') ?? abort(404);

        $record = Record::where('table_id', $automation->table_id)->whereNull('deleted_at')
            ->orderByDesc('auto_number')->first();
        if (! $record) {
            throw new ApiException('MALFORMED_REQUEST', 'The table has no records to test against — add one first.');
        }

        AutomationRunner::run($automation, $record);

        return response()->json(['data' => [
            'ranAgainst' => $record->id,
            'automation' => $this->dto($automation->fresh()),
        ]]);
    }

    // ── Helpers ──────────────────────────────────────────────────────────────

    private function validated(Request $request, bool $updating = false): array
    {
        $required = $updating ? 'sometimes' : 'required';

        return $request->validate([
            'name' => [$required, 'string', 'min:1', 'max:120'],
            'tableId' => [$required, 'string'],
            'enabled' => ['sometimes', 'boolean'],
            'triggerType' => ['sometimes', 'string', 'in:'.implode(',', self::TRIGGERS)],
            'triggerConfig' => ['sometimes', 'nullable', 'array'],
            'actions' => ['sometimes', 'array', 'max:5'],
            'actions.*.type' => ['required_with:actions', 'string', 'in:'.implode(',', self::ACTION_TYPES)],
            'actions.*.config' => ['sometimes', 'array'],
        ]);
    }

    private function authorizeAction(Request $request, string $action): TenantContext
    {
        /** @var TenantContext $tenant */
        $tenant = $request->attributes->get('tenant');
        Permissions::authorize($tenant, $action);

        return $tenant;
    }

    private function dto(Automation $a): array
    {
        return [
            'id' => $a->id,
            'baseId' => $a->base_id,
            'tableId' => $a->table_id,
            'name' => $a->name,
            'enabled' => (bool) $a->enabled,
            'triggerType' => $a->trigger_type,
            'triggerConfig' => $a->trigger_config,
            'actions' => $a->actions,
            'runCount' => (int) $a->run_count,
            'lastRunAt' => $a->last_run_at?->toIso8601String(),
            'createdAt' => $a->created_at?->toIso8601String(),
            'updatedAt' => $a->updated_at?->toIso8601String(),
        ];
    }
}

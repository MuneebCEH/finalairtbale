<?php

namespace App\Http\Controllers;

use App\Exceptions\ApiException;
use App\Models\Field;
use App\Models\Record;
use App\Models\RecordRevision;
use App\Models\Table;
use App\Support\Permissions;
use App\Support\TenantContext;
use Illuminate\Http\Request;
use Illuminate\Support\Carbon;
use Illuminate\Support\Facades\DB;

/**
 * The trash — everything here was soft-deleted, so "restore" is honest: the data never left,
 * only its visibility did. Record trash is per-table; table trash is per-base.
 */
class TrashController extends Controller
{
    /** GET /v1/tables/{tableId}/trash — recently deleted records, newest first. */
    public function records(Request $request, string $tableId)
    {
        $this->authorizeAction($request, 'record:read');
        $table = $request->attributes->get('resolved_table') ?? $this->deletedTable($request, $tableId) ?? abort(404);

        $primary = $table->primary_field_id;
        $rows = Record::where('table_id', $table->id)->whereNotNull('deleted_at')
            ->orderByDesc('deleted_at')->limit(100)->get()
            ->map(fn (Record $r) => [
                'id' => $r->id,
                'autoNumber' => (int) $r->auto_number,
                'label' => $this->label($r, $primary),
                'deletedAt' => $r->deleted_at ? Carbon::parse($r->deleted_at)->toIso8601String() : null,
            ])->all();

        return response()->json(['data' => $rows]);
    }

    /** POST /v1/tables/{tableId}/records/restore — bring deleted records back. */
    public function restoreRecords(Request $request, string $tableId)
    {
        $tenant = $this->authorizeAction($request, 'record:create');
        $table = $request->attributes->get('resolved_table') ?? abort(404);
        $request->validate([
            'recordIds' => ['required', 'array', 'min:1', 'max:100'],
            'recordIds.*' => ['string'],
        ]);

        $ids = $request->input('recordIds');
        $restored = Record::where('table_id', $table->id)->whereIn('id', $ids)
            ->whereNotNull('deleted_at')->update(['deleted_at' => null]);

        if ($restored > 0) {
            Table::whereKey($table->id)->update([
                'record_count' => DB::raw("record_count + {$restored}"),
            ]);
            $now = Carbon::now();
            foreach ($ids as $recordId) {
                RecordRevision::create([
                    'organization_id' => $tenant->organizationId,
                    'table_id' => $table->id,
                    'record_id' => $recordId,
                    'user_id' => $tenant->userId(),
                    'kind' => 'restored',
                    'changes' => null,
                    'created_at' => $now,
                ]);
            }
        }

        return response()->json(['data' => ['restored' => $restored]]);
    }

    /** GET /v1/bases/{baseId}/trash — deleted tables of this base. */
    public function tables(Request $request, string $baseId)
    {
        $this->authorizeAction($request, 'table:read');
        $base = $request->attributes->get('resolved_base') ?? abort(404);

        // withTrashed: the model's soft-delete scope hides exactly the rows this list exists for.
        $tables = Table::withTrashed()->where('base_id', $base->id)->whereNotNull('deleted_at')
            ->orderByDesc('deleted_at')->limit(50)->get()
            ->map(fn (Table $t) => [
                'id' => $t->id,
                'name' => $t->name,
                'recordCount' => (int) $t->record_count,
                'deletedAt' => $t->deleted_at?->toIso8601String(),
            ])->all();

        return response()->json(['data' => $tables]);
    }

    /** POST /v1/bases/{baseId}/trash/tables/{trashedTableId}/restore */
    public function restoreTable(Request $request, string $baseId, string $trashedTableId)
    {
        $this->authorizeAction($request, 'table:create');
        $base = $request->attributes->get('resolved_base') ?? abort(404);

        $table = Table::withTrashed()->whereKey($trashedTableId)->where('base_id', $base->id)->first();
        if (! $table || $table->deleted_at === null) {
            throw ApiException::notFound('That table is not in the trash.');
        }

        // A live table with the same name would make two identical tabs; suffix the returnee.
        $name = $table->name;
        while (Table::where('base_id', $base->id)->where('name', $name)->whereNull('deleted_at')->exists()) {
            $name .= ' (restored)';
        }
        $table->forceFill(['name' => $name, 'deleted_at' => null])->save();

        return response()->json(['data' => ['id' => $table->id, 'name' => $table->name]]);
    }

    // ── Helpers ──────────────────────────────────────────────────────────────

    private function authorizeAction(Request $request, string $action): TenantContext
    {
        /** @var TenantContext $tenant */
        $tenant = $request->attributes->get('tenant');
        Permissions::authorize($tenant, $action);

        return $tenant;
    }

    /** Trash of a deleted table is unreachable (middleware skips deleted); kept for safety. */
    private function deletedTable(Request $request, string $tableId): ?Table
    {
        return null;
    }

    private function label(Record $record, ?string $primaryFieldId): string
    {
        $value = $primaryFieldId ? (((array) $record->data)[$primaryFieldId] ?? null) : null;

        return is_scalar($value) && $value !== '' ? (string) $value : "Record #{$record->auto_number}";
    }
}

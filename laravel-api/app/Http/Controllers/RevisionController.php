<?php

namespace App\Http\Controllers;

use App\Models\Field;
use App\Models\Record;
use App\Models\RecordRevision;
use App\Models\User;
use App\Support\Permissions;
use App\Support\TenantContext;
use Illuminate\Http\Request;

/**
 * A record's history: who changed which field, from what, to what. Read-only — the rows are
 * written by the record controller at edit time.
 */
class RevisionController extends Controller
{
    /** GET /v1/records/{recordId}/revisions — newest first. */
    public function list(Request $request, string $recordId)
    {
        /** @var TenantContext $tenant */
        $tenant = $request->attributes->get('tenant');
        Permissions::authorize($tenant, 'record:read');

        /** @var Record $record */
        $record = $request->attributes->get('resolved_record') ?? abort(404);

        $revisions = RecordRevision::where('record_id', $record->id)
            ->orderByDesc('created_at')->limit(50)->get();

        $userNames = User::whereIn('id', $revisions->pluck('user_id')->filter()->unique())
            ->pluck('name', 'id');
        $fieldNames = Field::where('table_id', $record->table_id)->pluck('name', 'id');

        $data = $revisions->map(fn (RecordRevision $rev) => [
            'id' => $rev->id,
            'kind' => $rev->kind,
            'userName' => $rev->user_id ? ($userNames[$rev->user_id] ?? 'Someone') : 'Automation',
            'changes' => collect((array) ($rev->changes ?? []))->map(fn ($change, $fieldId) => [
                'field' => $fieldNames[$fieldId] ?? $fieldId,
                'from' => $change['from'] ?? null,
                'to' => $change['to'] ?? null,
            ])->values()->all(),
            'createdAt' => $rev->created_at?->toIso8601String(),
        ])->all();

        return response()->json(['data' => $data]);
    }
}

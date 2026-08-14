<?php

namespace App\Console\Commands;

use App\Models\Base;
use App\Models\Field;
use App\Models\Organization;
use App\Models\OrganizationMember;
use App\Models\Record;
use App\Models\Table as TableModel;
use App\Models\User;
use App\Models\Workspace;
use App\Models\WorkspaceMember;
use Illuminate\Console\Command;
use Illuminate\Support\Carbon;

/**
 * Imports one Airtable base (read-only copy) into a new base in this app.
 *
 *   php artisan airtable:import {dir} --owner=owner@demo.tessera.local --workspace="Delta Medical"
 *
 * {dir} must contain:
 *   manifest.json           — the list_tables_for_base output {tables:[{id,name,primaryFieldId,fields}]}
 *   records/{tableId}.json   — an array of Airtable records [{id,createdTime,cellValuesByFieldId}]
 *
 * Nothing is ever written back to Airtable — this only reads the pulled JSON and writes locally.
 */
class AirtableImport extends Command
{
    protected $signature = 'airtable:import {dir} {--owner=owner@demo.tessera.local} {--workspace=Imported} {--base=Imported base} {--into-base=} {--only=}';
    protected $description = 'Import a pulled Airtable base (manifest + records JSON) into a new base.';

    private const TYPE_MAP = [
        'singleLineText' => 'singleLineText',
        'multilineText' => 'longText',
        'richText' => 'longText',
        'email' => 'email',
        'url' => 'url',
        'phoneNumber' => 'phone',
        'number' => 'number',
        'currency' => 'currency',
        'percent' => 'percent',
        'rating' => 'rating',
        'duration' => 'duration',
        'checkbox' => 'checkbox',
        'date' => 'date',
        'dateTime' => 'dateTime',
        'singleSelect' => 'singleSelect',
        'multipleSelects' => 'multipleSelect',
        'singleCollaborator' => 'singleLineText',
        'multipleCollaborators' => 'longText',
        'multipleAttachments' => 'attachment',
        // Computed/relational Airtable types are stored as plain text so their VALUE survives.
        'formula' => 'longText',
        'aiText' => 'longText',
        'rollup' => 'longText',
        'lookup' => 'longText',
        'count' => 'number',
        'autoNumber' => 'number',
        'createdTime' => 'dateTime',
        'lastModifiedTime' => 'dateTime',
        'multipleRecordLinks' => 'longText',
    ];

    public function handle(): int
    {
        $dir = rtrim($this->argument('dir'), '/');
        $manifestPath = "{$dir}/manifest.json";
        if (! is_file($manifestPath)) {
            $this->error("manifest.json not found in {$dir}");

            return self::FAILURE;
        }
        $manifest = json_decode(file_get_contents($manifestPath), true);

        $owner = User::where('email', $this->option('owner'))->first();
        if (! $owner) {
            $this->error('Owner user not found: '.$this->option('owner'));

            return self::FAILURE;
        }
        $org = OrganizationMember::where('user_id', $owner->id)->where('role', 'owner')->first()?->organization
            ?? Organization::first();

        $now = Carbon::now();

        // Add into an existing base (preserving its other tables/attachments), or create a new one.
        if ($this->option('into-base')) {
            $base = Base::where('name', $this->option('into-base'))->whereNull('deleted_at')->first();
            if (! $base) {
                $this->error('Target base not found: '.$this->option('into-base'));

                return self::FAILURE;
            }
            $this->info("Adding into existing base: {$base->name} ({$base->id})");
        } else {
            $ws = Workspace::firstOrCreate(
                ['organization_id' => $org->id, 'name' => $this->option('workspace')],
                ['created_by_id' => $owner->id, 'position' => 99],
            );
            WorkspaceMember::firstOrCreate(
                ['workspace_id' => $ws->id, 'user_id' => $owner->id],
                ['organization_id' => $org->id, 'role' => 'owner'],
            );
            $base = Base::create([
                'organization_id' => $org->id,
                'workspace_id' => $ws->id,
                'name' => $this->option('base'),
                'icon' => '🏥',
                'created_by_id' => $owner->id,
            ]);
            $this->info("Base created: {$base->name} ({$base->id})");
        }

        $only = $this->option('only') ? explode(',', $this->option('only')) : null;

        foreach ($manifest['tables'] as $t) {
            if ($only !== null && ! in_array($t['id'], $only, true)) {
                continue;
            }
            // Replace an existing same-named table (safe for the empty ones being back-filled).
            TableModel::where('base_id', $base->id)->where('name', $t['name'])->forceDelete();
            $this->importTable($dir, $base, $org, $owner, $t, $now);
        }

        $this->info('Import complete.');

        return self::SUCCESS;
    }

    private function importTable(string $dir, Base $base, Organization $org, User $owner, array $t, Carbon $now): void
    {
        $table = TableModel::create([
            'organization_id' => $org->id,
            'base_id' => $base->id,
            'name' => $t['name'],
            'created_by_id' => $owner->id,
        ]);

        // Create fields; remember airtableFieldId => [myField, airtableType]
        $map = [];
        $pos = 0;
        foreach ($t['fields'] as $f) {
            $myType = self::TYPE_MAP[$f['type']] ?? 'singleLineText';
            $isPrimary = ($f['id'] === ($t['primaryFieldId'] ?? null));
            $field = Field::create([
                'organization_id' => $org->id,
                'table_id' => $table->id,
                'name' => $f['name'],
                'type' => $myType,
                'position' => $pos++,
                'is_primary' => $isPrimary,
                'options' => [],
                'created_by_id' => $owner->id,
            ]);
            if ($isPrimary) {
                $table->forceFill(['primary_field_id' => $field->id])->save();
            }
            $map[$f['id']] = ['field' => $field, 'atype' => $f['type'], 'mytype' => $myType];
        }

        // Load records
        $recPath = "{$dir}/records/{$t['id']}.json";
        $raw = is_file($recPath) ? (json_decode(file_get_contents($recPath), true) ?: []) : [];
        // Accept either a bare array of records or the raw MCP `{records:[...]}` (possibly an array
        // of pages, each with its own `records`).
        $records = $raw['records'] ?? (isset($raw[0]['records']) ? array_merge(...array_column($raw, 'records')) : $raw);

        // First pass: collect select choices from the data.
        $choices = []; // airtableFieldId => [name => color]
        foreach ($records as $r) {
            foreach (($r['cellValuesByFieldId'] ?? []) as $fid => $val) {
                $atype = $map[$fid]['atype'] ?? null;
                if ($atype === 'singleSelect' && is_array($val)) {
                    $choices[$fid][$val['name']] = $val['color'] ?? null;
                } elseif ($atype === 'multipleSelects' && is_array($val)) {
                    foreach ($val as $c) {
                        if (is_array($c)) $choices[$fid][$c['name']] = $c['color'] ?? null;
                    }
                }
            }
        }
        foreach ($choices as $fid => $names) {
            $map[$fid]['field']->forceFill(['options' => ['choices' => array_map(
                fn ($name) => ['id' => $name, 'label' => $name, 'color' => $this->color($names[$name])],
                array_keys($names),
            )]])->save();
        }

        // Second pass: insert records.
        $seq = 0;
        foreach ($records as $r) {
            $seq++;
            $data = [];
            foreach (($r['cellValuesByFieldId'] ?? []) as $fid => $val) {
                if (! isset($map[$fid])) continue;
                $data[$map[$fid]['field']->id] = $this->value($map[$fid]['atype'], $val);
            }
            Record::create([
                'organization_id' => $org->id,
                'table_id' => $table->id,
                'data' => $data,
                'version' => 1,
                'auto_number' => $seq,
                'created_by' => $owner->id,
                'updated_by' => $owner->id,
                'created_at' => $now,
                'updated_at' => $now,
            ]);
        }
        $table->forceFill(['record_count' => count($records), 'auto_number_seq' => $seq])->save();

        $this->line("  {$t['name']}: ".count($t['fields'])." fields, ".count($records).' records');
    }

    /** Convert an Airtable cell value to the value this app stores. */
    private function value(string $atype, mixed $val): mixed
    {
        return match ($atype) {
            'singleSelect' => is_array($val) ? ($val['name'] ?? null) : $val,
            'multipleSelects' => is_array($val) ? array_map(fn ($c) => is_array($c) ? ($c['name'] ?? '') : $c, $val) : [],
            'singleCollaborator' => is_array($val) ? ($val['name'] ?? $val['email'] ?? null) : $val,
            'multipleCollaborators' => is_array($val)
                ? implode(', ', array_map(fn ($c) => is_array($c) ? ($c['name'] ?? '') : $c, $val)) : $val,
            'multipleAttachments' => is_array($val) ? array_map(fn ($a) => [
                'id' => $a['id'] ?? null,
                'filename' => $a['filename'] ?? 'file',
                'url' => $a['url'] ?? null,
                'size' => $a['size'] ?? null,
                'mimeType' => $a['type'] ?? null,
            ], $val) : [],
            'aiText' => is_array($val) ? ($val['value'] ?? null) : $val,
            'formula', 'rollup', 'lookup' => is_array($val) ? json_encode($val) : $val,
            'multipleRecordLinks' => is_array($val)
                ? implode(', ', array_map(fn ($l) => is_array($l) ? ($l['name'] ?? $l['id'] ?? '') : $l, $val)) : $val,
            default => $val,
        };
    }

    private function color(?string $airtableColor): string
    {
        $c = (string) $airtableColor;
        return match (true) {
            str_contains($c, 'blue') => '#2563eb',
            str_contains($c, 'green') => '#16a34a',
            str_contains($c, 'red') => '#dc2626',
            str_contains($c, 'yellow') => '#f59e0b',
            str_contains($c, 'orange') => '#f97316',
            str_contains($c, 'purple') => '#a855f7',
            str_contains($c, 'pink') => '#ec4899',
            str_contains($c, 'teal') || str_contains($c, 'cyan') => '#14b8a6',
            str_contains($c, 'gray') || str_contains($c, 'grey') => '#64748b',
            default => '#64748b',
        };
    }
}

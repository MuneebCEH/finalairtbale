<?php

namespace App\Support;

use App\Models\Automation;
use App\Models\Field;
use App\Models\Record;
use App\Models\Table;
use Illuminate\Support\Carbon;
use Illuminate\Support\Facades\Http;
use Illuminate\Support\Facades\Log;

/**
 * Runs the automations that watch a table, synchronously, right after the write that triggered
 * them. Shared hosting has no queue worker, so in-request execution with tight caps is the honest
 * design: at most {@see MAX_DEPTH} chained hops (an automation's create/update may trigger one
 * more automation, never a cascade), five actions per automation, five-second webhooks.
 *
 * A failing action never fails the user's write — the record was already saved; the automation
 * logs and moves on.
 */
class AutomationRunner
{
    private const MAX_DEPTH = 1;
    private const MAX_ACTIONS = 5;

    /** @param 'created'|'updated' $event */
    public static function fire(string $event, Record $record, int $depth = 0): void
    {
        if ($depth > self::MAX_DEPTH) {
            return;
        }

        $automations = Automation::where('table_id', $record->table_id)
            ->where('enabled', true)->whereNull('deleted_at')->get();

        foreach ($automations as $automation) {
            try {
                if (! self::triggerMatches($automation, $event, $record)) {
                    continue;
                }
                self::run($automation, $record, $depth);
            } catch (\Throwable $e) {
                Log::warning("automation {$automation->id} failed: {$e->getMessage()}");
            }
        }
    }

    /** Runs one automation against a record (also used by the "Run test" button). */
    public static function run(Automation $automation, Record $record, int $depth = 0): void
    {
        $actions = array_slice((array) $automation->actions, 0, self::MAX_ACTIONS);
        foreach ($actions as $action) {
            try {
                self::execute((array) $action, $automation, $record, $depth);
            } catch (\Throwable $e) {
                Log::warning("automation {$automation->id} action failed: {$e->getMessage()}");
            }
        }

        $automation->forceFill([
            'run_count' => (int) $automation->run_count + 1,
            'last_run_at' => Carbon::now(),
        ])->saveQuietly();
    }

    private static function triggerMatches(Automation $automation, string $event, Record $record): bool
    {
        return match ($automation->trigger_type) {
            'record_created' => $event === 'created',
            'record_updated' => $event === 'updated',
            // "When record matches conditions" fires on either write, if the conditions hold now.
            'record_matches' => self::conditionsHold(
                (array) ($automation->trigger_config['conditions'] ?? []),
                ($automation->trigger_config['conjunction'] ?? 'and') === 'or' ? 'or' : 'and',
                $record,
            ),
            default => false,
        };
    }

    /** Evaluates toolbar-style conditions against the record's data, in PHP. */
    private static function conditionsHold(array $conditions, string $conjunction, Record $record): bool
    {
        if ($conditions === []) {
            return false; // A matcher with no conditions would fire on every write — never intended.
        }
        $data = (array) $record->data;

        $results = array_map(function ($c) use ($data) {
            $c = (array) $c;
            $actual = $data[$c['fieldId'] ?? ''] ?? null;
            $expected = $c['value'] ?? null;
            $actualText = is_scalar($actual) ? mb_strtolower(trim((string) $actual)) : null;
            $expectedText = is_scalar($expected) ? mb_strtolower(trim((string) $expected)) : null;

            return match ($c['operator'] ?? 'is') {
                'is' => $actualText !== null && $actualText === $expectedText,
                'isNot' => $actualText === null || $actualText !== $expectedText,
                'contains' => $actualText !== null && $expectedText !== null && str_contains($actualText, $expectedText),
                'isEmpty' => $actual === null || $actual === '' || $actual === [],
                'isNotEmpty' => ! ($actual === null || $actual === '' || $actual === []),
                'gt' => is_numeric($actual) && is_numeric($expected) && $actual > $expected,
                'lt' => is_numeric($actual) && is_numeric($expected) && $actual < $expected,
                default => false,
            };
        }, $conditions);

        return $conjunction === 'or' ? in_array(true, $results, true) : ! in_array(false, $results, true);
    }

    private static function execute(array $action, Automation $automation, Record $record, int $depth): void
    {
        $config = (array) ($action['config'] ?? []);

        switch ($action['type'] ?? '') {
            case 'update_record': {
                $values = self::cleanValues((array) ($config['values'] ?? []), $record->table_id);
                if ($values === []) {
                    return;
                }
                $record->forceFill([
                    'data' => array_merge((array) $record->data, $values),
                    'version' => (int) $record->version + 1,
                    'updated_at' => Carbon::now(),
                ])->saveQuietly();
                self::fire('updated', $record->fresh(), $depth + 1);
                break;
            }

            case 'create_record': {
                $tableId = (string) ($config['tableId'] ?? '');
                $target = Table::whereKey($tableId)->whereNull('deleted_at')
                    ->where('organization_id', $automation->organization_id)->first();
                if (! $target) {
                    return;
                }
                $values = self::cleanValues((array) ($config['values'] ?? []), $target->id, $record);
                $seq = (int) $target->auto_number_seq + 1;
                $created = Record::create([
                    'organization_id' => $automation->organization_id,
                    'table_id' => $target->id,
                    'data' => $values,
                    'version' => 1,
                    'auto_number' => $seq,
                    'created_by' => $automation->created_by,
                    'updated_by' => $automation->created_by,
                    'created_at' => Carbon::now(),
                    'updated_at' => Carbon::now(),
                ]);
                $target->forceFill([
                    'auto_number_seq' => $seq,
                    'record_count' => (int) $target->record_count + 1,
                ])->save();
                self::fire('created', $created, $depth + 1);
                break;
            }

            case 'webhook': {
                $url = (string) ($config['url'] ?? '');
                // https only, and never to private/loopback hosts — this runs server-side.
                $host = parse_url($url, PHP_URL_HOST) ?: '';
                if (! str_starts_with($url, 'https://') || $host === '' ||
                    filter_var(gethostbyname($host), FILTER_VALIDATE_IP, FILTER_FLAG_NO_PRIV_RANGE | FILTER_FLAG_NO_RES_RANGE) === false) {
                    return;
                }
                Http::timeout(5)->post($url, [
                    'automation' => ['id' => $automation->id, 'name' => $automation->name],
                    'record' => ['id' => $record->id, 'fields' => self::labelled($record)],
                ]);
                break;
            }

            case 'send_email': {
                $to = (string) ($config['to'] ?? '');
                if (! filter_var($to, FILTER_VALIDATE_EMAIL)) {
                    return;
                }
                $subject = self::template((string) ($config['subject'] ?? 'Automation: '.$automation->name), $record);
                $body = self::template((string) ($config['body'] ?? ''), $record);
                // Plain mail(): shared hosts route it through sendmail; Laravel mailers need SMTP
                // credentials this deployment does not have.
                @mail($to, $subject, $body !== '' ? $body : $subject, 'From: noreply@'.(parse_url(config('app.url'), PHP_URL_HOST) ?: 'localhost'));
                break;
            }
        }
    }

    /** Keeps only values whose field really belongs to the table (a deleted field is dropped). */
    private static function cleanValues(array $values, string $tableId, ?Record $source = null): array
    {
        $valid = Field::where('table_id', $tableId)->whereNull('deleted_at')->pluck('id')->flip();
        $out = [];
        foreach ($values as $fieldId => $value) {
            if (! isset($valid[$fieldId])) {
                continue;
            }
            // "{{fieldId}}" copies a value across from the triggering record.
            if ($source && is_string($value) && preg_match('/^\{\{(fld_[A-Z0-9]+)\}\}$/', $value, $m)) {
                $value = ((array) $source->data)[$m[1]] ?? null;
            }
            if ($value !== null && $value !== '') {
                $out[$fieldId] = $value;
            }
        }

        return $out;
    }

    /** The record's data keyed by field NAME — what a webhook consumer can actually read. */
    private static function labelled(Record $record): array
    {
        $names = Field::where('table_id', $record->table_id)->whereNull('deleted_at')->pluck('name', 'id');
        $out = [];
        foreach ((array) $record->data as $fieldId => $value) {
            $out[$names[$fieldId] ?? $fieldId] = $value;
        }

        return $out;
    }

    /** Replaces {{Field Name}} placeholders in email templates with the record's values. */
    private static function template(string $text, Record $record): string
    {
        $names = Field::where('table_id', $record->table_id)->whereNull('deleted_at')->pluck('id', 'name');
        $data = (array) $record->data;

        return preg_replace_callback('/\{\{([^}]+)\}\}/', function ($m) use ($names, $data) {
            $fieldId = $names[trim($m[1])] ?? null;
            $value = $fieldId ? ($data[$fieldId] ?? '') : '';

            return is_scalar($value) ? (string) $value : json_encode($value);
        }, $text) ?? $text;
    }
}

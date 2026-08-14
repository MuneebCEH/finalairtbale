<?php

namespace App\Console\Commands;

use App\Models\Base;
use App\Models\Field;
use App\Models\Record;
use Illuminate\Console\Command;
use Illuminate\Support\Facades\Http;
use Illuminate\Support\Facades\Storage;
use Illuminate\Support\Str;

/**
 * Downloads the attachment files an Airtable import brought in as references, storing them on the
 * public disk and rewriting each attachment's URL to the locally-served copy — so the files
 * survive after Airtable's temporary URLs expire. Reads only; never touches Airtable.
 */
class AirtableDownloadAttachments extends Command
{
    protected $signature = 'airtable:download-attachments {base} {--limit=100000} {--base-url=http://localhost:8000}';
    protected $description = 'Download imported Airtable attachment files to local public storage.';

    public function handle(): int
    {
        $base = Base::where('name', $this->argument('base'))->whereNull('deleted_at')->first();
        if (! $base) {
            $this->error('Base not found: '.$this->argument('base'));

            return self::FAILURE;
        }

        $limit = (int) $this->option('limit');
        $baseUrl = rtrim($this->option('base-url'), '/');
        $downloaded = 0;
        $failed = 0;

        $attachmentFields = Field::where('organization_id', $base->organization_id)
            ->whereIn('table_id', $base->tables()->pluck('id'))
            ->where('type', 'attachment')->whereNull('deleted_at')
            ->get()->groupBy('table_id');

        foreach ($attachmentFields as $tableId => $fields) {
            $fieldIds = $fields->pluck('id')->all();

            Record::where('table_id', $tableId)->whereNull('deleted_at')
                ->orderBy('auto_number')->chunkById(200, function ($records) use ($fieldIds, $baseUrl, &$downloaded, &$failed, $limit) {
                    foreach ($records as $record) {
                        if ($downloaded >= $limit) {
                            return false;
                        }
                        $data = (array) $record->data;
                        $changed = false;

                        foreach ($fieldIds as $fid) {
                            $atts = $data[$fid] ?? null;
                            if (! is_array($atts) || empty($atts)) {
                                continue;
                            }
                            foreach ($atts as $i => $att) {
                                $url = $att['url'] ?? null;
                                if (! $url || str_contains((string) $url, '/storage/attachments/')) {
                                    continue; // already local or nothing to fetch
                                }
                                $name = Str::slug(pathinfo($att['filename'] ?? 'file', PATHINFO_FILENAME))
                                    ?: 'file';
                                $ext = pathinfo($att['filename'] ?? '', PATHINFO_EXTENSION);
                                $path = "attachments/{$record->id}/{$i}_{$name}".($ext ? ".{$ext}" : '');

                                try {
                                    $resp = Http::timeout(30)->get($url);
                                    if ($resp->successful()) {
                                        Storage::disk('public')->put($path, $resp->body());
                                        $data[$fid][$i]['url'] = "{$baseUrl}/storage/{$path}";
                                        $changed = true;
                                        $downloaded++;
                                    } else {
                                        $failed++;
                                    }
                                } catch (\Throwable) {
                                    $failed++;
                                }
                                if ($downloaded >= $limit) {
                                    break 2;
                                }
                            }
                        }

                        if ($changed) {
                            $record->forceFill(['data' => $data])->saveQuietly();
                        }
                    }

                    $this->info("… {$downloaded} downloaded, {$failed} failed so far");

                    return $downloaded < $limit;
                });
        }

        $this->info("Done. Downloaded {$downloaded} attachment(s); {$failed} failed.");

        return self::SUCCESS;
    }
}

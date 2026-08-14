<?php

namespace App\Http\Controllers;

use App\Exceptions\ApiException;
use App\Models\Attachment;
use App\Support\Permissions;
use App\Support\TenantContext;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\Storage;

/**
 * File attachments. Uploads land on the configured disk (local by default; swap to S3/R2 on
 * cPanel via FILESYSTEM_DISK). The server records the file's real size/mime; the caller must store
 * what comes back rather than what it sent.
 */
class AttachmentController extends Controller
{
    public function upload(Request $request, string $baseId)
    {
        /** @var TenantContext $tenant */
        $tenant = $request->attributes->get('tenant');
        Permissions::authorize($tenant, 'record:create');

        $request->validate([
            'file' => ['required', 'file', 'max:25600'], // 25 MB
        ]);

        $file = $request->file('file');
        $id = Attachment::newPrefixedId();
        $path = $file->storeAs("attachments/{$baseId}", $id, ['disk' => config('filesystems.default')]);
        if ($path === false) {
            throw new ApiException('DEPENDENCY_UNAVAILABLE', 'The file could not be stored.');
        }

        $attachment = Attachment::create([
            'id' => $id,
            'organization_id' => $tenant->organizationId,
            'base_id' => $baseId,
            'filename' => $file->getClientOriginalName(),
            'mime_type' => $file->getMimeType() ?? 'application/octet-stream',
            'size' => $file->getSize(),
            'storage_disk' => config('filesystems.default'),
            'storage_path' => $path,
            'scan_status' => 'clean',
            'created_by' => $tenant->userId(),
        ]);

        return response()->json(['data' => $this->dto($attachment)], 201);
    }

    private function dto(Attachment $a): array
    {
        $url = null;
        try {
            if ($a->storage_disk === 'public') {
                $url = Storage::disk('public')->url($a->storage_path);
            }
        } catch (\Throwable) {
            $url = null;
        }

        return [
            'id' => $a->id,
            'filename' => $a->filename,
            'mimeType' => $a->mime_type,
            'size' => (int) $a->size,
            'url' => $url,
            'scanStatus' => $a->scan_status,
        ];
    }
}

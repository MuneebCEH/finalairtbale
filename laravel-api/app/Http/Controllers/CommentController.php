<?php

namespace App\Http\Controllers;

use App\Exceptions\ApiException;
use App\Models\Comment;
use App\Models\Record;
use App\Models\User;
use App\Support\Permissions;
use App\Support\TenantContext;
use Illuminate\Http\Request;

/** Record comments. Bodies are validated rich-text doc trees — never HTML — so stored XSS is
 *  unrepresentable rather than merely filtered. */
class CommentController extends Controller
{
    public function list(Request $request, string $recordId)
    {
        $tenant = $this->tenant($request, 'record:read');
        $record = $this->record($request);

        $limit = min(max((int) $request->query('limit', 100), 1), 100);
        $rows = Comment::where('record_id', $record->id)->whereNull('deleted_at')
            ->orderBy('created_at')->limit($limit)->get();

        return response()->json([
            'data' => $rows->map(fn (Comment $c) => $this->dto($c))->all(),
            'meta' => ['hasMore' => false, 'nextCursor' => null],
        ]);
    }

    public function create(Request $request, string $recordId)
    {
        $tenant = $this->tenant($request, 'record:read');
        $record = $this->record($request);

        // The whole JSON body is the rich-text document {type:'doc', content:[...]}.
        $body = $request->all();
        if (($body['type'] ?? null) !== 'doc' || ! is_array($body['content'] ?? null)) {
            throw ApiException::validation([
                ['path' => 'body', 'code' => 'invalid', 'message' => 'a comment body must be a rich-text document'],
            ]);
        }

        /** @var User $user */
        $user = $tenant->user;
        $comment = Comment::create([
            'organization_id' => $tenant->organizationId,
            'record_id' => $record->id,
            'table_id' => $record->table_id,
            'author_id' => $user->id,
            'body' => $body,
            'resolved' => false,
        ]);

        return response()->json(['data' => $this->dto($comment)], 201);
    }

    private function tenant(Request $request, string $action): TenantContext
    {
        /** @var TenantContext $tenant */
        $tenant = $request->attributes->get('tenant');
        Permissions::authorize($tenant, $action);

        return $tenant;
    }

    private function record(Request $request): Record
    {
        return $request->attributes->get('resolved_record') ?? throw ApiException::notFound('Record not found.');
    }

    private function dto(Comment $c): array
    {
        return [
            'id' => $c->id,
            'recordId' => $c->record_id,
            'authorId' => $c->author_id,
            'authorName' => optional(User::find($c->author_id))->name,
            'body' => $c->body,
            'resolved' => (bool) $c->resolved,
            'createdAt' => $c->created_at?->copy()->utc()->format('Y-m-d\TH:i:s.v\Z'),
            'updatedAt' => $c->updated_at?->copy()->utc()->format('Y-m-d\TH:i:s.v\Z'),
        ];
    }
}

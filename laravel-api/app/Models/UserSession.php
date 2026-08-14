<?php

namespace App\Models;

use App\Models\Concerns\HasPrefixedId;
use Illuminate\Database\Eloquent\Model;
use Illuminate\Database\Eloquent\Relations\BelongsTo;

/**
 * A refresh/session record. The plaintext token lives only in the `tessera_session` cookie; this
 * row stores its SHA-256 in `token_hash`. `id` is `ses_<ULID>`.
 */
class UserSession extends Model
{
    use HasPrefixedId;

    protected $table = 'user_sessions';
    public $incrementing = false;
    protected $keyType = 'string';
    public $timestamps = false; // created_at / last_seen_at are managed explicitly

    protected static function idPrefix(): string
    {
        return 'ses';
    }

    protected $guarded = [];

    protected function casts(): array
    {
        return [
            'mfa_satisfied' => 'boolean',
            'created_at' => 'datetime',
            'last_seen_at' => 'datetime',
            'expires_at' => 'datetime',
            'revoked_at' => 'datetime',
        ];
    }

    public function user(): BelongsTo
    {
        return $this->belongsTo(User::class);
    }

    public function isActive(): bool
    {
        return $this->revoked_at === null && $this->expires_at->isFuture();
    }
}

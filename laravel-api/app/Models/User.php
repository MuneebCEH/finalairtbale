<?php

namespace App\Models;

use App\Models\Concerns\HasPrefixedId;
use Illuminate\Database\Eloquent\Model;
use Illuminate\Database\Eloquent\Relations\HasMany;
use Illuminate\Database\Eloquent\SoftDeletes;

/**
 * Tessera user. Custom string primary key (`usr_<ULID>`), soft-deletable, password stored in
 * `password_hash` (not Laravel's default `password`). The public projection returned to clients
 * is defined in `toPublicArray()` and must stay byte-for-byte identical to the NestJS
 * `publicUser` serializer.
 */
class User extends Model
{
    use HasPrefixedId;
    use SoftDeletes;

    protected $table = 'users';
    public $incrementing = false;
    protected $keyType = 'string';

    protected static function idPrefix(): string
    {
        return 'usr';
    }

    protected $guarded = [];

    protected $hidden = [
        'password_hash',
        'totp_secret_cipher',
        'totp_secret_key_version',
    ];

    protected function casts(): array
    {
        return [
            'email_verified_at' => 'datetime',
            'locked_until' => 'datetime',
            'last_login_at' => 'datetime',
            'deletion_requested_at' => 'datetime',
            'two_factor_enabled' => 'boolean',
            'is_platform_admin' => 'boolean',
            'failed_login_count' => 'integer',
            'notification_preferences' => 'array',
        ];
    }

    public function sessions(): HasMany
    {
        return $this->hasMany(UserSession::class);
    }

    /**
     * The exact object shape the API returns for a user — matches NestJS `AuthService.publicUser`.
     */
    public function toPublicArray(): array
    {
        return [
            'id' => $this->id,
            'email' => $this->email,
            'name' => $this->name,
            'avatarUrl' => $this->avatar_url,
            'emailVerified' => $this->email_verified_at !== null,
            'twoFactorEnabled' => (bool) $this->two_factor_enabled,
            // Additive to the NestJS contract: existing readers ignore it; the web app uses it
            // to decide whether the platform console link exists at all.
            'isSuperAdmin' => (bool) $this->is_super_admin,
            'timezone' => $this->timezone,
            'locale' => $this->locale,
            'theme' => $this->theme,
            // Match JS `Date.toISOString()`: millisecond precision, UTC, trailing `Z`.
            'createdAt' => $this->created_at
                ? $this->created_at->copy()->utc()->format('Y-m-d\TH:i:s.v\Z')
                : null,
        ];
    }
}

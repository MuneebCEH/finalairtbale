<?php

namespace App\Models;

use App\Models\Concerns\HasPrefixedId;
use Illuminate\Database\Eloquent\Model;

class AuthToken extends Model
{
    use HasPrefixedId;

    protected $table = 'auth_tokens';
    public $incrementing = false;
    protected $keyType = 'string';
    public $timestamps = false;

    protected static function idPrefix(): string
    {
        return 'tok';
    }

    protected $guarded = [];

    protected function casts(): array
    {
        return [
            'expires_at' => 'datetime',
            'consumed_at' => 'datetime',
            'created_at' => 'datetime',
        ];
    }
}

<?php

namespace App\Models;

use App\Models\Concerns\HasPrefixedId;
use Illuminate\Database\Eloquent\Model;
use Illuminate\Database\Eloquent\Relations\HasMany;
use Illuminate\Database\Eloquent\SoftDeletes;

class Organization extends Model
{
    use HasPrefixedId;
    use SoftDeletes;

    protected $table = 'organizations';
    public $incrementing = false;
    protected $keyType = 'string';

    protected static function idPrefix(): string
    {
        return 'org';
    }

    protected $guarded = [];

    protected function casts(): array
    {
        return [
            'settings' => 'array',
            'legal_hold' => 'boolean',
            'trial_ends_at' => 'datetime',
        ];
    }

    public function members(): HasMany
    {
        return $this->hasMany(OrganizationMember::class);
    }

    public function workspaces(): HasMany
    {
        return $this->hasMany(Workspace::class);
    }
}

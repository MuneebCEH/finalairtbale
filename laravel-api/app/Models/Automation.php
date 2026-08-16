<?php

namespace App\Models;

use App\Models\Concerns\HasPrefixedId;
use Illuminate\Database\Eloquent\Model;
use Illuminate\Database\Eloquent\SoftDeletes;

class Automation extends Model
{
    use HasPrefixedId;
    use SoftDeletes;

    public $incrementing = false;

    protected $keyType = 'string';

    protected $guarded = [];

    protected function casts(): array
    {
        return [
            'trigger_config' => 'array',
            'actions' => 'array',
            'enabled' => 'boolean',
            'run_count' => 'integer',
            'last_run_at' => 'datetime',
        ];
    }

    protected static function idPrefix(): string
    {
        return 'aut';
    }
}

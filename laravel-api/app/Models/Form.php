<?php

namespace App\Models;

use App\Models\Concerns\HasPrefixedId;
use Illuminate\Database\Eloquent\Model;
use Illuminate\Database\Eloquent\SoftDeletes;

class Form extends Model
{
    use HasPrefixedId;
    use SoftDeletes;

    protected $table = 'forms';
    public $incrementing = false;
    protected $keyType = 'string';

    protected static function idPrefix(): string { return 'frm'; }

    protected $guarded = [];
    protected function casts(): array {
        return ['config' => 'array', 'is_published' => 'boolean', 'submission_count' => 'integer'];
    }
}

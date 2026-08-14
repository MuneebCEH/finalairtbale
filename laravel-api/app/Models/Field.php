<?php

namespace App\Models;

use App\Models\Concerns\HasPrefixedId;
use Illuminate\Database\Eloquent\Model;
use Illuminate\Database\Eloquent\Relations\BelongsTo;
use Illuminate\Database\Eloquent\SoftDeletes;

class Field extends Model
{
    use HasPrefixedId;
    use SoftDeletes;

    protected $table = 'fields';
    public $incrementing = false;
    protected $keyType = 'string';

    protected static function idPrefix(): string { return 'fld'; }

    protected $guarded = [];
    protected function casts(): array {
        return ['position' => 'integer', 'is_primary' => 'boolean', 'is_required' => 'boolean',
                'is_unique' => 'boolean', 'options' => 'array', 'default_value' => 'array', 'compute_meta' => 'array'];
    }

    public function table(): BelongsTo { return $this->belongsTo(Table::class); }
}

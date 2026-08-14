<?php

namespace App\Models;

use App\Models\Concerns\HasPrefixedId;
use Illuminate\Database\Eloquent\Model;
use Illuminate\Database\Eloquent\Relations\BelongsTo;
use Illuminate\Database\Eloquent\Relations\HasMany;
use Illuminate\Database\Eloquent\SoftDeletes;

class Table extends Model
{
    use HasPrefixedId;
    use SoftDeletes;

    protected $table = 'tables';
    public $incrementing = false;
    protected $keyType = 'string';

    protected static function idPrefix(): string { return 'tbl'; }

    protected $guarded = [];
    protected function casts(): array {
        return ['position' => 'integer', 'data_version' => 'integer', 'record_count' => 'integer',
                'auto_number_seq' => 'integer', 'hidden_at' => 'datetime', 'archived_at' => 'datetime'];
    }

    public function base(): BelongsTo { return $this->belongsTo(Base::class); }
    public function fields(): HasMany { return $this->hasMany(Field::class); }
}

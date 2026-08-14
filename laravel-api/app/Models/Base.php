<?php

namespace App\Models;

use App\Models\Concerns\HasPrefixedId;
use Illuminate\Database\Eloquent\Model;
use Illuminate\Database\Eloquent\Relations\BelongsTo;
use Illuminate\Database\Eloquent\Relations\HasMany;
use Illuminate\Database\Eloquent\SoftDeletes;

class Base extends Model
{
    use HasPrefixedId;
    use SoftDeletes;

    protected $table = 'bases';
    public $incrementing = false;
    protected $keyType = 'string';

    protected static function idPrefix(): string { return 'bas'; }

    protected $guarded = [];
    protected function casts(): array { return ['position' => 'integer', 'schema_version' => 'integer', 'archived_at' => 'datetime']; }

    public function workspace(): BelongsTo { return $this->belongsTo(Workspace::class); }
    public function tables(): HasMany { return $this->hasMany(Table::class); }
}

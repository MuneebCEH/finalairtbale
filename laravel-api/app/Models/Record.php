<?php

namespace App\Models;

use App\Models\Concerns\HasPrefixedId;
use Illuminate\Database\Eloquent\Model;
use Illuminate\Database\Eloquent\Relations\BelongsTo;

class Record extends Model
{
    use HasPrefixedId;

    protected $table = 'records';
    public $incrementing = false;
    protected $keyType = 'string';
    public $timestamps = false; // created_at / updated_at set explicitly

    protected static function idPrefix(): string { return 'rec'; }

    protected $guarded = [];
    protected function casts(): array {
        return ['data' => 'array', 'version' => 'integer', 'auto_number' => 'integer',
                'b0' => 'boolean', 'b1' => 'boolean', 'd0' => 'datetime', 'd1' => 'datetime', 'd2' => 'datetime',
                'created_at' => 'datetime', 'updated_at' => 'datetime', 'deleted_at' => 'datetime'];
    }

    public function tableModel(): BelongsTo { return $this->belongsTo(Table::class, 'table_id'); }
}

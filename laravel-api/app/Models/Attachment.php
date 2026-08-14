<?php

namespace App\Models;

use App\Models\Concerns\HasPrefixedId;
use Illuminate\Database\Eloquent\Model;

class Attachment extends Model
{
    use HasPrefixedId;

    protected $table = 'attachments';
    public $incrementing = false;
    protected $keyType = 'string';

    protected static function idPrefix(): string { return 'att'; }

    protected $guarded = [];
    protected function casts(): array { return ['size' => 'integer']; }
}

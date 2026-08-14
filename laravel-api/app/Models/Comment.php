<?php

namespace App\Models;

use App\Models\Concerns\HasPrefixedId;
use Illuminate\Database\Eloquent\Model;
use Illuminate\Database\Eloquent\SoftDeletes;

class Comment extends Model
{
    use HasPrefixedId;
    use SoftDeletes;

    protected $table = 'comments';
    public $incrementing = false;
    protected $keyType = 'string';

    protected static function idPrefix(): string { return 'cmt'; }

    protected $guarded = [];
    protected function casts(): array { return ['body' => 'array', 'resolved' => 'boolean']; }
}

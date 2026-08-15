<?php

namespace App\Models;

use App\Models\Concerns\HasPrefixedId;
use Illuminate\Database\Eloquent\Model;
use Illuminate\Database\Eloquent\SoftDeletes;

class View extends Model
{
    use HasPrefixedId;
    use SoftDeletes;

    protected $table = 'views';

    public $incrementing = false;

    protected $keyType = 'string';

    protected $guarded = [];

    protected function casts(): array
    {
        return ['config' => 'array', 'position' => 'integer'];
    }

    protected static function idPrefix(): string
    {
        return 'viw';
    }
}

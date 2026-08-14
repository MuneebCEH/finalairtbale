<?php

namespace App\Models\Concerns;

use Illuminate\Support\Str;

/**
 * Gives a model a Tessera-style primary key: a three-letter prefix, an underscore, and a 26-char
 * uppercase ULID — e.g. `usr_01KZCN5ZAKKAPHV6679PFD7CSM` — exactly 30 characters, matching the
 * `char(30)` ids produced by the NestJS/Prisma backend. The model declares its prefix via
 * `idPrefix()`.
 */
trait HasPrefixedId
{
    public static function bootHasPrefixedId(): void
    {
        static::creating(function ($model) {
            if (empty($model->{$model->getKeyName()})) {
                $model->{$model->getKeyName()} = static::newPrefixedId();
            }
        });
    }

    public static function newPrefixedId(): string
    {
        return static::idPrefix().'_'.strtoupper((string) Str::ulid());
    }

    abstract protected static function idPrefix(): string;
}

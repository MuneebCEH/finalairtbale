<?php

namespace App\Rules;

use Closure;
use Illuminate\Contracts\Validation\ValidationRule;

/**
 * Mirrors the NestJS `passwordSchema` (packages/validation/src/primitives.ts): 12–256 chars, not
 * a single repeated character, and at least one letter plus one non-letter.
 */
class StrongPassword implements ValidationRule
{
    public function validate(string $attribute, mixed $value, Closure $fail): void
    {
        if (! is_string($value)) {
            $fail('must be a string');

            return;
        }
        if (mb_strlen($value) < 12) {
            $fail('must be at least 12 characters');

            return;
        }
        if (mb_strlen($value) > 256) {
            $fail('must be at most 256 characters');

            return;
        }
        if (preg_match('/^(.)\1*$/u', $value)) {
            $fail('must not be a single repeated character');

            return;
        }
        if (! (preg_match('/[a-z]/i', $value) && preg_match('/[^a-z]/i', $value))) {
            $fail('must contain at least one letter and one number or symbol');
        }
    }
}

<?php

namespace App\Support;

/**
 * The complete catalogue of API error codes, mirrored from the NestJS backend
 * (packages/types/src/errors.ts). Codes are part of the public contract — clients switch on them.
 */
final class ErrorCodes
{
    /** code => [httpStatus, retryable] */
    public const MAP = [
        'MALFORMED_REQUEST' => [400, false],
        'UNAUTHENTICATED' => [401, false],
        'MFA_REQUIRED' => [401, false],
        'FORBIDDEN' => [403, false],
        'PLAN_LIMIT_EXCEEDED' => [403, false],
        'NOT_FOUND' => [404, false],
        'METHOD_NOT_ALLOWED' => [405, false],
        'RECORD_VERSION_CONFLICT' => [409, true],
        'SCHEMA_CONFLICT' => [409, true],
        'DUPLICATE_RESOURCE' => [409, false],
        'LEGAL_HOLD' => [451, false],
        'VALIDATION_FAILED' => [422, false],
        'FIELD_TYPE_MISMATCH' => [422, false],
        'FORMULA_ERROR' => [422, false],
        'AUTOMATION_LOOP_DETECTED' => [422, false],
        'PAYLOAD_TOO_LARGE' => [413, false],
        'RATE_LIMITED' => [429, true],
        'INTERNAL_ERROR' => [500, true],
        'NOT_IMPLEMENTED' => [501, false],
        'DEPENDENCY_UNAVAILABLE' => [503, true],
    ];

    public static function status(string $code): int
    {
        return self::MAP[$code][0] ?? 500;
    }

    public static function retryable(string $code): bool
    {
        return self::MAP[$code][1] ?? false;
    }
}

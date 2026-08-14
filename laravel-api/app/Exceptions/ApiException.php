<?php

namespace App\Exceptions;

use App\Support\ErrorCodes;
use RuntimeException;
use Throwable;

/**
 * A client-safe error, mirroring the NestJS `AppError`. Anything that is NOT an ApiException is
 * treated as an internal fault and surfaced as `INTERNAL_ERROR` with only a request id — no stack
 * traces or driver messages ever cross the network boundary.
 */
class ApiException extends RuntimeException
{
    public readonly string $errorCode;
    public readonly int $statusCode;
    public readonly ?array $details;

    public function __construct(string $code, string $message, ?array $details = null, ?Throwable $previous = null)
    {
        parent::__construct($message, 0, $previous);
        $this->errorCode = $code;
        $this->statusCode = ErrorCodes::status($code);
        $this->details = $details;
    }

    /** The `{ error: { ... } }` body, matching the NestJS ErrorFilter output. */
    public function toBody(string $requestId): array
    {
        $error = [
            'code' => $this->errorCode,
            'message' => $this->getMessage(),
        ];
        if ($this->details !== null) {
            $error['details'] = $this->details;
        }
        $error['requestId'] = $requestId;

        return ['error' => $error];
    }

    public static function unauthenticated(string $message = 'That email or password is not correct.'): self
    {
        return new self('UNAUTHENTICATED', $message);
    }

    public static function notFound(string $message = 'Resource not found.'): self
    {
        return new self('NOT_FOUND', $message);
    }

    public static function validation(array $issues): self
    {
        return new self('VALIDATION_FAILED', 'The request payload failed validation.', ['issues' => $issues]);
    }
}

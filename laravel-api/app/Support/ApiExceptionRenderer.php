<?php

namespace App\Support;

use App\Exceptions\ApiException;
use Illuminate\Auth\AuthenticationException;
use Illuminate\Database\Eloquent\ModelNotFoundException;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;
use Illuminate\Validation\ValidationException;
use Symfony\Component\HttpKernel\Exception\HttpExceptionInterface;
use Symfony\Component\HttpKernel\Exception\MethodNotAllowedHttpException;
use Symfony\Component\HttpKernel\Exception\NotFoundHttpException;
use Symfony\Component\HttpKernel\Exception\TooManyRequestsHttpException;
use Throwable;

/**
 * The single exit point for every error on an API route — the Laravel equivalent of the NestJS
 * ErrorFilter. Clients always see `{ error: { code, message, details?, requestId } }` and never a
 * stack trace or driver message. Anything that is not a recognised exception becomes
 * INTERNAL_ERROR.
 */
final class ApiExceptionRenderer
{
    /** Returns a JSON envelope for API requests, or null to let Laravel render normally. */
    public static function render(Throwable $e, Request $request): ?JsonResponse
    {
        if (! self::isApiRequest($request)) {
            return null;
        }

        $requestId = (string) ($request->attributes->get('request_id') ?? 'unknown');
        [$status, $code, $message, $details] = self::translate($e);

        $error = ['code' => $code, 'message' => $message];
        if ($details !== null) {
            $error['details'] = $details;
        }
        $error['requestId'] = $requestId;

        $response = new JsonResponse(['error' => $error], $status);
        $response->setEncodingOptions(JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE);
        // Error responses bypass the after-middleware (the exception unwinds the pipeline), so the
        // correlation header is stamped here too.
        $response->headers->set('X-Request-Id', $requestId);

        if ($code === 'RATE_LIMITED') {
            $retryAfter = is_array($details) ? ($details['retryAfterSeconds'] ?? 60) : 60;
            $response->headers->set('Retry-After', (string) $retryAfter);
        }

        return $response;
    }

    private static function isApiRequest(Request $request): bool
    {
        return $request->is('v1/*') || $request->is('health/*') || $request->expectsJson();
    }

    /** @return array{0:int,1:string,2:string,3:?array} [status, code, message, details] */
    private static function translate(Throwable $e): array
    {
        if ($e instanceof ApiException) {
            return [$e->statusCode, $e->errorCode, $e->getMessage(), $e->details];
        }

        if ($e instanceof ValidationException) {
            $issues = [];
            foreach ($e->errors() as $path => $messages) {
                foreach ($messages as $m) {
                    $issues[] = ['path' => $path, 'code' => 'invalid', 'message' => $m];
                }
            }

            return [422, 'VALIDATION_FAILED', 'The request payload failed validation.', ['issues' => $issues]];
        }

        if ($e instanceof AuthenticationException) {
            return [401, 'UNAUTHENTICATED', 'Authentication is required.', null];
        }

        if ($e instanceof ModelNotFoundException || $e instanceof NotFoundHttpException) {
            return [404, 'NOT_FOUND', 'Resource not found.', null];
        }

        if ($e instanceof MethodNotAllowedHttpException) {
            return [405, 'METHOD_NOT_ALLOWED', 'Method not allowed.', null];
        }

        if ($e instanceof TooManyRequestsHttpException) {
            return [429, 'RATE_LIMITED', 'Too many requests.', null];
        }

        if ($e instanceof HttpExceptionInterface) {
            $status = $e->getStatusCode();
            $code = self::HTTP_STATUS_TO_CODE[$status] ?? 'INTERNAL_ERROR';
            $message = $status >= 500 ? 'An unexpected error occurred.' : ($e->getMessage() ?: $code);

            return [$status, $code, $message, null];
        }

        // Unanticipated: never leak internals.
        return [500, 'INTERNAL_ERROR', 'An unexpected error occurred.', null];
    }

    private const HTTP_STATUS_TO_CODE = [
        400 => 'MALFORMED_REQUEST',
        401 => 'UNAUTHENTICATED',
        403 => 'FORBIDDEN',
        404 => 'NOT_FOUND',
        405 => 'METHOD_NOT_ALLOWED',
        409 => 'DUPLICATE_RESOURCE',
        413 => 'PAYLOAD_TOO_LARGE',
        422 => 'VALIDATION_FAILED',
        429 => 'RATE_LIMITED',
        501 => 'NOT_IMPLEMENTED',
        503 => 'DEPENDENCY_UNAVAILABLE',
    ];
}

<?php

namespace App\Http\Middleware;

use Closure;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;
use Illuminate\Support\Str;
use Symfony\Component\HttpFoundation\Response;

/**
 * Assigns a correlation id to every request (honouring an inbound `X-Request-Id` if present),
 * exposes it on the request as `request_id`, and echoes it back in the `X-Request-Id` response
 * header. The exception handler stamps the same id into every error body's `requestId`.
 */
class AssignRequestId
{
    public function handle(Request $request, Closure $next): Response
    {
        $requestId = $request->headers->get('X-Request-Id') ?: (string) Str::uuid();
        $request->attributes->set('request_id', $requestId);

        /** @var Response $response */
        $response = $next($request);
        $response->headers->set('X-Request-Id', $requestId);

        // Match Express/NestJS JSON: don't escape forward slashes or unicode.
        if ($response instanceof JsonResponse) {
            $response->setEncodingOptions(JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE);
        }

        return $response;
    }
}

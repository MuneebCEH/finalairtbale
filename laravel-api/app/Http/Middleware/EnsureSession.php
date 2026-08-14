<?php

namespace App\Http\Middleware;

use App\Exceptions\ApiException;
use App\Services\SessionService;
use Closure;
use Illuminate\Http\Request;
use Symfony\Component\HttpFoundation\Response;

/**
 * Authenticates a request from the `tessera_session` cookie. On success the resolved User and
 * UserSession are attached to the request (`auth_user`, `auth_session`); on failure it throws
 * UNAUTHENTICATED, producing the standard error envelope.
 */
class EnsureSession
{
    public function __construct(private readonly SessionService $sessions)
    {
    }

    public function handle(Request $request, Closure $next): Response
    {
        $token = $request->cookie($this->sessions->cookieName());
        $session = $this->sessions->resolve(is_string($token) ? $token : null);

        if (! $session) {
            throw ApiException::unauthenticated('Authentication is required.');
        }

        $request->attributes->set('auth_session', $session);
        $request->attributes->set('auth_user', $session->user);

        return $next($request);
    }
}

<?php

namespace App\Http\Controllers;

use App\Exceptions\ApiException;
use App\Models\User;
use App\Models\UserSession;
use App\Rules\StrongPassword;
use App\Services\AuthService;
use App\Services\SessionService;
use Illuminate\Http\Request;
use Illuminate\Support\Carbon;
use Illuminate\Support\Facades\Hash;

/**
 * Authentication endpoints — a faithful port of the NestJS AuthController. The session token is
 * delivered only as the HttpOnly `tessera_session` cookie, never in a body.
 */
class AuthController extends Controller
{
    public function __construct(
        private readonly SessionService $sessions,
        private readonly AuthService $auth,
    ) {
    }

    // ── Registration & verification ──────────────────────────────────────────

    public function register(Request $request)
    {
        $this->strict($request, ['email', 'password', 'name', 'invitationToken', 'acceptedTerms', 'marketingOptIn']);
        $request->validate([
            'email' => ['required', 'email', 'max:254'],
            'password' => ['required', new StrongPassword],
            'name' => ['required', 'string', 'min:1', 'max:120'],
            'invitationToken' => ['sometimes', 'string', 'max:512'],
            'acceptedTerms' => ['accepted'],
            'marketingOptIn' => ['sometimes', 'boolean'],
        ]);

        $this->auth->register($request->only(['email', 'password', 'name']));

        return response()->json([
            'data' => [
                'status' => 'pending_verification',
                'message' => 'Check your inbox to confirm your email address.',
            ],
        ], 201);
    }

    public function verifyEmail(Request $request)
    {
        $this->strict($request, ['token']);
        $request->validate(['token' => ['required', 'string', 'max:512']]);

        $this->auth->verifyEmail($request->string('token'));

        return response()->json(['data' => ['verified' => true]]);
    }

    // ── Login / logout / refresh ─────────────────────────────────────────────

    public function login(Request $request)
    {
        $this->strict($request, ['email', 'password', 'rememberMe']);
        $data = $request->validate([
            'email' => ['required', 'email', 'max:254'],
            'password' => ['required', 'string', 'max:256'],
            'rememberMe' => ['sometimes', 'boolean'],
        ]);

        $user = User::whereRaw('LOWER(email) = ?', [mb_strtolower($data['email'])])
            ->whereNull('deleted_at')->first();

        if (! $user || $user->password_hash === null || ! Hash::check($data['password'], $user->password_hash)) {
            if ($user) {
                $user->forceFill(['failed_login_count' => $user->failed_login_count + 1])->saveQuietly();
            }
            throw ApiException::unauthenticated();
        }
        if ($user->status !== 'active') {
            throw new ApiException('FORBIDDEN', 'This account is not active.', ['reason' => 'account_'.$user->status]);
        }
        if ($user->email_verified_at === null) {
            throw new ApiException('FORBIDDEN', 'Confirm your email address before signing in.', ['reason' => 'email_unverified']);
        }
        if ($user->two_factor_enabled) {
            throw new ApiException('MFA_REQUIRED', 'A second factor is required to finish signing in.');
        }

        $issued = $this->sessions->issue($user, $request);
        $user->forceFill([
            'failed_login_count' => 0,
            'last_login_at' => Carbon::now(),
            'last_login_ip' => $request->ip(),
        ])->saveQuietly();

        return response()
            ->json(['data' => $user->toPublicArray()])
            ->cookie(...$this->cookieArgs($issued['token']));
    }

    public function mfaVerify(Request $request)
    {
        // No demo account has a second factor enabled, so login never issues an mfaToken; this
        // exists so the frontend's MFA step has a well-formed endpoint to call.
        throw new ApiException('MALFORMED_REQUEST', 'That verification code is invalid or has expired.');
    }

    public function logout(Request $request)
    {
        $token = $request->cookie($this->sessions->cookieName());
        if (is_string($token)) {
            $session = $this->sessions->resolve($token);
            if ($session) {
                $this->sessions->revoke($session, 'logout');
            }
        }

        return response()->noContent()->withoutCookie($this->sessions->cookieName(), '/');
    }

    public function refresh(Request $request)
    {
        $token = $request->cookie($this->sessions->cookieName());
        if (! is_string($token) || $token === '') {
            throw ApiException::unauthenticated('No session to refresh.');
        }

        $issued = $this->sessions->refresh($token, $request);

        return response()
            ->json(['data' => [
                'refreshed' => true,
                'expiresAt' => $issued['session']->expires_at->copy()->utc()->format('Y-m-d\TH:i:s.v\Z'),
            ]])
            ->cookie(...$this->cookieArgs($issued['token']));
    }

    // ── Password ─────────────────────────────────────────────────────────────

    public function forgotPassword(Request $request)
    {
        $this->strict($request, ['email']);
        $request->validate(['email' => ['required', 'email', 'max:254']]);

        $this->auth->requestPasswordReset($request->string('email'));

        return response()->json([
            'data' => ['message' => 'If that address has an account, a reset link is on its way.'],
        ], 202);
    }

    public function resetPassword(Request $request)
    {
        $this->strict($request, ['token', 'password']);
        $request->validate([
            'token' => ['required', 'string', 'max:512'],
            'password' => ['required', new StrongPassword],
        ]);

        $this->auth->resetPassword($request->string('token'), $request->string('password'));

        return response()->json(['data' => ['reset' => true]]);
    }

    public function changePassword(Request $request)
    {
        $this->strict($request, ['currentPassword', 'newPassword', 'revokeOtherSessions']);
        $request->validate([
            'currentPassword' => ['required', 'string', 'max:256'],
            'newPassword' => ['required', new StrongPassword, 'different:currentPassword'],
            'revokeOtherSessions' => ['sometimes', 'boolean'],
        ]);

        /** @var User $user */
        $user = $request->attributes->get('auth_user');
        /** @var UserSession $session */
        $session = $request->attributes->get('auth_session');

        $this->auth->changePassword(
            $user,
            $request->string('currentPassword'),
            $request->string('newPassword'),
            $request->boolean('revokeOtherSessions', true),
            $session->id,
        );

        return response()->json(['data' => ['changed' => true]]);
    }

    // ── Sessions ─────────────────────────────────────────────────────────────

    public function listSessions(Request $request)
    {
        /** @var UserSession $session */
        $session = $request->attributes->get('auth_session');

        return response()->json([
            'data' => $this->sessions->listForUser($session->user_id, $session->id),
        ]);
    }

    public function revokeSession(Request $request, string $sessionId)
    {
        /** @var UserSession $session */
        $session = $request->attributes->get('auth_session');
        $this->sessions->revokeById($session->user_id, $sessionId);

        return response()->noContent();
    }

    public function revokeOtherSessions(Request $request)
    {
        /** @var UserSession $session */
        $session = $request->attributes->get('auth_session');
        $revoked = $this->sessions->revokeOthers($session->user_id, $session->id);

        return response()->json(['data' => ['revoked' => $revoked]]);
    }

    // ── Helpers ──────────────────────────────────────────────────────────────

    /** Rejects any property outside the allowlist — the mass-assignment defence (zod `.strict()`). */
    private function strict(Request $request, array $allowed): void
    {
        $unknown = array_diff(array_keys($request->all()), $allowed);
        if (! empty($unknown)) {
            throw ApiException::validation(array_map(
                fn ($key) => ['path' => $key, 'code' => 'unrecognized_keys', 'message' => 'unexpected property'],
                array_values($unknown),
            ));
        }
    }

    /** Positional args for ResponseFactory::cookie(), matching the login cookie attributes. */
    private function cookieArgs(string $token): array
    {
        return [
            $this->sessions->cookieName(),
            $token,
            $this->sessions->ttlDays() * 24 * 60,
            '/',
            null,
            app()->isProduction(),
            true,
            false,
            'lax',
        ];
    }
}

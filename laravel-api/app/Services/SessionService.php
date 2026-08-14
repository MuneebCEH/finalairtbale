<?php

namespace App\Services;

use App\Models\User;
use App\Models\UserSession;
use Illuminate\Http\Request;
use Illuminate\Support\Carbon;
use Illuminate\Support\Str;

/**
 * Issues and resolves session tokens, matching the NestJS contract: the plaintext token is a
 * 32-byte base64url string kept only in the `tessera_session` cookie, and the database stores its
 * SHA-256 in `user_sessions.token_hash`.
 */
class SessionService
{
    public function ttlDays(): int
    {
        return (int) env('TESSERA_SESSION_TTL_DAYS', 30);
    }

    public function cookieName(): string
    {
        return (string) env('TESSERA_SESSION_COOKIE', 'tessera_session');
    }

    /** @return array{token: string, session: UserSession} */
    public function issue(User $user, Request $request): array
    {
        $token = $this->randomToken();
        $now = Carbon::now();

        $session = new UserSession([
            'user_id' => $user->id,
            'token_hash' => $this->hash($token),
            'family_id' => 'fam_'.strtoupper((string) Str::ulid()),
            'ip_address' => $request->ip(),
            'user_agent' => Str::limit((string) $request->userAgent(), 1000, ''),
            'device_label' => $this->deviceLabel((string) $request->userAgent()),
            'mfa_satisfied' => false,
            'created_at' => $now,
            'last_seen_at' => $now,
            'expires_at' => $now->copy()->addDays($this->ttlDays()),
        ]);
        $session->save();

        return ['token' => $token, 'session' => $session];
    }

    public function resolve(?string $token): ?UserSession
    {
        if (empty($token)) {
            return null;
        }

        $session = UserSession::where('token_hash', $this->hash($token))->first();
        if (! $session || ! $session->isActive()) {
            return null;
        }

        // Best-effort touch; never fails the request.
        $session->forceFill(['last_seen_at' => Carbon::now()])->saveQuietly();

        return $session;
    }

    public function revoke(UserSession $session, string $reason = 'logout'): void
    {
        $session->forceFill(['revoked_at' => Carbon::now(), 'revoked_reason' => $reason])->saveQuietly();
    }

    /**
     * Rotates a session: a new token is issued and the old hash is remembered as the family's
     * previous token, so that reuse of the retired token can be detected later.
     *
     * @return array{token: string, session: UserSession}
     */
    public function refresh(string $oldToken, Request $request): array
    {
        $session = $this->resolve($oldToken);
        if (! $session) {
            throw \App\Exceptions\ApiException::unauthenticated('No session to refresh.');
        }

        $newToken = $this->randomToken();
        $session->forceFill([
            'previous_token_hash' => $session->token_hash,
            'token_hash' => $this->hash($newToken),
            'last_seen_at' => Carbon::now(),
            'expires_at' => Carbon::now()->addDays($this->ttlDays()),
            'ip_address' => $request->ip(),
        ])->save();

        return ['token' => $newToken, 'session' => $session];
    }

    /** @return array<int, array<string, mixed>> session summaries in the NestJS shape */
    public function listForUser(string $userId, string $currentSessionId): array
    {
        return UserSession::where('user_id', $userId)
            ->whereNull('revoked_at')
            ->orderByDesc('last_seen_at')
            ->get()
            ->map(fn (UserSession $s) => [
                'id' => $s->id,
                'createdAt' => $this->iso($s->created_at),
                'lastSeenAt' => $this->iso($s->last_seen_at),
                'expiresAt' => $this->iso($s->expires_at),
                'ipAddress' => $s->ip_address,
                'userAgent' => $s->user_agent,
                'deviceLabel' => $s->device_label,
                'location' => $s->location,
                'isCurrent' => $s->id === $currentSessionId,
            ])
            ->all();
    }

    public function revokeById(string $userId, string $sessionId): void
    {
        UserSession::where('user_id', $userId)->where('id', $sessionId)->whereNull('revoked_at')
            ->update(['revoked_at' => Carbon::now(), 'revoked_reason' => 'user_revoked']);
    }

    public function revokeOthers(string $userId, string $currentSessionId): int
    {
        return UserSession::where('user_id', $userId)
            ->where('id', '!=', $currentSessionId)
            ->whereNull('revoked_at')
            ->update(['revoked_at' => Carbon::now(), 'revoked_reason' => 'user_revoked_others']);
    }

    private function iso(?Carbon $t): ?string
    {
        return $t?->copy()->utc()->format('Y-m-d\TH:i:s.v\Z');
    }

    private function randomToken(): string
    {
        return rtrim(strtr(base64_encode(random_bytes(32)), '+/', '-_'), '=');
    }

    private function hash(string $token): string
    {
        return hash('sha256', $token);
    }

    private function deviceLabel(string $userAgent): string
    {
        $browser = str_contains($userAgent, 'Firefox') ? 'Firefox'
            : (str_contains($userAgent, 'Edg') ? 'Edge'
            : (str_contains($userAgent, 'Chrome') ? 'Chrome'
            : (str_contains($userAgent, 'Safari') ? 'Safari' : 'Unknown browser')));
        $os = str_contains($userAgent, 'Windows') ? 'Windows'
            : (str_contains($userAgent, 'Mac') ? 'macOS'
            : (str_contains($userAgent, 'Linux') ? 'Linux' : 'Unknown OS'));

        return "{$browser} on {$os}";
    }
}

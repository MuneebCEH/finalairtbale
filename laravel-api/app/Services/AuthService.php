<?php

namespace App\Services;

use App\Exceptions\ApiException;
use App\Models\AuthToken;
use App\Models\User;
use App\Models\UserSession;
use Illuminate\Support\Carbon;
use Illuminate\Support\Facades\Hash;
use Illuminate\Support\Facades\Log;

/**
 * Account lifecycle: registration, email verification, and password reset/change. Mirrors the
 * behaviour of the NestJS AuthService — notably, responses never disclose whether an email
 * address exists.
 */
class AuthService
{
    public function register(array $input): void
    {
        $email = mb_strtolower(trim($input['email']));
        $existing = User::whereRaw('LOWER(email) = ?', [$email])->first();

        // Same outward response whether or not the address is already taken.
        if ($existing) {
            return;
        }

        $user = User::create([
            'email' => $email,
            'password_hash' => Hash::make($input['password']),
            'name' => trim($input['name']),
            'email_verified_at' => null,
            'status' => 'active',
        ]);

        $raw = $this->issueToken($user->id, 'email_verification', 60 * 24);
        Log::info("[dev] email verification token for {$email}: {$raw}");
    }

    public function verifyEmail(string $token): void
    {
        $row = $this->consumeToken($token, 'email_verification');
        User::whereKey($row->user_id)->update(['email_verified_at' => Carbon::now()]);
    }

    public function requestPasswordReset(string $email): void
    {
        $email = mb_strtolower(trim($email));
        $user = User::whereRaw('LOWER(email) = ?', [$email])->whereNull('deleted_at')->first();
        if (! $user) {
            return; // never disclose non-existence
        }
        $raw = $this->issueToken($user->id, 'password_reset', 60);
        Log::info("[dev] password reset token for {$email}: {$raw}");
    }

    public function resetPassword(string $token, string $password): void
    {
        $row = $this->consumeToken($token, 'password_reset');
        User::whereKey($row->user_id)->update(['password_hash' => Hash::make($password)]);

        // A password reset invalidates every existing session.
        UserSession::where('user_id', $row->user_id)->whereNull('revoked_at')
            ->update(['revoked_at' => Carbon::now(), 'revoked_reason' => 'password_reset']);
    }

    public function changePassword(User $user, string $currentPassword, string $newPassword, bool $revokeOthers, string $currentSessionId): void
    {
        if ($user->password_hash === null || ! Hash::check($currentPassword, $user->password_hash)) {
            throw ApiException::unauthenticated('Your current password is not correct.');
        }

        $user->forceFill(['password_hash' => Hash::make($newPassword)])->saveQuietly();

        if ($revokeOthers) {
            UserSession::where('user_id', $user->id)
                ->where('id', '!=', $currentSessionId)
                ->whereNull('revoked_at')
                ->update(['revoked_at' => Carbon::now(), 'revoked_reason' => 'password_change']);
        }
    }

    private function issueToken(string $userId, string $type, int $ttlMinutes): string
    {
        $raw = rtrim(strtr(base64_encode(random_bytes(32)), '+/', '-_'), '=');
        AuthToken::create([
            'user_id' => $userId,
            'type' => $type,
            'token_hash' => hash('sha256', $raw),
            'expires_at' => Carbon::now()->addMinutes($ttlMinutes),
            'created_at' => Carbon::now(),
        ]);

        return $raw;
    }

    private function consumeToken(string $token, string $type): AuthToken
    {
        $row = AuthToken::where('type', $type)
            ->where('token_hash', hash('sha256', $token))
            ->whereNull('consumed_at')
            ->first();

        if (! $row || $row->expires_at->isPast()) {
            throw new ApiException('MALFORMED_REQUEST', 'This link is invalid or has expired.');
        }

        $row->forceFill(['consumed_at' => Carbon::now()])->save();

        return $row;
    }
}

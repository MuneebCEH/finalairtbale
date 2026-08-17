<?php

namespace App\Http\Controllers;

use App\Exceptions\ApiException;
use App\Models\Base;
use App\Models\Organization;
use App\Models\OrganizationMember;
use App\Models\Record;
use App\Models\Table;
use App\Models\User;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Hash;

/**
 * The platform console — for the people who RUN this SaaS, not for any one tenant. Every entry
 * point requires `users.is_super_admin`; anyone else gets the same 404 a wrong URL gets, so the
 * console's existence is not advertised to tenants.
 */
class AdminController extends Controller
{
    /** GET /v1/admin/overview — the whole platform at a glance. */
    public function overview(Request $request)
    {
        $this->guard($request);

        $recordCounts = Record::whereNull('deleted_at')
            ->select('organization_id', DB::raw('COUNT(*) as n'))
            ->groupBy('organization_id')->pluck('n', 'organization_id');
        $memberCounts = OrganizationMember::where('status', 'active')
            ->select('organization_id', DB::raw('COUNT(*) as n'))
            ->groupBy('organization_id')->pluck('n', 'organization_id');
        $baseCounts = Base::whereNull('deleted_at')
            ->select('organization_id', DB::raw('COUNT(*) as n'))
            ->groupBy('organization_id')->pluck('n', 'organization_id');

        $organizations = Organization::orderBy('created_at')->get()->map(fn (Organization $o) => [
            'id' => $o->id,
            'name' => $o->name,
            'slug' => $o->slug,
            'plan' => $o->plan,
            'status' => $o->status,
            'members' => (int) ($memberCounts[$o->id] ?? 0),
            'bases' => (int) ($baseCounts[$o->id] ?? 0),
            'records' => (int) ($recordCounts[$o->id] ?? 0),
            'createdAt' => $o->created_at?->toIso8601String(),
        ])->all();

        return response()->json(['data' => [
            'totals' => [
                'organizations' => Organization::count(),
                'users' => User::whereNull('deleted_at')->count(),
                'bases' => Base::whereNull('deleted_at')->count(),
                'tables' => Table::whereNull('deleted_at')->count(),
                'records' => Record::whereNull('deleted_at')->count(),
            ],
            'organizations' => $organizations,
        ]]);
    }

    /** GET /v1/admin/users — every account on the platform. */
    public function users(Request $request)
    {
        $this->guard($request);

        $orgCounts = OrganizationMember::where('status', 'active')
            ->select('user_id', DB::raw('COUNT(*) as n'))
            ->groupBy('user_id')->pluck('n', 'user_id');

        $users = User::whereNull('deleted_at')->orderBy('created_at')->get()->map(fn (User $u) => [
            'id' => $u->id,
            'email' => $u->email,
            'name' => $u->name,
            'status' => $u->status,
            'isSuperAdmin' => (bool) $u->is_super_admin,
            'organizations' => (int) ($orgCounts[$u->id] ?? 0),
            'lastLoginAt' => $u->last_login_at?->toIso8601String(),
            'createdAt' => $u->created_at?->toIso8601String(),
        ])->all();

        return response()->json(['data' => $users]);
    }

    /**
     * PATCH /v1/admin/users/{userId} — suspend/activate, set a new password, grant or revoke
     * the super-admin flag. A super admin cannot suspend or demote THEMSELVES — the platform
     * must always keep a working operator.
     */
    public function updateUser(Request $request, string $userId)
    {
        $me = $this->guard($request);

        $data = $request->validate([
            'status' => ['sometimes', 'string', 'in:active,suspended'],
            'password' => ['sometimes', 'string', 'min:8', 'max:256'],
            'isSuperAdmin' => ['sometimes', 'boolean'],
        ]);

        $user = User::whereKey($userId)->whereNull('deleted_at')->first();
        if (! $user) {
            throw ApiException::notFound('User not found.');
        }

        $isSelf = $user->id === $me->id;
        if ($isSelf && (($data['status'] ?? 'active') !== 'active' || ($data['isSuperAdmin'] ?? true) === false)) {
            throw new ApiException('MALFORMED_REQUEST', 'You cannot suspend or demote your own account.');
        }

        if (isset($data['status'])) {
            $user->status = $data['status'];
        }
        if (isset($data['password'])) {
            $user->password_hash = Hash::make($data['password']);
        }
        if (isset($data['isSuperAdmin'])) {
            $user->is_super_admin = $data['isSuperAdmin'];
        }
        $user->save();

        // Suspension takes effect NOW, not at the next login: their sessions are revoked.
        if (($data['status'] ?? null) === 'suspended') {
            \App\Models\UserSession::where('user_id', $user->id)->whereNull('revoked_at')
                ->update(['revoked_at' => now()]);
        }

        return response()->json(['data' => [
            'id' => $user->id,
            'status' => $user->status,
            'isSuperAdmin' => (bool) $user->is_super_admin,
        ]]);
    }

    /** 404 — not 403 — for non-staff, so the console does not confirm its own existence. */
    private function guard(Request $request): User
    {
        /** @var User|null $user */
        $user = $request->attributes->get('auth_user');
        if (! $user || ! $user->is_super_admin) {
            throw ApiException::notFound('Not found.');
        }

        return $user;
    }
}

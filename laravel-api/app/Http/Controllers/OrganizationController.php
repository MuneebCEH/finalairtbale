<?php

namespace App\Http\Controllers;

use App\Models\Organization;
use App\Models\OrganizationMember;
use App\Models\User;
use App\Support\Permissions;
use App\Support\TenantContext;
use Illuminate\Http\Request;
use Illuminate\Support\Carbon;
use Illuminate\Support\Str;

class OrganizationController extends Controller
{
    /** POST /v1/organizations — creates an org and makes the caller its owner. */
    public function create(Request $request)
    {
        $this->strict($request, ['name', 'slug']);
        $data = $request->validate([
            'name' => ['required', 'string', 'min:1', 'max:120'],
            'slug' => ['sometimes', 'string', 'max:48', 'regex:/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/'],
        ]);

        /** @var User $user */
        $user = $request->attributes->get('auth_user');

        $org = Organization::create([
            'name' => $data['name'],
            'slug' => $this->uniqueSlug($data['slug'] ?? Str::slug($data['name'])),
            'plan' => 'free',
            'status' => 'active',
        ]);

        OrganizationMember::create([
            'organization_id' => $org->id,
            'user_id' => $user->id,
            'role' => 'owner',
            'status' => 'active',
            'joined_at' => Carbon::now(),
        ]);

        return response()->json([
            'data' => ['id' => $org->id, 'name' => $org->name, 'slug' => $org->slug, 'plan' => $org->plan],
        ], 201);
    }

    /** GET /v1/organizations/{orgId} */
    public function show(Request $request)
    {
        /** @var TenantContext $tenant */
        $tenant = $request->attributes->get('tenant');
        Permissions::authorize($tenant, 'organization:read');

        $org = Organization::findOrFail($tenant->organizationId);

        return response()->json(['data' => $this->orgDto($org, $tenant->orgRole())]);
    }

    /** GET /v1/organizations/{orgId}/members */
    public function listMembers(Request $request)
    {
        /** @var TenantContext $tenant */
        $tenant = $request->attributes->get('tenant');
        Permissions::authorize($tenant, 'member:read');

        $members = OrganizationMember::with('user')
            ->where('organization_id', $tenant->organizationId)
            ->orderBy('joined_at')
            ->get()
            ->map(fn (OrganizationMember $m) => [
                'id' => $m->id,
                'userId' => $m->user_id,
                'email' => $m->user?->email,
                'name' => $m->user?->name,
                'role' => $m->role,
                'status' => $m->status,
                'joinedAt' => $m->joined_at?->copy()->utc()->format('Y-m-d\TH:i:s.v\Z'),
            ])
            ->all();

        return response()->json(['data' => $members]);
    }

    private const ASSIGNABLE_ROLES = ['owner', 'admin', 'editor', 'viewer'];

    /**
     * POST /v1/organizations/{orgId}/members — add a member, creating the user account on the
     * spot when the email is new. Shared hosting cannot send reliable invite emails, so the
     * owner/admin sets the person's first password and hands it over — the person can change it
     * from Settings afterwards. Only an owner may mint another owner.
     */
    public function createMember(Request $request)
    {
        /** @var TenantContext $tenant */
        $tenant = $request->attributes->get('tenant');
        Permissions::authorize($tenant, 'member:manage');

        $data = $request->validate([
            'name' => ['required', 'string', 'min:1', 'max:120'],
            'email' => ['required', 'email', 'max:254'],
            'password' => ['sometimes', 'nullable', 'string', 'min:8', 'max:256'],
            'role' => ['required', 'string', 'in:'.implode(',', self::ASSIGNABLE_ROLES)],
        ]);

        if ($data['role'] === 'owner' && $tenant->orgRole() !== 'owner') {
            throw new \App\Exceptions\ApiException('FORBIDDEN', 'Only an owner can add another owner.');
        }

        $user = User::whereRaw('LOWER(email) = ?', [mb_strtolower($data['email'])])->first();
        if (! $user) {
            if (empty($data['password'])) {
                throw new \App\Exceptions\ApiException('MALFORMED_REQUEST', 'A password is required when creating a new account.');
            }
            $user = User::create([
                'email' => mb_strtolower($data['email']),
                'name' => $data['name'],
                'password_hash' => \Illuminate\Support\Facades\Hash::make($data['password']),
                'status' => 'active',
                // Verified on creation: the admin vouches for the address; there is no mail pipe.
                'email_verified_at' => Carbon::now(),
            ]);
        }

        $existing = OrganizationMember::where('organization_id', $tenant->organizationId)
            ->where('user_id', $user->id)->first();
        if ($existing) {
            throw new \App\Exceptions\ApiException('DUPLICATE_RESOURCE', 'That person is already a member of this organization.');
        }

        OrganizationMember::create([
            'organization_id' => $tenant->organizationId,
            'user_id' => $user->id,
            'role' => $data['role'],
            'status' => 'active',
            'joined_at' => Carbon::now(),
        ]);

        return response()->json(['data' => [
            'userId' => $user->id,
            'email' => $user->email,
            'name' => $user->name,
            'role' => $data['role'],
        ]], 201);
    }

    /** PATCH /v1/organizations/{orgId}/members/{userId} — change a member's role. */
    public function updateMember(Request $request, string $orgId, string $userId)
    {
        /** @var TenantContext $tenant */
        $tenant = $request->attributes->get('tenant');
        Permissions::authorize($tenant, 'member:manage');

        $data = $request->validate([
            'role' => ['required', 'string', 'in:'.implode(',', self::ASSIGNABLE_ROLES)],
        ]);

        $member = OrganizationMember::where('organization_id', $tenant->organizationId)
            ->where('user_id', $userId)->first();
        if (! $member) {
            throw \App\Exceptions\ApiException::notFound('Member not found.');
        }

        // Owners are only touched by owners — an admin must not be able to demote the owner.
        if (($member->role === 'owner' || $data['role'] === 'owner') && $tenant->orgRole() !== 'owner') {
            throw new \App\Exceptions\ApiException('FORBIDDEN', 'Only an owner can change owner roles.');
        }
        if ($member->role === 'owner' && $data['role'] !== 'owner' && $this->ownerCount($tenant->organizationId) <= 1) {
            throw new \App\Exceptions\ApiException('MALFORMED_REQUEST', 'An organization needs at least one owner.');
        }

        $member->forceFill(['role' => $data['role']])->save();

        return response()->json(['data' => ['userId' => $userId, 'role' => $data['role']]]);
    }

    /** DELETE /v1/organizations/{orgId}/members/{userId} — remove a member (never the last owner). */
    public function removeMember(Request $request, string $orgId, string $userId)
    {
        /** @var TenantContext $tenant */
        $tenant = $request->attributes->get('tenant');
        Permissions::authorize($tenant, 'member:manage');

        $member = OrganizationMember::where('organization_id', $tenant->organizationId)
            ->where('user_id', $userId)->first();
        if (! $member) {
            throw \App\Exceptions\ApiException::notFound('Member not found.');
        }
        if ($member->role === 'owner') {
            if ($tenant->orgRole() !== 'owner') {
                throw new \App\Exceptions\ApiException('FORBIDDEN', 'Only an owner can remove an owner.');
            }
            if ($this->ownerCount($tenant->organizationId) <= 1) {
                throw new \App\Exceptions\ApiException('MALFORMED_REQUEST', 'An organization needs at least one owner.');
            }
        }

        $member->delete();

        return response()->noContent();
    }

    private function ownerCount(string $orgId): int
    {
        return OrganizationMember::where('organization_id', $orgId)
            ->where('role', 'owner')->where('status', 'active')->count();
    }

    private function orgDto(Organization $org, ?string $role = null): array
    {
        return [
            'id' => $org->id,
            'name' => $org->name,
            'slug' => $org->slug,
            'logoUrl' => $org->logo_url,
            'brandColor' => $org->brand_color,
            'plan' => $org->plan,
            'status' => $org->status,
            'region' => $org->region,
            'role' => $role,
            'createdAt' => $org->created_at?->copy()->utc()->format('Y-m-d\TH:i:s.v\Z'),
        ];
    }

    private function uniqueSlug(string $base): string
    {
        $base = Str::slug($base) ?: 'org';
        $slug = $base;
        $n = 1;
        while (Organization::where('slug', $slug)->exists()) {
            $slug = $base.'-'.(++$n);
        }

        return Str::limit($slug, 48, '');
    }

    private function strict(Request $request, array $allowed): void
    {
        $unknown = array_diff(array_keys($request->all()), $allowed);
        if (! empty($unknown)) {
            throw \App\Exceptions\ApiException::validation(array_map(
                fn ($key) => ['path' => $key, 'code' => 'unrecognized_keys', 'message' => 'unexpected property'],
                array_values($unknown),
            ));
        }
    }
}

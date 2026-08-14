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

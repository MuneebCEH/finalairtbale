<?php

namespace App\Http\Controllers;

use App\Exceptions\ApiException;
use App\Models\OrganizationMember;
use App\Models\User;
use Illuminate\Http\Request;

/**
 * GET/PATCH /v1/me — the current authenticated user. Protected by the `session` middleware.
 */
class MeController extends Controller
{
    public function show(Request $request)
    {
        /** @var User $user */
        $user = $request->attributes->get('auth_user');

        return response()->json(['data' => $user->toPublicArray()]);
    }

    public function update(Request $request)
    {
        $this->strict($request, ['name', 'timezone', 'locale', 'theme', 'notificationPreferences']);
        $validated = $request->validate([
            'name' => ['sometimes', 'string', 'min:1', 'max:120'],
            'timezone' => ['sometimes', 'string', 'timezone'],
            'locale' => ['sometimes', 'string', 'regex:/^[a-z]{2}(-[A-Z]{2})?$/'],
            'theme' => ['sometimes', 'in:light,dark,system'],
            'notificationPreferences' => ['sometimes', 'array'],
        ]);

        /** @var User $user */
        $user = $request->attributes->get('auth_user');

        $attrs = [];
        foreach (['name', 'timezone', 'locale', 'theme'] as $field) {
            if (array_key_exists($field, $validated)) {
                $attrs[$field] = $validated[$field];
            }
        }

        // Notification preferences are merged, not replaced, so omitting a key cannot clear it.
        if (array_key_exists('notificationPreferences', $validated)) {
            $attrs['notification_preferences'] = array_merge(
                (array) ($user->notification_preferences ?? []),
                $validated['notificationPreferences'],
            );
        }

        if (! empty($attrs)) {
            $user->forceFill($attrs)->save();
        }

        return response()->json(['data' => $user->fresh()->toPublicArray()]);
    }

    /**
     * GET /v1/me/organizations — the orgs the caller belongs to. Derived from membership, so it is
     * the one place it is safe to read across tenants: it can only ever return the caller's own.
     */
    public function organizations(Request $request)
    {
        /** @var User $user */
        $user = $request->attributes->get('auth_user');

        $rows = OrganizationMember::with('organization')
            ->where('user_id', $user->id)
            ->where('status', 'active')
            ->get()
            ->filter(fn (OrganizationMember $m) => $m->organization !== null && $m->organization->deleted_at === null)
            ->map(fn (OrganizationMember $m) => [
                'id' => $m->organization->id,
                'name' => $m->organization->name,
                'slug' => $m->organization->slug,
                'logoUrl' => $m->organization->logo_url,
                'plan' => $m->organization->plan,
                'status' => $m->organization->status,
                'role' => $m->role,
                'joinedAt' => $m->joined_at?->copy()->utc()->format('Y-m-d\TH:i:s.v\Z'),
            ])
            ->values()
            ->all();

        return response()->json(['data' => $rows]);
    }

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
}

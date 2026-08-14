<?php

namespace App\Http\Controllers;

use App\Exceptions\ApiException;
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

<?php

namespace Database\Seeders;

use App\Models\User;
use Illuminate\Database\Seeder;
use Illuminate\Support\Carbon;
use Illuminate\Support\Facades\Hash;

/**
 * Demo accounts, matching the NestJS seed (README "Seeded accounts"). Password for all:
 * Demo!Passw0rd. Organizations/workspaces/memberships arrive with Phase 3 — for now these exist
 * so the login flow can be exercised end to end against MySQL.
 */
class DatabaseSeeder extends Seeder
{
    public function run(): void
    {
        $password = Hash::make('Demo!Passw0rd');
        $now = Carbon::now();

        $accounts = [
            ['email' => 'owner@demo.tessera.local',  'name' => 'Amara Okafor'],
            ['email' => 'editor@demo.tessera.local', 'name' => 'Ravi Patel'],
            ['email' => 'viewer@demo.tessera.local', 'name' => 'Mei Lin'],
            ['email' => 'guest@external.local',       'name' => 'Guest User'],
            ['email' => 'owner@rival.tessera.local',  'name' => 'Diego Fernandez'],
        ];

        foreach ($accounts as $account) {
            User::updateOrCreate(
                ['email' => $account['email']],
                [
                    'name' => $account['name'],
                    'password_hash' => $password,
                    'email_verified_at' => $now,
                    'status' => 'active',
                    'timezone' => 'Europe/London',
                    'locale' => 'en',
                    'theme' => 'system',
                ],
            );
        }
    }
}

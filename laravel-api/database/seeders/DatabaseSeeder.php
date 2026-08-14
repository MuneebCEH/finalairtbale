<?php

namespace Database\Seeders;

use App\Models\Organization;
use App\Models\OrganizationMember;
use App\Models\User;
use App\Models\Workspace;
use App\Models\WorkspaceMember;
use Illuminate\Database\Seeder;
use Illuminate\Support\Carbon;
use Illuminate\Support\Facades\Hash;

/**
 * Demo data mirroring the NestJS seed (README "Seeded accounts"). Two organizations exist so that
 * tenant isolation is observable: the Northwind owner cannot reach anything in Meridian, and vice
 * versa. Password for every account: Demo!Passw0rd.
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
        $users = [];
        foreach ($accounts as $a) {
            $users[$a['email']] = User::updateOrCreate(['email' => $a['email']], [
                'name' => $a['name'],
                'password_hash' => $password,
                'email_verified_at' => $now,
                'status' => 'active',
                'timezone' => 'Europe/London',
                'locale' => 'en',
                'theme' => 'system',
            ]);
        }

        // ── Northwind Logistics ─────────────────────────────────────────────
        $northwind = Organization::updateOrCreate(['slug' => 'northwind-logistics'], [
            'name' => 'Northwind Logistics',
            'plan' => 'free',
            'status' => 'active',
        ]);
        $this->member($northwind, $users['owner@demo.tessera.local'], 'owner', $now);
        $this->member($northwind, $users['editor@demo.tessera.local'], 'member', $now);
        $this->member($northwind, $users['viewer@demo.tessera.local'], 'member', $now);

        $ops = $this->workspace($northwind, 'Operations', $users['owner@demo.tessera.local'], 0);
        $sales = $this->workspace($northwind, 'Sales', $users['owner@demo.tessera.local'], 1);

        // The editor and viewer only belong to Operations — Sales must stay invisible to them.
        $this->workspaceMember($ops, $users['editor@demo.tessera.local'], 'editor');
        $this->workspaceMember($ops, $users['viewer@demo.tessera.local'], 'viewer');

        // ── Meridian (the isolation counterparty) ───────────────────────────
        $meridian = Organization::updateOrCreate(['slug' => 'meridian'], [
            'name' => 'Meridian',
            'plan' => 'free',
            'status' => 'active',
        ]);
        $this->member($meridian, $users['owner@rival.tessera.local'], 'owner', $now);
        $this->workspace($meridian, 'Field Teams', $users['owner@rival.tessera.local'], 0);

        // guest@external.local intentionally belongs to no organization.
    }

    private function member(Organization $org, User $user, string $role, Carbon $now): void
    {
        OrganizationMember::updateOrCreate(
            ['organization_id' => $org->id, 'user_id' => $user->id],
            ['role' => $role, 'status' => 'active', 'joined_at' => $now],
        );
    }

    private function workspace(Organization $org, string $name, User $creator, int $position): Workspace
    {
        $existing = Workspace::where('organization_id', $org->id)->where('name', $name)->first();
        if ($existing) {
            return $existing;
        }

        $workspace = Workspace::create([
            'organization_id' => $org->id,
            'name' => $name,
            'position' => $position,
            'created_by_id' => $creator->id,
        ]);
        // The creator owns the workspace.
        $this->workspaceMember($workspace, $creator, 'owner');

        return $workspace;
    }

    private function workspaceMember(Workspace $workspace, User $user, string $role): void
    {
        WorkspaceMember::updateOrCreate(
            ['workspace_id' => $workspace->id, 'user_id' => $user->id],
            ['organization_id' => $workspace->organization_id, 'role' => $role],
        );
    }
}

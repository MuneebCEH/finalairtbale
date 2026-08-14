<?php

namespace App\Support;

use App\Models\OrganizationMember;
use App\Models\User;

/**
 * The resolved tenant for a request: the organization the caller is acting in, and the membership
 * (hence role) that proves they may. Constructed only by ResolveTenant, and only from a membership
 * that actually exists — this is the application-layer replacement for Postgres row-level security.
 */
final class TenantContext
{
    public function __construct(
        public readonly string $organizationId,
        public readonly User $user,
        public readonly OrganizationMember $member,
    ) {
    }

    public function userId(): string
    {
        return $this->user->id;
    }

    public function orgRole(): string
    {
        return $this->member->role;
    }

    /** Org owners and admins see everything in the tenant; everyone else sees only their grants. */
    public function seesWholeOrg(): bool
    {
        return in_array($this->member->role, ['owner', 'admin'], true);
    }
}

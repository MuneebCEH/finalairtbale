import type { MembershipSnapshot } from '@tessera/permissions';
import type { OrganizationRole, Plan, WorkspaceRole } from '@tessera/types';

import type { Db } from '../client';

/**
 * Builds the `MembershipSnapshot` the policy engine evaluates against.
 *
 * The policy engine is pure; this is the one place that does the I/O. Keeping the two separate
 * means authorization logic is exhaustively unit-testable without a database, and the expensive
 * part (this loader) can be cached aggressively without complicating the rules.
 *
 * The snapshot deliberately resolves **group-derived roles into the same maps as direct roles**.
 * The policy engine therefore never has to know that groups exist, and a role granted through a
 * group is indistinguishable from a direct grant at decision time — which is exactly the
 * semantics an administrator expects.
 */
export interface LoadMembershipInput {
  readonly organizationId: string;
  readonly userId: string | null;
}

export class MembershipLoader {
  constructor(private readonly db: Db) {}

  async load(input: LoadMembershipInput): Promise<MembershipSnapshot> {
    const { organizationId, userId } = input;

    const organization = await this.db.organization.findUnique({
      where: { id: organizationId },
      select: { id: true, plan: true, status: true, settings: true },
    });

    if (!organization) {
      // An unknown organization is reported as "not a member" rather than "does not exist".
      return emptySnapshot(organizationId);
    }

    const base = {
      organizationId,
      plan: organization.plan as Plan,
      organizationSuspended: organization.status !== 'active',
      organizationSettings: (organization.settings ?? {}) as Record<string, boolean>,
    };

    if (!userId) {
      return {
        ...base,
        userSuspended: false,
        organizationRole: null,
        workspaceRoles: {},
        baseRoles: {},
        explicitDenies: [],
      };
    }

    const [membership, groupIds] = await Promise.all([
      this.db.organizationMember.findUnique({
        where: { organizationId_userId: { organizationId, userId } },
        select: { role: true, status: true },
      }),
      this.db.organizationGroupMember
        .findMany({ where: { userId }, select: { groupId: true } })
        .then((rows) => rows.map((r) => r.groupId)),
    ]);

    if (!membership) {
      return {
        ...base,
        userSuspended: false,
        organizationRole: null,
        workspaceRoles: {},
        baseRoles: {},
        explicitDenies: [],
      };
    }

    const [workspaceMemberships, baseMemberships] = await Promise.all([
      this.db.workspaceMember.findMany({
        where: {
          organizationId,
          OR: [{ userId }, ...(groupIds.length ? [{ groupId: { in: groupIds } }] : [])],
        },
        select: { workspaceId: true, role: true, userId: true },
      }),
      this.db.baseMember.findMany({
        where: {
          organizationId,
          OR: [{ userId }, ...(groupIds.length ? [{ groupId: { in: groupIds } }] : [])],
        },
        select: { baseId: true, role: true, userId: true },
      }),
    ]);

    return {
      ...base,
      userSuspended: membership.status !== 'active',
      organizationRole: membership.role as OrganizationRole,
      workspaceRoles: mergeRoles(
        workspaceMemberships.map((m) => ({
          key: m.workspaceId,
          role: m.role as WorkspaceRole,
          direct: m.userId !== null,
        })),
      ),
      baseRoles: mergeRoles(
        baseMemberships.map((m) => ({
          key: m.baseId,
          role: m.role as WorkspaceRole,
          direct: m.userId !== null,
        })),
      ),
      explicitDenies: [],
    };
  }
}

/**
 * When a user reaches the same resource through several paths (a direct grant plus one or more
 * groups), the **most permissive** role wins, and a direct grant beats a group grant of equal
 * rank. Taking the union is the behaviour administrators expect: adding somebody to a group
 * should never silently reduce access they were granted individually.
 */
const RANK: Record<WorkspaceRole, number> = {
  guest: 0,
  viewer: 1,
  commenter: 2,
  editor: 3,
  creator: 4,
  owner: 5,
};

function mergeRoles(
  entries: ReadonlyArray<{ key: string; role: WorkspaceRole; direct: boolean }>,
): Record<string, WorkspaceRole> {
  const out: Record<string, WorkspaceRole> = {};
  for (const entry of entries) {
    const existing = out[entry.key];
    if (existing === undefined || RANK[entry.role] > RANK[existing]) {
      out[entry.key] = entry.role;
    }
  }
  return out;
}

function emptySnapshot(organizationId: string): MembershipSnapshot {
  return {
    organizationId,
    plan: 'free',
    organizationSuspended: false,
    userSuspended: false,
    organizationRole: null,
    organizationSettings: {},
    workspaceRoles: {},
    baseRoles: {},
    explicitDenies: [],
  };
}

/**
 * Development seed.
 *
 * Produces a workspace that actually looks like somebody has been using it — two organizations
 * with overlapping membership, so tenant isolation is visible the moment you sign in rather than
 * something you have to construct by hand every time.
 *
 * Refuses to run against anything that is not obviously a local database. A seed script that can
 * be pointed at production by a mistyped environment variable is a loaded weapon; the guard is
 * three lines.
 */

import { hash } from '@node-rs/argon2';
import { PrismaClient } from '@prisma/client';
import { ulid } from 'ulid';

const prisma = new PrismaClient();

const DEMO_PASSWORD = 'Demo!Passw0rd';

function id(prefix: string): string {
  return `${prefix}_${ulid()}`;
}

function assertSafeTarget(): void {
  const url = process.env['DATABASE_URL'] ?? '';
  const allowUnsafe = process.env['ALLOW_UNSAFE_SEED'] === 'true';
  const looksLocal = /@(localhost|127\.0\.0\.1|postgres|db)[:/]/.test(url);

  if (process.env['NODE_ENV'] === 'production' && !allowUnsafe) {
    throw new Error('Refusing to seed: NODE_ENV is production.');
  }
  if (!looksLocal && !allowUnsafe) {
    throw new Error(
      `Refusing to seed: DATABASE_URL does not point at a local host. ` +
        `Set ALLOW_UNSAFE_SEED=true if you are certain.`,
    );
  }
}

const DEFAULT_SETTINGS = {
  memberCanCreateWorkspaces: true,
  memberCanInvite: false,
  guestCanInvite: false,
  allowPublicSharing: true,
  allowPublicForms: true,
  allowExports: true,
  allowApiAccess: true,
  requireTwoFactor: false,
  sessionTimeoutHours: 720,
  approvedEmailDomains: [],
  shareLinkDomainAllowlist: [],
  defaultWorkspaceRole: 'editor',
  retentionDays: null,
};

async function main(): Promise<void> {
  assertSafeTarget();

  const passwordHash = await hash(DEMO_PASSWORD, {
    memoryCost: 19_456,
    timeCost: 2,
    parallelism: 1,
  });

  // ── People ───────────────────────────────────────────────────────────────
  const people = [
    { key: 'owner', email: 'owner@demo.tessera.local', name: 'Amara Okafor' },
    { key: 'editor', email: 'editor@demo.tessera.local', name: 'Rohan Mehta' },
    { key: 'viewer', email: 'viewer@demo.tessera.local', name: 'Sofia Lindqvist' },
    { key: 'guest', email: 'guest@external.local', name: 'Tomás Ferreira' },
    { key: 'rival', email: 'owner@rival.tessera.local', name: 'Kenji Watanabe' },
  ] as const;

  const users: Record<string, string> = {};

  for (const person of people) {
    const existing = await prisma.user.findFirst({ where: { email: person.email } });
    if (existing) {
      users[person.key] = existing.id;
      continue;
    }
    const created = await prisma.user.create({
      data: {
        id: id('usr'),
        email: person.email,
        name: person.name,
        passwordHash,
        emailVerifiedAt: new Date(),
        timezone: 'Europe/London',
      },
    });
    users[person.key] = created.id;
  }

  // ── Organization one: the demo tenant ────────────────────────────────────
  const northwindId = await upsertOrganization({
    slug: 'northwind',
    name: 'Northwind Logistics',
    plan: 'professional',
    ownerId: users['owner'] as string,
    members: [
      { userId: users['editor'] as string, role: 'member' },
      { userId: users['viewer'] as string, role: 'member' },
      { userId: users['guest'] as string, role: 'guest' },
    ],
  });

  await upsertWorkspace(northwindId, 'Operations', users['owner'] as string, [
    { userId: users['editor'] as string, role: 'editor' },
    { userId: users['viewer'] as string, role: 'viewer' },
  ]);

  await upsertWorkspace(northwindId, 'Finance', users['owner'] as string, [
    // Deliberately excludes the editor, so "a member who cannot see every workspace" is the
    // default state you observe rather than something you have to set up.
    { userId: users['viewer'] as string, role: 'commenter' },
  ]);

  // ── Organization two: the isolation counterparty ─────────────────────────
  // Nobody from Northwind is a member here. Signing in as the Northwind owner and trying to
  // reach anything below should produce a 404 — the check that matters most, made visible.
  const rivalId = await upsertOrganization({
    slug: 'meridian',
    name: 'Meridian Freight',
    plan: 'free',
    ownerId: users['rival'] as string,
    members: [],
  });

  await upsertWorkspace(rivalId, 'Confidential', users['rival'] as string, []);

  // eslint-disable-next-line no-console
  console.log(
    [
      '',
      'Seed complete.',
      '',
      `  Password for every demo account: ${DEMO_PASSWORD}`,
      '',
      '  Northwind Logistics (professional)',
      '    owner@demo.tessera.local    organization owner',
      '    editor@demo.tessera.local   member, editor on Operations only',
      '    viewer@demo.tessera.local   member, viewer on Operations, commenter on Finance',
      '    guest@external.local        guest, no workspace access until granted',
      '',
      '  Meridian Freight (free) - the isolation counterparty',
      '    owner@rival.tessera.local   organization owner',
      '',
      '  Nobody from Northwind can see Meridian, and vice versa.',
      '',
    ].join('\n'),
  );
}

async function upsertOrganization(input: {
  slug: string;
  name: string;
  plan: string;
  ownerId: string;
  members: Array<{ userId: string; role: string }>;
}): Promise<string> {
  const existing = await prisma.organization.findUnique({ where: { slug: input.slug } });
  if (existing) return existing.id;

  const organizationId = id('org');

  await prisma.$transaction(async (tx) => {
    await tx.organization.create({
      data: {
        id: organizationId,
        name: input.name,
        slug: input.slug,
        plan: input.plan,
        settings: DEFAULT_SETTINGS as never,
      },
    });

    await tx.organizationMember.create({
      data: { id: id('usr'), organizationId, userId: input.ownerId, role: 'owner' },
    });

    for (const member of input.members) {
      await tx.organizationMember.create({
        data: { id: id('usr'), organizationId, userId: member.userId, role: member.role },
      });
    }

    await tx.organizationGroup.create({
      data: {
        id: id('grp'),
        organizationId,
        name: 'Everyone',
        description: 'All members of this organization.',
        isSystem: true,
        createdById: input.ownerId,
      },
    });

    await tx.subscription.create({
      data: {
        id: id('org'),
        organizationId,
        plan: input.plan,
        status: 'active',
        seats: input.members.length + 1,
      },
    });
  });

  return organizationId;
}

async function upsertWorkspace(
  organizationId: string,
  name: string,
  ownerId: string,
  members: Array<{ userId: string; role: string }>,
): Promise<string> {
  const existing = await prisma.workspace.findFirst({ where: { organizationId, name } });
  if (existing) return existing.id;

  const workspaceId = id('wsp');

  await prisma.$transaction(async (tx) => {
    await tx.workspace.create({
      data: { id: workspaceId, organizationId, name, createdById: ownerId },
    });

    await tx.workspaceMember.create({
      data: {
        id: id('wsp'),
        organizationId,
        workspaceId,
        userId: ownerId,
        role: 'owner',
        addedById: ownerId,
      },
    });

    for (const member of members) {
      await tx.workspaceMember.create({
        data: {
          id: id('wsp'),
          organizationId,
          workspaceId,
          userId: member.userId,
          role: member.role,
          addedById: ownerId,
        },
      });
    }
  });

  return workspaceId;
}

main()
  .catch((error: unknown) => {
    // eslint-disable-next-line no-console
    console.error('Seed failed:', error);
    process.exit(1);
  })
  .finally(() => {
    void prisma.$disconnect();
  });

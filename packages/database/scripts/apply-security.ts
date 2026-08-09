/**
 * Applies `prisma/sql/security.sql`.
 *
 * Kept out of the Prisma migration chain on purpose. Prisma checksums its migration files, so a
 * hand-written policy file living among them makes every future `prisma migrate dev` a conflict.
 * These statements are also idempotent by construction, which a migration is not required to be
 * — so running this after every deploy is safe, and that is what the deployment does.
 *
 * Executed through `pg` rather than Prisma's `$executeRawUnsafe`: Prisma sends raw SQL over the
 * extended query protocol, which permits exactly one command per statement, and this file is a
 * multi-command script containing `DO $$ ... $$` blocks that must not be split. `pg`'s simple
 * query protocol runs the whole script as one unit, which is what the script requires.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { Client } from 'pg';

async function main(): Promise<void> {
  const databaseUrl = process.env['DATABASE_URL'];
  if (!databaseUrl) {
    throw new Error('DATABASE_URL is not set.');
  }

  const path = join(__dirname, '..', 'prisma', 'sql', 'security.sql');
  const sql = readFileSync(path, 'utf8');

  const client = new Client({ connectionString: databaseUrl });
  await client.connect();

  try {
    await client.query(sql);
    // eslint-disable-next-line no-console
    console.log('Security policies, indexes, and constraints applied.');
  } finally {
    await client.end();
  }
}

main().catch((error: unknown) => {
  // eslint-disable-next-line no-console
  console.error('Failed to apply security policies:', error);
  process.exit(1);
});

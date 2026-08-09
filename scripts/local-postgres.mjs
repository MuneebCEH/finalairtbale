/**
 * Portable PostgreSQL for machines without Docker.
 *
 * Docker Compose remains the documented path (infra/compose/docker-compose.yml) and is what CI
 * and every deployed environment use. This exists for a developer laptop where Docker Desktop
 * is not installed or cannot be — it downloads a self-contained PostgreSQL build through npm and
 * runs it as an ordinary user process, no installer and no administrator rights.
 *
 *   node scripts/local-postgres.mjs start   # boots on 5432 and stays in the foreground
 *   node scripts/local-postgres.mjs stop    # stops a previously started instance
 *   node scripts/local-postgres.mjs reset   # deletes the data directory and starts fresh
 *
 * The data directory lives under .local/postgres, which is gitignored, so the database survives
 * restarts but never reaches the repository.
 */

import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import EmbeddedPostgres from 'embedded-postgres';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const dataDir = join(root, '.local', 'postgres');

const CONFIG = {
  databaseDir: dataDir,
  user: 'tessera',
  password: 'tessera',
  port: 5432,
  persistent: true,
  // Matches the Compose stack, so sort order and collation behave identically whichever way a
  // developer runs the database. Locale differences silently change ORDER BY results.
  initdbFlags: ['--encoding=UTF8', '--locale=C'],
};

const command = process.argv[2] ?? 'start';

async function start({ fresh = false } = {}) {
  if (fresh && existsSync(dataDir)) {
    console.log('Removing existing data directory...');
    rmSync(dataDir, { recursive: true, force: true });
  }

  mkdirSync(dataDir, { recursive: true });

  const postgres = new EmbeddedPostgres(CONFIG);
  const initialised = existsSync(join(dataDir, 'PG_VERSION'));

  if (!initialised) {
    console.log('Initialising a new cluster (first run downloads the binaries)...');
    await postgres.initialise();
  }

  console.log('Starting PostgreSQL on port 5432...');
  await postgres.start();

  // `createDatabase` throws if the database already exists, which is the normal case on every
  // run after the first. That is not an error worth stopping for.
  try {
    await postgres.createDatabase('tessera');
    console.log('Created database "tessera".');
  } catch {
    console.log('Database "tessera" already present.');
  }

  console.log('');
  console.log('  PostgreSQL is ready.');
  console.log('  DATABASE_URL=postgresql://tessera:tessera@localhost:5432/tessera?schema=public');
  console.log('');
  console.log('  Leave this process running. Press Ctrl+C to stop.');
  console.log('');

  const shutdown = async (signal) => {
    console.log(`\nReceived ${signal}, stopping PostgreSQL...`);
    await postgres.stop().catch(() => undefined);
    process.exit(0);
  };

  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));

  // Holds the event loop open so the server keeps running in the foreground.
  await new Promise(() => {});
}

async function stop() {
  const postgres = new EmbeddedPostgres(CONFIG);
  await postgres.stop().catch(() => undefined);
  console.log('PostgreSQL stopped.');
}

switch (command) {
  case 'start':
    await start();
    break;
  case 'reset':
    await start({ fresh: true });
    break;
  case 'stop':
    await stop();
    break;
  default:
    console.error(`Unknown command "${command}". Use start, stop, or reset.`);
    process.exit(1);
}

/**
 * Packages the app for a cPanel "Setup Node.js App" deployment.
 *
 * Shared hosting cannot usually build Next.js — the build wants more memory than such plans
 * allow — so the build happens here and only its output is uploaded. That is also why this
 * exists as a script rather than a list of steps in a document: a deploy assembled by hand is a
 * deploy that is subtly different every time.
 *
 * Produces two folders under `dist-cpanel/`, one per cPanel application:
 *
 *   api/  — the NestJS server, its production dependencies, and the Prisma client
 *   web/  — the Next.js standalone server, its static assets and public files
 *
 * Run `npm run build` first. This only collects; it does not compile.
 */

import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const out = join(root, 'dist-cpanel');

function require_(path, what) {
  if (!existsSync(path)) {
    console.error(`Missing ${what}: ${path}`);
    console.error('Run `npm run build` first (and `npx next build` in apps/web).');
    process.exit(1);
  }
}

require_(join(root, 'apps/api/dist/main.js'), 'the API build');
require_(join(root, 'apps/web/.next/standalone'), 'the web standalone build');

rmSync(out, { recursive: true, force: true });

// ── API ─────────────────────────────────────────────────────────────────────
const api = join(out, 'api');
mkdirSync(api, { recursive: true });

cpSync(join(root, 'apps/api/dist'), join(api, 'dist'), { recursive: true });

/*
 * Production dependencies only, installed fresh into the bundle.
 *
 * Copying the workspace `node_modules` wholesale was simpler and produced a gigabyte — every
 * dev dependency in the monorepo, for every package, none of which the server runs. That does
 * not upload to shared hosting.
 *
 * `npm install --omit=dev` against a manifest listing just the API's own dependencies gives the
 * tree the server actually needs. The workspace packages are copied in afterwards as real
 * folders, because they are built locally and have no registry to install from.
 */
const apiManifest = JSON.parse(readFileSync(join(root, 'apps/api/package.json'), 'utf8'));
const external = Object.fromEntries(
  Object.entries(apiManifest.dependencies ?? {}).filter(([name]) => !name.startsWith('@tessera/')),
);

writeFileSync(
  join(api, 'package.json'),
  JSON.stringify(
    { name: 'tessera-api', version: '1.0.0', private: true, main: 'app.js', dependencies: external },
    null,
    2,
  ),
);

console.log('Installing production dependencies...');
execFileSync('npm', ['install', '--omit=dev', '--no-audit', '--no-fund', '--loglevel=error'], {
  cwd: api,
  stdio: 'inherit',
  shell: process.platform === 'win32',
});

// The workspace packages, as real directories. Only their build output and manifest travel —
// their sources and tests are not what the server loads.
for (const name of Object.keys(apiManifest.dependencies ?? {}).filter((n) => n.startsWith('@tessera/'))) {
  const short = name.replace('@tessera/', '');
  const from = join(root, 'packages', short);
  const to = join(api, 'node_modules', name);
  mkdirSync(to, { recursive: true });
  cpSync(join(from, 'dist'), join(to, 'dist'), { recursive: true, dereference: true });
  cpSync(join(from, 'package.json'), join(to, 'package.json'));
}

// The generated Prisma client, and the schema the client resolves against at runtime.
cpSync(join(root, 'node_modules/@prisma/client'), join(api, 'node_modules/@prisma/client'), {
  recursive: true,
  dereference: true,
});

// The generated Prisma client lives outside node_modules/@prisma and is easy to leave behind.
if (existsSync(join(root, 'node_modules/.prisma'))) {
  cpSync(join(root, 'node_modules/.prisma'), join(api, 'node_modules/.prisma'), { recursive: true });
}

cpSync(join(root, 'packages/database/prisma'), join(api, 'prisma'), { recursive: true });

// Passenger looks for the entry point named in cPanel's "Application startup file". Pointing it
// straight at dist/main.js works, but this wrapper gives one place to fail loudly when the
// environment is not configured — which beats a stack trace from deep inside the framework.
writeFileSync(
  join(api, 'app.js'),
  `// cPanel entry point for the Tessera API.
//
// Checked before anything is imported: a missing DATABASE_URL otherwise surfaces as a Prisma
// error several seconds into boot, which reads as a database problem rather than a missing
// variable in the cPanel panel.
// The names come from packages/config/src/env.ts. Guessing them produced a wrapper that
// demanded a variable the app does not use while staying silent about eight it does.
const required = [
  'DATABASE_URL',
  'APP_URL',
  'API_URL',
  'REDIS_URL',
  'REDIS_QUEUE_URL',
  'STORAGE_BUCKET',
  'STORAGE_PUBLIC_URL',
  'SESSION_SECRET',
  'JWT_SECRET',
  'ENCRYPTION_KEY',
];

for (const name of required) {
  if (!process.env[name]) {
    console.error(\`Missing \${name}. Set it under "Environment variables" in cPanel's Node.js app.\`);
    process.exit(1);
  }
}

require('./dist/main.js');
`,
);

// ── Web ─────────────────────────────────────────────────────────────────────
const web = join(out, 'web');
mkdirSync(web, { recursive: true });

// Next's standalone output nests by workspace path; flatten it so cPanel's application root is
// the folder that actually holds server.js.
cpSync(join(root, 'apps/web/.next/standalone'), web, { recursive: true });

// Static assets are deliberately not included in the standalone output — Next expects them to be
// served from a CDN. There is no CDN here, so they have to travel with the server.
cpSync(join(root, 'apps/web/.next/static'), join(web, 'apps/web/.next/static'), { recursive: true });

if (existsSync(join(root, 'apps/web/public'))) {
  cpSync(join(root, 'apps/web/public'), join(web, 'apps/web/public'), { recursive: true });
}

writeFileSync(
  join(web, 'app.js'),
  `// cPanel entry point for the Tessera web app.
//
// The standalone server reads PORT from the environment; Passenger sets it.
require('./apps/web/server.js');
`,
);

const webPackage = JSON.parse(readFileSync(join(web, 'package.json'), 'utf8'));
webPackage.main = 'app.js';
writeFileSync(join(web, 'package.json'), JSON.stringify(webPackage, null, 2));

/*
 * Zipped with `tar`, deliberately, and never with PowerShell's `Compress-Archive`.
 *
 * `Compress-Archive` writes Windows path separators into the archive. The ZIP specification
 * requires forward slashes, so Linux treats `node_modules\@nestjs\common\index.js` as a single
 * filename rather than a path: the extraction reports success and produces several thousand
 * files with backslashes in their names, no directories, and an application that cannot resolve
 * a single dependency. `tar` ships with Windows 10 and writes conforming archives.
 */
for (const name of ['api', 'web']) {
  const archive = join(out, `tessera-${name}.zip`);
  execFileSync('tar', ['-a', '-c', '-f', archive, '.'], {
    cwd: join(out, name),
    stdio: 'inherit',
    shell: process.platform === 'win32',
  });
}

console.log('Built dist-cpanel/');
console.log('  api/  → upload as the application root of the API app');
console.log('  web/  → upload as the application root of the web app');
console.log('');
console.log('Startup file for both: app.js');

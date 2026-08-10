/**
 * Bundles the API into one JavaScript file.
 *
 * Shared hosting turned out to be hostile to a `node_modules` tree: cPanel's archive extractor
 * silently produced empty directories for an eight-thousand-file archive, and `npm install`
 * removes the workspace packages every time it runs, because they are not on any registry. Each
 * failure looked like a different bug and cost a round trip to diagnose.
 *
 * One file has none of those failure modes. There is nothing to extract, nothing for npm to
 * prune, and nothing whose resolution can go wrong.
 *
 * What stays external, and why:
 *
 *   @prisma/client   carries a native query engine chosen at install time for the host platform
 *   @nestjs/*        resolves providers by decorator metadata; bundling breaks that reflection
 *   express, ws,     have optional native paths that esbuild would either inline wrongly or
 *   ioredis, ...     drag in for every platform at once
 *
 * Those come from the registry, which is the one thing shared hosting does reliably. What is
 * bundled is exactly what it could not deliver: this repository's own code.
 */

import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { build } from 'esbuild';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const out = join(root, 'dist-cpanel/api-single');

const manifest = JSON.parse(readFileSync(join(root, 'apps/api/package.json'), 'utf8'));

/**
 * Every registry dependency the API needs, including those reached only through a workspace
 * package.
 *
 * Listing `apps/api`'s own dependencies is not enough: `@node-rs/argon2` arrives through
 * `@tessera/auth` and `@aws-sdk/client-s3` through `@tessera/storage`, so a manifest built from
 * the app alone omits password hashing and attachment storage. Locally that goes unnoticed,
 * because Node walks up and finds them in the repository's root `node_modules` — which is
 * exactly why the first bundle passed a local smoke test and failed on the server.
 */
function collectDependencies() {
  const collected = {};
  const visited = new Set();

  const walk = (name) => {
    const short = name.replace('@tessera/', '');
    const path = join(root, 'packages', short, 'package.json');
    if (visited.has(short) || !existsSync(path)) return;
    visited.add(short);

    const pkg = JSON.parse(readFileSync(path, 'utf8'));
    for (const [dep, version] of Object.entries(pkg.dependencies ?? {})) {
      if (dep.startsWith('@tessera/')) walk(dep);
      else collected[dep] = version;
    }
  };

  for (const [dep, version] of Object.entries(manifest.dependencies ?? {})) {
    if (dep.startsWith('@tessera/')) walk(dep);
    else collected[dep] = version;
  }

  // Pinned rather than inherited: the client and the CLI that generates it must agree, and the
  // generator is what produces an engine matching the host platform.
  collected['@prisma/client'] = '^5.22.0';
  collected['prisma'] = '^5.22.0';

  return Object.fromEntries(Object.entries(collected).sort(([a], [b]) => a.localeCompare(b)));
}

const runtimeDependencies = collectDependencies();

// Everything from the registry stays external. Only `@tessera/*` — which npm cannot install —
// gets inlined, which is the entire point of this build.
const external = Object.keys(runtimeDependencies);

rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });

await build({
  entryPoints: [join(root, 'apps/api/dist/main.js')],
  bundle: true,
  platform: 'node',
  target: 'node20',
  format: 'cjs',
  outfile: join(out, 'server.js'),
  external: [...external, '@prisma/client', '.prisma/client', 'prisma'],
  // Nest reads class metadata at runtime; renaming a class changes what its decorators report
  // and providers stop resolving. Cheaper to keep the names than to debug that.
  keepNames: true,
  logLevel: 'info',
});

cpSync(join(root, 'packages/database/prisma'), join(out, 'prisma'), { recursive: true });

writeFileSync(
  join(out, 'app.js'),
  `// cPanel entry point for the Tessera API.
//
// Checked before the bundle is loaded: a missing variable otherwise surfaces several seconds in,
// as a framework stack trace that says nothing about which setting is absent.
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

const missing = required.filter((name) => !process.env[name]);
if (missing.length > 0) {
  console.error('Missing environment variables: ' + missing.join(', '));
  console.error("Set them under 'Environment variables' in cPanel's Node.js app.");
  process.exit(1);
}

require('./server.js');
`,
);

writeFileSync(
  join(out, 'package.json'),
  JSON.stringify(
    {
      name: 'tessera-api',
      version: '1.0.0',
      private: true,
      main: 'app.js',
      // Generates the Prisma client for whatever platform the server turns out to be. Runs on
      // cPanel's own "Run NPM Install" button, so the engine is never the wrong architecture.
      scripts: { postinstall: 'prisma generate --schema prisma/schema.prisma' },
      dependencies: runtimeDependencies,
    },
    null,
    2,
  ) + '\n',
);

// `tar`, never PowerShell's `Compress-Archive`: the latter writes Windows separators into the
// archive, which Linux reads as part of the filename rather than as a path.
const archive = join(root, 'dist-cpanel/tessera-api-single.zip');
rmSync(archive, { force: true });
// A relative output path, because `tar` reads `D:\...` as a remote host specification and tries
// to resolve `D:` as a hostname.
execFileSync('tar', ['-a', '-c', '-f', '../tessera-api-single.zip', '.'], {
  cwd: out,
  stdio: 'inherit',
  shell: process.platform === 'win32',
});

const size = (path) => `${(readFileSync(path).byteLength / 1024 / 1024).toFixed(2)} MB`;
console.log('');
console.log(`server.js  ${size(join(out, 'server.js'))}`);
console.log(`archive    ${size(archive)}`);
console.log('');
console.log('Upload the archive to the application root, extract, then Run NPM Install.');

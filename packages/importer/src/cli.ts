import { readFileSync } from 'node:fs';

import { AirtableRestSource } from './airtable/rest-source';
import { airtableSnapshotSchema, type AirtableSnapshot } from './airtable/schema';
import { importBase, summarise, type ImportReport } from './runner';
import { createTesseraClient } from './tessera-client';
import { WorkspaceResolver, parseWorkspaceMapping } from './workspaces';

/**
 * Airtable import CLI.
 *
 * Two sources, one loading path:
 *
 *   --snapshot <file>          load a JSON dump taken elsewhere
 *   --pat <token> --base-id X  read directly from Airtable (repeat --base-id, or --all-bases)
 *
 * The live source is read-only by construction — see rest-source.ts. It is also the only source
 * that can fetch attachments, because Airtable's file URLs are signed and expire within hours: a
 * snapshot written to disk carries links that are dead by the time anyone runs it.
 *
 * Defaults are deliberately conservative: without `--limit` or `--all`, only 100 records per
 * table are imported. Pulling a full production dataset into whatever environment this happens
 * to point at should be a decision somebody typed, not a default they inherited.
 */

interface Args {
  snapshot: string | null;
  token: string | null;
  baseIds: string[];
  allBases: boolean;
  workspace: string | null;
  workspaceMap: string | null;
  organization: string | null;
  schemaOnly: boolean;
  withAttachments: boolean;
  limit: number | null;
  baseFilter: string | null;
  apiUrl: string;
  email: string;
  password: string;
}

const USAGE = `Usage:
  --pat <token> --all-bases --workspace-map <file> [options]
  --pat <token> --base-id <id> ... --workspace <id> [options]
  --snapshot <file> --workspace <id> [options]

Destination (exactly one):
  --workspace <id>       put every base in this one workspace
  --workspace-map <file> place each base by the mapping in the file, creating workspaces as
                         needed (see airtable-workspaces.json)

Options:
  --organization <id>    which organization to create workspaces in (default: the only one)
  --schema-only          create tables and fields, import no records
  --with-attachments     download attachment files and re-host them
  --limit N | --all      records per table (default 100)
  --base <name>          only import the base with this name
  --api <url>            Tessera API (default http://localhost:4000)

Environment:
  AIRTABLE_PAT           used when --pat is omitted
  IMPORT_EMAIL / IMPORT_PASSWORD`;

function parseArgs(argv: readonly string[]): Args {
  const get = (flag: string): string | undefined => {
    const index = argv.indexOf(flag);
    return index === -1 ? undefined : argv[index + 1];
  };
  const all = (flag: string): string[] => {
    const out: string[] = [];
    argv.forEach((value, index) => {
      if (value === flag && argv[index + 1]) out.push(argv[index + 1] as string);
    });
    return out;
  };
  const has = (flag: string): boolean => argv.includes(flag);

  const snapshot = get('--snapshot') ?? null;
  const token = get('--pat') ?? process.env['AIRTABLE_PAT'] ?? null;
  const workspace = get('--workspace') ?? null;
  const workspaceMap = get('--workspace-map') ?? null;
  const baseIds = all('--base-id');
  const allBases = has('--all-bases');

  if (!workspace && !workspaceMap) throw new Error(USAGE);
  if (workspace && workspaceMap) {
    throw new Error('Pass either --workspace or --workspace-map, not both.');
  }
  if (!snapshot && !token) throw new Error(USAGE);
  if (snapshot && token) {
    throw new Error('Pass either --snapshot or --pat, not both — they are alternative sources.');
  }
  if (token && baseIds.length === 0 && !allBases) {
    throw new Error('With --pat, name the bases to read with --base-id <id>, or pass --all-bases.');
  }

  return {
    snapshot,
    token,
    baseIds,
    allBases,
    workspace,
    workspaceMap,
    organization: get('--organization') ?? null,
    schemaOnly: has('--schema-only'),
    withAttachments: has('--with-attachments'),
    limit: has('--all') ? null : Number(get('--limit') ?? 100),
    baseFilter: get('--base') ?? null,
    apiUrl: get('--api') ?? process.env['API_URL'] ?? 'http://localhost:4000',
    email: get('--email') ?? process.env['IMPORT_EMAIL'] ?? '',
    password: get('--password') ?? process.env['IMPORT_PASSWORD'] ?? '',
  };
}

/* eslint-disable no-console */

async function loadSource(args: Args): Promise<AirtableSnapshot> {
  if (args.snapshot) {
    if (args.withAttachments) {
      console.warn(
        'Warning: --with-attachments with a snapshot file will only work if the snapshot was\n' +
          '         written within the last few hours. Airtable attachment URLs are signed and\n' +
          '         expire; files whose links have lapsed are reported as skipped, not silently\n' +
          '         dropped. Use --pat for a reliable transfer.\n',
      );
    }
    return airtableSnapshotSchema.parse(JSON.parse(readFileSync(args.snapshot, 'utf8')) as unknown);
  }

  const source = new AirtableRestSource({
    token: args.token as string,
    onProgress: (message) => console.log(message),
  });

  const baseIds = args.allBases ? (await source.listBases()).map((base) => base.id) : args.baseIds;
  console.log(`\nReading ${baseIds.length} base(s) from Airtable (read-only)\n`);

  return source.snapshot(baseIds, {
    ...(args.limit !== null ? { recordLimit: args.limit } : {}),
    schemaOnly: args.schemaOnly,
  });
}

/**
 * Builds the workspace resolver, picking the organization to create workspaces in.
 *
 * With exactly one organization the choice is unambiguous and is made silently. With more than
 * one it must be stated: guessing would scatter a customer's bases into whichever organization
 * happened to sort first.
 */
async function buildResolver(
  client: ReturnType<typeof createTesseraClient>,
  args: Args,
): Promise<WorkspaceResolver> {
  const mapping = parseWorkspaceMapping(
    JSON.parse(readFileSync(args.workspaceMap as string, 'utf8')) as unknown,
  );

  let organizationId = args.organization;
  if (!organizationId) {
    const organizations = await client.listOrganizations();
    if (organizations.length === 0) throw new Error('This account has no organizations.');
    if (organizations.length > 1) {
      throw new Error(
        'This account belongs to several organizations. Name one with --organization <id>:\n' +
          organizations.map((o) => `  ${o.id}  ${o.name}`).join('\n'),
      );
    }
    organizationId = organizations[0]?.id as string;
  }

  return new WorkspaceResolver(client, organizationId, mapping);
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  if (!args.email || !args.password) {
    throw new Error('Set IMPORT_EMAIL and IMPORT_PASSWORD, or pass --email and --password.');
  }

  // The Tessera session is established first: a failure here is instant, and it would be rude to
  // spend several minutes reading Airtable only to discover the destination rejects the login.
  const client = createTesseraClient({
    baseUrl: args.apiUrl,
    email: args.email,
    password: args.password,
  });
  await client.signIn();

  const snapshot = await loadSource(args);

  const bases = args.baseFilter
    ? snapshot.bases.filter((base) => base.name === args.baseFilter)
    : snapshot.bases;

  if (bases.length === 0) {
    throw new Error(`No base matched "${args.baseFilter ?? '(any)'}".`);
  }

  console.log(
    `\nImporting ${bases.length} base(s) from a snapshot taken ${snapshot.takenAt}` +
      `\nMode: ${args.schemaOnly ? 'schema only' : `records capped at ${args.limit ?? 'no limit'} per table`}\n`,
  );

  const resolver = args.workspaceMap ? await buildResolver(client, args) : null;
  const reports: ImportReport[] = [];
  const fellBack: string[] = [];

  for (const base of bases) {
    let workspaceId = args.workspace as string;

    if (resolver) {
      const workspace = await resolver.resolveForBase(base.id);
      workspaceId = workspace.id;
      if (workspace.fallback) fellBack.push(`${base.name} → ${workspace.name}`);
      console.log(
        `\n${base.name} → workspace "${workspace.name}"${workspace.created ? ' (created)' : ''}`,
      );
    }

    const report = await importBase(client, base, snapshot.records, {
      workspaceId,
      recordLimit: args.limit,
      schemaOnly: args.schemaOnly,
      withAttachments: args.withAttachments,
      onProgress: (message) => console.log(message),
    });
    reports.push(report);
  }

  console.log(summarise(reports));

  if (fellBack.length > 0) {
    // Surfaced rather than buried: a base in the wrong workspace looks like a successful import
    // until somebody goes looking for it.
    console.log(
      `\n${fellBack.length} base(s) had no entry in the workspace map and used the default:\n` +
        fellBack.map((line) => `  ${line}`).join('\n') +
        `\nAdd them to ${args.workspaceMap} to place them deliberately.`,
    );
  }
}

main().catch((error: unknown) => {
  console.error('\nImport failed:', error instanceof Error ? error.message : error);
  process.exit(1);
});

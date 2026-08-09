import type { TesseraClient } from './runner';

/**
 * Places each imported base into the right workspace.
 *
 * ## Why this needs a mapping file
 *
 * Airtable's API does not tell you which workspace a base lives in. `/v0/meta/bases` returns an
 * id, a name and a permission level — nothing else — and the connector's base listing is the
 * same. The workspace grouping is visible in Airtable's own UI and nowhere in its API.
 *
 * So it cannot be derived; it has to be stated. Rather than guessing from base names (which
 * produces a plausible-looking but wrong arrangement that nobody notices until much later), the
 * mapping is an explicit file. A base with no entry falls back to a named default, and the
 * import report says which bases used the fallback so the omission is visible rather than silent.
 */

export interface WorkspaceMapping {
  /** Workspace name for bases with no explicit entry. */
  readonly default: string;
  /** Airtable base id → Tessera workspace name. */
  readonly byBaseId: Readonly<Record<string, string>>;
}

export interface ResolvedWorkspace {
  readonly id: string;
  readonly name: string;
  /** True when the workspace did not exist and was created by this run. */
  readonly created: boolean;
  /** True when the base had no mapping entry and landed in the default. */
  readonly fallback: boolean;
}

/**
 * Resolves workspace names to ids, creating any that are missing.
 *
 * Matching is case-insensitive and whitespace-trimmed: "MEDX BACKUP" and "Medx Backup" are the
 * same workspace to a person, and creating both would split one customer's data across two
 * places. Re-running an import must not multiply workspaces, so an existing match always wins
 * over creating a new one.
 */
export class WorkspaceResolver {
  private readonly cache = new Map<string, ResolvedWorkspace>();
  private existing: Array<{ id: string; name: string }> | null = null;

  constructor(
    private readonly client: TesseraClient,
    private readonly organizationId: string,
    private readonly mapping: WorkspaceMapping,
  ) {}

  async resolveForBase(baseId: string): Promise<ResolvedWorkspace> {
    const mapped = this.mapping.byBaseId[baseId];
    const name = mapped ?? this.mapping.default;
    const resolved = await this.resolveByName(name);
    return { ...resolved, fallback: mapped === undefined };
  }

  private async resolveByName(name: string): Promise<ResolvedWorkspace> {
    const key = normalise(name);
    const cached = this.cache.get(key);
    if (cached) return cached;

    if (this.existing === null) {
      this.existing = await this.client.listWorkspaces(this.organizationId);
    }

    const match = this.existing.find((workspace) => normalise(workspace.name) === key);
    if (match) {
      const resolved = { id: match.id, name: match.name, created: false, fallback: false };
      this.cache.set(key, resolved);
      return resolved;
    }

    const created = await this.client.createWorkspace(this.organizationId, { name });
    // Recorded locally as well as remotely: two bases mapped to the same new workspace must not
    // each create one.
    this.existing.push({ id: created.id, name });
    const resolved = { id: created.id, name, created: true, fallback: false };
    this.cache.set(key, resolved);
    return resolved;
  }
}

function normalise(name: string): string {
  return name.trim().toLowerCase().replace(/\s+/g, ' ');
}

/** Parses and validates a mapping file's contents. */
export function parseWorkspaceMapping(input: unknown): WorkspaceMapping {
  // Arrays are objects too. Accepting one would yield zero entries and send every base to the
  // default without a word — the exact silent misplacement this function exists to prevent.
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    throw new Error('The workspace map must be a JSON object.');
  }

  const raw = input as { default?: unknown; byBaseId?: unknown };

  if (typeof raw.default !== 'string' || raw.default.trim() === '') {
    throw new Error('The workspace map needs a non-empty "default" workspace name.');
  }

  const byBaseId: Record<string, string> = {};
  if (raw.byBaseId !== undefined) {
    if (typeof raw.byBaseId !== 'object' || raw.byBaseId === null || Array.isArray(raw.byBaseId)) {
      throw new Error('"byBaseId" must be an object of baseId → workspace name.');
    }
    for (const [baseId, workspace] of Object.entries(raw.byBaseId)) {
      if (typeof workspace !== 'string' || workspace.trim() === '') {
        throw new Error(`The workspace name for ${baseId} must be a non-empty string.`);
      }
      // Catches a mapping keyed by base *name* instead of base id — an easy mistake to make by
      // hand, and one that would otherwise silently send every base to the default.
      if (!/^app[A-Za-z0-9]+$/.test(baseId)) {
        throw new Error(`"${baseId}" is not an Airtable base id (they start with "app").`);
      }
      byBaseId[baseId] = workspace;
    }
  }

  return { default: raw.default, byBaseId };
}

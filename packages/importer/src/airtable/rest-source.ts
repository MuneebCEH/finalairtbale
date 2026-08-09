import { recordKey } from '../runner';

import {
  airtableBaseSchema,
  airtableRecordSchema,
  airtableTableSchema,
  type AirtableBase,
  type AirtableRecord,
  type AirtableSnapshot,
} from './schema';

/**
 * A read-only reader for the Airtable REST API.
 *
 * ## Read-only by construction, not by convention
 *
 * The source account is the customer's live production data. "We only call GET" is a property
 * that decays the moment someone adds a convenience method, so it is enforced structurally
 * instead:
 *
 *  - `request()` is the only function in this file that touches the network, and it is private.
 *  - It hard-codes `method: 'GET'`. There is no parameter to override it.
 *  - It refuses any path that is not on {@link READABLE_PATHS}, so a mistyped or attacker-supplied
 *    path cannot reach a mutating endpoint even if one were somehow constructed.
 *
 * To make this class capable of writing, someone would have to add a new network call and delete
 * a guard — which is visible in review in a way that a changed string literal is not.
 *
 * ## Why a token rather than the connector
 *
 * The metadata connector is not always reachable, and it cannot stream large record sets. A
 * read-scoped personal access token (`data.records:read`, `schema.bases:read`) can do everything
 * this importer needs and nothing it does not — it cannot write even if this code were wrong.
 */

/** Endpoint shapes this reader is permitted to call. Anchored: no prefix matching. */
const READABLE_PATHS: readonly RegExp[] = [
  /^\/v0\/meta\/bases$/,
  /^\/v0\/meta\/bases\/[A-Za-z0-9]+\/tables$/,
  /^\/v0\/[A-Za-z0-9]+\/[A-Za-z0-9]+$/, // records: /v0/{baseId}/{tableId}
];

const API_ORIGIN = 'https://api.airtable.com';

/**
 * Airtable permits 5 requests/second per base and answers a breach with a 30-second lockout.
 * 220ms between calls keeps a comfortable margin; the importer is not latency-sensitive and a
 * lockout costs far more than the wait.
 */
const MIN_REQUEST_INTERVAL_MS = 220;

export interface RestSourceOptions {
  /** Personal access token. Needs only `schema.bases:read` and `data.records:read`. */
  readonly token: string;
  /** Called with human-readable progress. */
  readonly onProgress?: (message: string) => void;
}

export class AirtableRestSource {
  private lastRequestAt = 0;

  constructor(private readonly options: RestSourceOptions) {
    if (!options.token.trim()) throw new Error('An Airtable personal access token is required.');
  }

  /** Every base the token can see. */
  async listBases(): Promise<{ id: string; name: string }[]> {
    const out: { id: string; name: string }[] = [];
    let offset: string | undefined;

    do {
      const page = (await this.request('/v0/meta/bases', offset ? { offset } : {})) as {
        bases?: { id: string; name: string; permissionLevel?: string }[];
        offset?: string;
      };
      for (const base of page.bases ?? []) out.push({ id: base.id, name: base.name });
      offset = page.offset;
    } while (offset);

    return out;
  }

  /**
   * A base's full schema.
   *
   * Note this returns real select options rather than the ones the snapshot path has to infer
   * from cell values: the metadata endpoint reports every choice, including those no record
   * currently uses. Inference cannot see an unused option, so it silently drops it.
   */
  async readSchema(baseId: string, baseName: string): Promise<AirtableBase> {
    const tables: unknown[] = [];
    let offset: string | undefined;

    do {
      const page = (await this.request(
        `/v0/meta/bases/${baseId}/tables`,
        offset ? { offset } : {},
      )) as { tables?: unknown[]; offset?: string };
      tables.push(...(page.tables ?? []));
      offset = page.offset;
    } while (offset);

    return airtableBaseSchema.parse({
      id: baseId,
      name: baseName,
      tables: tables.map((table) => airtableTableSchema.parse(table)),
    });
  }

  /**
   * Every record in a table, following the pagination cursor to the end.
   *
   * `cellFormat: 'json'` keeps values in their native types — the string format loses numeric
   * precision and reformats dates to the base's display settings, both of which are lossy in a
   * way that only shows up much later.
   */
  async readRecords(
    baseId: string,
    tableId: string,
    limit?: number,
  ): Promise<AirtableRecord[]> {
    const out: AirtableRecord[] = [];
    let offset: string | undefined;

    do {
      const query: Record<string, string> = { pageSize: '100', cellFormat: 'json', timeZone: 'UTC', userLocale: 'en' };
      if (offset) query['offset'] = offset;

      const page = (await this.request(`/v0/${baseId}/${tableId}`, query)) as {
        records?: unknown[];
        offset?: string;
      };

      for (const record of page.records ?? []) {
        out.push(airtableRecordSchema.parse(record));
        if (limit !== undefined && out.length >= limit) return out;
      }
      offset = page.offset;
    } while (offset);

    return out;
  }

  /**
   * Reads whole bases into the same structure the snapshot file uses, so the importer's loading
   * path is identical whichever source produced the data.
   *
   * Attachment URLs in the result are signed by Airtable and expire within hours. The caller must
   * hand this straight to the importer rather than writing it to disk for later.
   */
  async snapshot(
    baseIds: readonly string[],
    options: { readonly recordLimit?: number; readonly schemaOnly?: boolean } = {},
  ): Promise<AirtableSnapshot> {
    const known = await this.listBases();
    const bases: AirtableBase[] = [];
    const records: Record<string, AirtableRecord[]> = {};

    for (const baseId of baseIds) {
      const match = known.find((b) => b.id === baseId);
      if (!match) throw new Error(`The token cannot see base ${baseId}.`);

      this.report(`Reading schema for ${match.name}`);
      const base = await this.readSchema(baseId, match.name);
      bases.push(base);

      if (options.schemaOnly) continue;

      for (const table of base.tables) {
        const rows = await this.readRecords(baseId, table.id, options.recordLimit);
        // Qualified by base id: table ids repeat across copied bases — see recordKey.
        records[recordKey(baseId, table.id)] = rows;
        this.report(`  ${table.name}: ${rows.length} records`);
      }
    }

    return { takenAt: new Date().toISOString(), bases, records };
  }

  private report(message: string): void {
    this.options.onProgress?.(message);
  }

  /**
   * The only network call in this file, and the only place a URL is constructed.
   *
   * GET is hard-coded and the path is checked against an allowlist before the request is built.
   */
  private async request(path: string, query: Record<string, string> = {}): Promise<unknown> {
    if (!READABLE_PATHS.some((allowed) => allowed.test(path))) {
      throw new Error(`Refusing to call a non-read endpoint: ${path}`);
    }

    await this.throttle();

    const url = new URL(path, API_ORIGIN);
    for (const [key, value] of Object.entries(query)) url.searchParams.set(key, value);

    const response = await fetch(url, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${this.options.token}`,
        Accept: 'application/json',
      },
      signal: AbortSignal.timeout(60_000),
    });

    // A 429 means the throttle was still too fast for a shared account. Wait out the window
    // Airtable asks for and try once more, rather than failing a long import near the end.
    if (response.status === 429) {
      await sleep(31_000);
      return this.request(path, query);
    }

    if (!response.ok) {
      const detail = await response.text().catch(() => '');
      throw new Error(
        `Airtable returned ${response.status} for ${path}. ${describeStatus(response.status)} ${detail.slice(0, 300)}`,
      );
    }

    return response.json();
  }

  private async throttle(): Promise<void> {
    const wait = this.lastRequestAt + MIN_REQUEST_INTERVAL_MS - Date.now();
    if (wait > 0) await sleep(wait);
    this.lastRequestAt = Date.now();
  }
}

function describeStatus(status: number): string {
  if (status === 401) return 'The token is invalid or expired.';
  if (status === 403) {
    return 'The token lacks access. It needs the `schema.bases:read` and `data.records:read` scopes, and the base must be added to the token.';
  }
  if (status === 404) return 'No such base or table, or the token cannot see it.';
  return '';
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

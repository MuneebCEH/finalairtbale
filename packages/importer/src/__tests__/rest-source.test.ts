import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AirtableRestSource } from '../airtable/rest-source';

/**
 * The source account is somebody's live production data. The single property that matters here
 * is that this reader cannot change it, so that is what these tests assert — not by inspecting
 * the code, but by recording every request it makes and checking each one.
 *
 * The safety net is `expectReadOnly()`, called after every test: if any call used a method other
 * than GET, or reached a host other than Airtable's API, the test fails regardless of what else
 * it was checking.
 */

interface Call {
  readonly url: string;
  readonly method: string;
  readonly headers: Record<string, string>;
}

let calls: Call[] = [];

function mockFetch(responder: (url: URL) => unknown): void {
  vi.stubGlobal(
    'fetch',
    vi.fn((input: string | URL | Request, init?: RequestInit) => {
      const url = input instanceof URL ? input : new URL(String(input));
      calls.push({
        url: url.toString(),
        method: init?.method ?? 'GET',
        headers: (init?.headers ?? {}) as Record<string, string>,
      });
      const body = responder(url);
      return Promise.resolve({
        ok: true,
        status: 200,
        json: () => Promise.resolve(body),
        text: () => Promise.resolve(JSON.stringify(body)),
      } as unknown as Response);
    }),
  );
}

function expectReadOnly(): void {
  for (const call of calls) {
    expect(call.method, `${call.method} ${call.url}`).toBe('GET');
    expect(new URL(call.url).origin, call.url).toBe('https://api.airtable.com');
  }
}

beforeEach(() => {
  calls = [];
  vi.useFakeTimers();
});

afterEach(() => {
  expectReadOnly();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

/**
 * The throttle sleeps between calls, so fake timers must be advanced for the promise to settle.
 *
 * The bare `.catch` marks the rejection as observed. Without it, a test that asserts on a
 * rejection trips Vitest's unhandled-rejection detector during the timer advance — the assertion
 * has not attached yet at that point.
 */
async function run<T>(work: Promise<T>): Promise<T> {
  work.catch(() => undefined);
  await vi.runAllTimersAsync();
  return work;
}

describe('AirtableRestSource', () => {
  it('requires a token', () => {
    expect(() => new AirtableRestSource({ token: '   ' })).toThrow(/token is required/i);
  });

  it('reads the base list with GET only', async () => {
    mockFetch(() => ({ bases: [{ id: 'appAAA', name: 'Ops' }] }));
    const source = new AirtableRestSource({ token: 'pat_test' });

    const bases = await run(source.listBases());

    expect(bases).toEqual([{ id: 'appAAA', name: 'Ops' }]);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.method).toBe('GET');
  });

  it('follows pagination to the end rather than stopping at the first page', async () => {
    let page = 0;
    mockFetch(() => {
      page += 1;
      return page === 1
        ? { records: [{ id: 'rec1', fields: {} }], offset: 'next' }
        : { records: [{ id: 'rec2', fields: {} }] };
    });

    const source = new AirtableRestSource({ token: 'pat_test' });
    const records = await run(source.readRecords('appAAA', 'tblAAA'));

    expect(records.map((r) => r.id)).toEqual(['rec1', 'rec2']);
    expect(calls).toHaveLength(2);
    expect(calls[1]?.url).toContain('offset=next');
  });

  it('stops at the record limit without fetching further pages', async () => {
    mockFetch(() => ({
      records: [
        { id: 'rec1', fields: {} },
        { id: 'rec2', fields: {} },
        { id: 'rec3', fields: {} },
      ],
      offset: 'more',
    }));

    const source = new AirtableRestSource({ token: 'pat_test' });
    const records = await run(source.readRecords('appAAA', 'tblAAA', 2));

    expect(records).toHaveLength(2);
    expect(calls).toHaveLength(1);
  });

  it('asks for native cell values, because the string format is lossy', async () => {
    mockFetch(() => ({ records: [] }));
    const source = new AirtableRestSource({ token: 'pat_test' });

    await run(source.readRecords('appAAA', 'tblAAA'));

    expect(calls[0]?.url).toContain('cellFormat=json');
  });

  it('normalises records into the same shape the snapshot loader consumes', async () => {
    mockFetch(() => ({ records: [{ id: 'rec1', createdTime: '2026-01-01T00:00:00Z', fields: { fldA: 7 } }] }));
    const source = new AirtableRestSource({ token: 'pat_test' });

    const [record] = await run(source.readRecords('appAAA', 'tblAAA'));

    expect(record).toMatchObject({ id: 'rec1', fields: { fldA: 7 } });
  });

  it('refuses a base the token cannot see, instead of importing nothing quietly', async () => {
    mockFetch(() => ({ bases: [{ id: 'appAAA', name: 'Ops' }] }));
    const source = new AirtableRestSource({ token: 'pat_test' });

    await expect(run(source.snapshot(['appZZZ']))).rejects.toThrow(/cannot see base appZZZ/);
  });

  it('builds a snapshot of schema and records together', async () => {
    mockFetch((url) => {
      if (url.pathname === '/v0/meta/bases') return { bases: [{ id: 'appAAA', name: 'Ops' }] };
      if (url.pathname.endsWith('/tables')) {
        return {
          tables: [
            { id: 'tblAAA', name: 'Tasks', primaryFieldId: 'fldA', fields: [{ id: 'fldA', name: 'Name', type: 'singleLineText' }] },
          ],
        };
      }
      return { records: [{ id: 'rec1', fields: { fldA: 'Ship it' } }] };
    });

    const source = new AirtableRestSource({ token: 'pat_test' });
    const snapshot = await run(source.snapshot(['appAAA']));

    expect(snapshot.bases).toHaveLength(1);
    expect(snapshot.bases[0]?.tables[0]?.name).toBe('Tasks');
    expect(snapshot.records['appAAA::tblAAA']).toHaveLength(1);
    expect(snapshot.takenAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('keeps two bases apart when they share table ids', async () => {
    // Duplicating a base in Airtable preserves every table id, so "Delta Medical portal Old" and
    // its copy have identical ones. Keying records by table id alone loads one base's rows into
    // the other's tables — a silent, total corruption of both.
    mockFetch((url) => {
      if (url.pathname === '/v0/meta/bases') {
        return {
          bases: [
            { id: 'appORIGINAL', name: 'Portal' },
            { id: 'appCOPY', name: 'Portal (Copy)' },
          ],
        };
      }
      if (url.pathname.endsWith('/tables')) {
        // Same table id in both bases, exactly as Airtable reports it.
        return { tables: [{ id: 'tblSHARED', name: 'Patients', fields: [{ id: 'fldA', name: 'Name', type: 'singleLineText' }] }] };
      }
      const base = url.pathname.split('/')[2];
      return { records: [{ id: `rec_${base}`, fields: { fldA: base } }] };
    });

    const source = new AirtableRestSource({ token: 'pat_test' });
    const snapshot = await run(source.snapshot(['appORIGINAL', 'appCOPY']));

    expect(snapshot.records['appORIGINAL::tblSHARED']?.[0]?.id).toBe('rec_appORIGINAL');
    expect(snapshot.records['appCOPY::tblSHARED']?.[0]?.id).toBe('rec_appCOPY');
    // Neither base overwrote the other.
    expect(Object.keys(snapshot.records)).toHaveLength(2);
  });

  it('skips record reads entirely in schema-only mode', async () => {
    mockFetch((url) => {
      if (url.pathname === '/v0/meta/bases') return { bases: [{ id: 'appAAA', name: 'Ops' }] };
      if (url.pathname.endsWith('/tables')) {
        return { tables: [{ id: 'tblAAA', name: 'Tasks', fields: [{ id: 'fldA', name: 'Name', type: 'singleLineText' }] }] };
      }
      throw new Error('schema-only mode must not read records');
    });

    const source = new AirtableRestSource({ token: 'pat_test' });
    const snapshot = await run(source.snapshot(['appAAA'], { schemaOnly: true }));

    expect(snapshot.records).toEqual({});
    // Base list + table list. Nothing else.
    expect(calls).toHaveLength(2);
  });

  it('sends the token as a bearer header and never in the query string', async () => {
    mockFetch(() => ({ bases: [] }));
    const source = new AirtableRestSource({ token: 'pat_secret' });

    await run(source.listBases());

    // A token in a URL is a token in access logs, proxy logs and browser history.
    expect(calls[0]?.url).not.toContain('pat_secret');
    expect(calls[0]?.headers['Authorization']).toBe('Bearer pat_secret');
  });

  it('refuses to call an endpoint that is not on the read allowlist', async () => {
    mockFetch(() => ({}));
    const source = new AirtableRestSource({ token: 'pat_test' });

    // Reaching a mutating endpoint would require a path the allowlist does not match. Exercised
    // through the private request path via a record read with an injected segment.
    await expect(run(source.readRecords('appAAA', 'tblAAA/../../meta/bases'))).rejects.toThrow(
      /non-read endpoint/,
    );
    expect(calls).toHaveLength(0);
  });

  it('throttles below the documented rate limit', async () => {
    mockFetch(() => ({ records: [] }));
    const source = new AirtableRestSource({ token: 'pat_test' });

    const started = Date.now();
    await run(
      (async () => {
        await source.readRecords('appAAA', 'tblAAA');
        await source.readRecords('appAAA', 'tblBBB');
        await source.readRecords('appAAA', 'tblCCC');
      })(),
    );

    // Three calls at >=220ms apart cannot finish inside the 1s window that bounds 5 req/sec.
    expect(Date.now() - started).toBeGreaterThanOrEqual(440);
  });
});

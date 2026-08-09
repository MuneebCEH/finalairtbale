import { describe, expect, it, vi } from 'vitest';

import type { TesseraClient } from '../runner';
import { WorkspaceResolver, parseWorkspaceMapping } from '../workspaces';

/**
 * The failure this guards against is duplication: an import that creates "MEDX BACKUP" when
 * "Medx Backup" already exists splits one customer's data across two workspaces, and nobody
 * notices until they go looking for a base that is not where they expect.
 */

function fakeClient(existing: Array<{ id: string; name: string }> = []) {
  let created = 0;
  const listWorkspaces = vi.fn().mockResolvedValue(existing);
  const createWorkspace = vi.fn().mockImplementation((_org: string, input: { name: string }) => {
    created += 1;
    return Promise.resolve({ id: `wsp_created_${created}`, name: input.name });
  });

  return { listWorkspaces, createWorkspace } as unknown as TesseraClient & {
    listWorkspaces: typeof listWorkspaces;
    createWorkspace: typeof createWorkspace;
  };
}

const MAPPING = {
  default: 'Imported from Airtable',
  byBaseId: {
    appAAA: 'delta med LLC',
    appBBB: 'oxford backup',
    appCCC: 'delta med LLC',
  },
};

describe('WorkspaceResolver', () => {
  it('reuses an existing workspace rather than creating a duplicate', async () => {
    const client = fakeClient([{ id: 'wsp_existing', name: 'delta med LLC' }]);
    const resolver = new WorkspaceResolver(client, 'org_1', MAPPING);

    const resolved = await resolver.resolveForBase('appAAA');

    expect(resolved).toMatchObject({ id: 'wsp_existing', created: false, fallback: false });
    expect(client.createWorkspace).not.toHaveBeenCalled();
  });

  it('matches names case-insensitively and ignores surrounding whitespace', async () => {
    const client = fakeClient([{ id: 'wsp_existing', name: '  MEDX   Backup ' }]);
    const resolver = new WorkspaceResolver(client, 'org_1', {
      default: 'Fallback',
      byBaseId: { appAAA: 'medx backup' },
    });

    expect((await resolver.resolveForBase('appAAA')).id).toBe('wsp_existing');
    expect(client.createWorkspace).not.toHaveBeenCalled();
  });

  it('creates a workspace that does not exist yet', async () => {
    const client = fakeClient([]);
    const resolver = new WorkspaceResolver(client, 'org_1', MAPPING);

    const resolved = await resolver.resolveForBase('appAAA');

    expect(resolved).toMatchObject({ name: 'delta med LLC', created: true });
    expect(client.createWorkspace).toHaveBeenCalledWith('org_1', { name: 'delta med LLC' });
  });

  it('creates a shared workspace once for two bases that map to it', async () => {
    const client = fakeClient([]);
    const resolver = new WorkspaceResolver(client, 'org_1', MAPPING);

    const first = await resolver.resolveForBase('appAAA');
    const second = await resolver.resolveForBase('appCCC');

    expect(second.id).toBe(first.id);
    expect(client.createWorkspace).toHaveBeenCalledTimes(1);
  });

  it('reads the existing workspace list only once', async () => {
    const client = fakeClient([{ id: 'wsp_1', name: 'delta med LLC' }]);
    const resolver = new WorkspaceResolver(client, 'org_1', MAPPING);

    await resolver.resolveForBase('appAAA');
    await resolver.resolveForBase('appBBB');
    await resolver.resolveForBase('appAAA');

    expect(client.listWorkspaces).toHaveBeenCalledTimes(1);
  });

  it('flags a base that fell through to the default', async () => {
    const client = fakeClient([]);
    const resolver = new WorkspaceResolver(client, 'org_1', MAPPING);

    const resolved = await resolver.resolveForBase('appUNMAPPED');

    expect(resolved).toMatchObject({ name: 'Imported from Airtable', fallback: true });
  });

  it('does not flag a mapped base as a fallback', async () => {
    const client = fakeClient([]);
    const resolver = new WorkspaceResolver(client, 'org_1', MAPPING);

    expect((await resolver.resolveForBase('appBBB')).fallback).toBe(false);
  });
});

describe('parseWorkspaceMapping', () => {
  it('accepts a well-formed mapping', () => {
    expect(parseWorkspaceMapping({ default: 'Inbox', byBaseId: { appAAA: 'Ops' } })).toEqual({
      default: 'Inbox',
      byBaseId: { appAAA: 'Ops' },
    });
  });

  it('ignores keys used for documentation', () => {
    const parsed = parseWorkspaceMapping({
      _comment: ['notes for a human'],
      _baseNames: { appAAA: 'Ops Base' },
      default: 'Inbox',
      byBaseId: { appAAA: 'Ops' },
    });

    expect(parsed.byBaseId).toEqual({ appAAA: 'Ops' });
  });

  it('allows a mapping with no explicit entries', () => {
    expect(parseWorkspaceMapping({ default: 'Inbox' })).toEqual({ default: 'Inbox', byBaseId: {} });
  });

  describe('rejects', () => {
    it('a missing or empty default', () => {
      expect(() => parseWorkspaceMapping({ byBaseId: {} })).toThrow(/non-empty "default"/);
      expect(() => parseWorkspaceMapping({ default: '   ' })).toThrow(/non-empty "default"/);
    });

    it('a non-object', () => {
      expect(() => parseWorkspaceMapping(null)).toThrow(/must be a JSON object/);
      expect(() => parseWorkspaceMapping('Inbox')).toThrow(/must be a JSON object/);
    });

    it('a byBaseId that is not an object', () => {
      expect(() => parseWorkspaceMapping({ default: 'x', byBaseId: [] })).toThrow(/baseId/);
    });

    it('an empty workspace name', () => {
      expect(() => parseWorkspaceMapping({ default: 'x', byBaseId: { appAAA: '' } })).toThrow(
        /non-empty string/,
      );
    });

    it('a map keyed by base name instead of base id', () => {
      // The mistake that would otherwise send every base to the default without a word.
      expect(() =>
        parseWorkspaceMapping({ default: 'x', byBaseId: { 'DELTA MED LLC BACKUP': 'Ops' } }),
      ).toThrow(/not an Airtable base id/);
    });

    it('a table id used where a base id belongs', () => {
      expect(() => parseWorkspaceMapping({ default: 'x', byBaseId: { tblAAA: 'Ops' } })).toThrow(
        /not an Airtable base id/,
      );
    });
  });
});

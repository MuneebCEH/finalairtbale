import { describe, expect, it } from 'vitest';

import {
  ChannelHistory,
  HistoryRegistry,
  PresenceRegistry,
  channelFor,
  clientMessageSchema,
  parseChannel,
  presenceColour,
  type ServerMessage,
} from '../src';

const ORG = 'org_01KZCN5ZD75CZX8FC4H5M22MM3';
const TABLE = 'tbl_01KZEQTA3K80Y2PKNWMYT9BBXW';
const RECORD = 'rec_01KZEQTA3K80Y2PKNWMYT9BBXW';

const message = (n: number): ServerMessage => ({ t: 'error', code: 'x', message: String(n) });

describe('channel names', () => {
  it('builds a channel from a kind and an id', () => {
    expect(channelFor('table', TABLE)).toBe(`table:${TABLE}`);
  });

  it('refuses to build one from a malformed id', () => {
    // A channel name routes messages between tenants; a permissive parse here is a cross-tenant
    // subscription, so it is refused at construction as well as on parse.
    for (const bad of ['', 'nonsense', '../other', `${TABLE};drop`, 'tbl_short']) {
      expect(() => channelFor('table', bad), bad).toThrow(/malformed id/);
    }
  });

  it('parses a well-formed channel', () => {
    expect(parseChannel(`table:${TABLE}`)).toEqual({ kind: 'table', id: TABLE });
  });

  describe('rejects', () => {
    const invalid = [
      '',
      'table',
      `table:${TABLE}:extra`,
      `unknown:${TABLE}`,
      'table:not-an-id',
      `table:${TABLE.toLowerCase()}`,
      `TABLE:${TABLE}`,
      `table:${TABLE} `,
      // Excluded ULID characters (I, L, O, U) must not pass.
      'table:tbl_01KZEQTA3K80Y2PKNWMYT9BBIL',
    ];

    for (const channel of invalid) {
      it(JSON.stringify(channel), () => {
        expect(parseChannel(channel)).toBeNull();
      });
    }
  });
});

describe('client message validation', () => {
  it('accepts a subscribe with catch-up positions', () => {
    const parsed = clientMessageSchema.safeParse({
      t: 'subscribe',
      ch: [`table:${TABLE}`],
      since: { [`table:${TABLE}`]: 42 },
    });
    expect(parsed.success).toBe(true);
  });

  it('accepts a presence update', () => {
    const parsed = clientMessageSchema.safeParse({
      t: 'presence',
      ch: `table:${TABLE}`,
      recordId: RECORD,
      fieldId: null,
      editing: true,
    });
    expect(parsed.success).toBe(true);
  });

  it('rejects an unknown message type', () => {
    expect(clientMessageSchema.safeParse({ t: 'evict', ch: [] }).success).toBe(false);
  });

  it('caps how many channels one frame can subscribe to', () => {
    // Otherwise a single frame can ask for unbounded fan-out.
    const many = Array.from({ length: 65 }, () => `table:${TABLE}`);
    expect(clientMessageSchema.safeParse({ t: 'subscribe', ch: many }).success).toBe(false);
  });

  it('rejects an empty subscribe', () => {
    expect(clientMessageSchema.safeParse({ t: 'subscribe', ch: [] }).success).toBe(false);
  });

  it('rejects an over-long channel name', () => {
    const long = 'a'.repeat(65);
    expect(clientMessageSchema.safeParse({ t: 'subscribe', ch: [long] }).success).toBe(false);
  });

  it('rejects a negative catch-up position', () => {
    const parsed = clientMessageSchema.safeParse({
      t: 'subscribe',
      ch: [`table:${TABLE}`],
      since: { [`table:${TABLE}`]: -1 },
    });
    expect(parsed.success).toBe(false);
  });
});

describe('ChannelHistory', () => {
  it('assigns monotonic sequence numbers from 1', () => {
    const history = new ChannelHistory();
    expect(history.append(message(1))).toBe(1);
    expect(history.append(message(2))).toBe(2);
    expect(history.current).toBe(2);
  });

  it('replays exactly what a client missed', () => {
    const history = new ChannelHistory();
    for (let n = 1; n <= 5; n += 1) history.append(message(n));

    const replayed = history.replay(3);
    expect(replayed?.map((m) => (m as { message: string }).message)).toEqual(['4', '5']);
  });

  it('returns nothing when the client is already current', () => {
    const history = new ChannelHistory();
    history.append(message(1));
    expect(history.replay(1)).toEqual([]);
  });

  it('replays everything for a client that has seen nothing', () => {
    const history = new ChannelHistory();
    history.append(message(1));
    history.append(message(2));
    expect(history.replay(0)).toHaveLength(2);
  });

  it('demands a resync when the client has fallen out of the window', () => {
    // Retaining 3 entries, the client last saw 1: entries 2 and 3 are gone, so its grid would be
    // silently wrong if it were handed only what remains.
    const history = new ChannelHistory(3, 60_000);
    for (let n = 1; n <= 6; n += 1) history.append(message(n));

    expect(history.replay(1)).toBeNull();
    // Still catchable from within the retained window.
    expect(history.replay(4)).toHaveLength(2);
  });

  it('demands a resync from a client that is somehow ahead', () => {
    // Only reachable when the server restarted and its counter reset. The client's view cannot
    // be trusted, so it refetches rather than being left with phantom edits.
    const history = new ChannelHistory();
    history.append(message(1));
    expect(history.replay(99)).toBeNull();
  });

  it('demands a resync when nothing is retained and the client is behind', () => {
    const history = new ChannelHistory(10, 60_000);
    expect(history.replay(5)).toBeNull();
  });

  it('drops entries older than the retention window', () => {
    let now = 1_000_000;
    const history = new ChannelHistory(100, 5_000, () => now);

    history.append(message(1));
    now += 10_000;
    history.append(message(2));

    // Entry 1 has aged out, so a client that last saw 0 cannot be caught up.
    expect(history.replay(0)).toBeNull();
    expect(history.replay(1)).toHaveLength(1);
  });
});

describe('HistoryRegistry', () => {
  it('returns the same history for the same channel', () => {
    const registry = new HistoryRegistry();
    const first = registry.for('table:a');
    first.append(message(1));
    expect(registry.for('table:a').current).toBe(1);
  });

  it('keeps channels separate', () => {
    const registry = new HistoryRegistry();
    registry.for('table:a').append(message(1));
    expect(registry.for('table:b').current).toBe(0);
  });

  it('evicts channels that have gone quiet', () => {
    // Without this a long-lived process keeps one buffer per table ever opened — a slow leak that
    // shows up as a restart every few weeks and gets blamed on something else.
    let now = 1_000_000;
    const registry = new HistoryRegistry(() => now);

    registry.for('table:a');
    registry.for('table:b');
    expect(registry.size).toBe(2);

    now += 10 * 60_000;
    registry.for('table:b'); // touched, so it survives
    expect(registry.evictIdle()).toBe(1);
    expect(registry.size).toBe(1);
  });
});

describe('PresenceRegistry', () => {
  const entry = (connectionId: string, userId: string) => ({
    connectionId,
    userId,
    name: userId,
  });

  it('records who is in a channel', () => {
    const presence = new PresenceRegistry();
    presence.join('table:a', entry('c1', 'usr_1'));

    expect(presence.members('table:a')).toHaveLength(1);
    expect(presence.members('table:a')[0]?.userId).toBe('usr_1');
  });

  it('treats two tabs as two cursors', () => {
    // Collapsing them by user makes one tab's cursor vanish when the other moves.
    const presence = new PresenceRegistry();
    presence.join('table:a', entry('c1', 'usr_1'));
    presence.join('table:a', entry('c2', 'usr_1'));

    expect(presence.members('table:a')).toHaveLength(2);
  });

  it('assigns a stable colour per user', () => {
    const presence = new PresenceRegistry();
    const first = presence.join('table:a', entry('c1', 'usr_1'));
    const second = presence.join('table:b', entry('c2', 'usr_1'));

    expect(first.colour).toBe(second.colour);
    expect(first.colour).toBe(presenceColour('usr_1'));
  });

  it('moves a cursor', () => {
    const presence = new PresenceRegistry();
    presence.join('table:a', entry('c1', 'usr_1'));

    const updated = presence.update('table:a', 'c1', { recordId: RECORD, editing: true });
    expect(updated).toMatchObject({ recordId: RECORD, editing: true });
    expect(presence.members('table:a')[0]?.editing).toBe(true);
  });

  it('ignores a cursor move from a connection that is not present', () => {
    const presence = new PresenceRegistry();
    expect(presence.update('table:a', 'ghost', { recordId: RECORD })).toBeNull();
  });

  it('removes a connection from one channel', () => {
    const presence = new PresenceRegistry();
    presence.join('table:a', entry('c1', 'usr_1'));

    expect(presence.leave('table:a', 'c1')).toBe(true);
    expect(presence.members('table:a')).toEqual([]);
    expect(presence.leave('table:a', 'c1')).toBe(false);
  });

  it('removes a connection from every channel on disconnect', () => {
    const presence = new PresenceRegistry();
    presence.join('table:a', entry('c1', 'usr_1'));
    presence.join('table:b', entry('c1', 'usr_1'));
    presence.join('table:a', entry('c2', 'usr_2'));

    expect(presence.disconnect('c1').sort()).toEqual(['table:a', 'table:b']);
    expect(presence.members('table:a').map((m) => m.connectionId)).toEqual(['c2']);
    expect(presence.members('table:b')).toEqual([]);
  });

  it('leaves no empty channels or connections behind', () => {
    const presence = new PresenceRegistry();
    presence.join('table:a', entry('c1', 'usr_1'));
    presence.disconnect('c1');

    expect(presence.channelCount).toBe(0);
    expect(presence.connectionCount).toBe(0);
  });
});

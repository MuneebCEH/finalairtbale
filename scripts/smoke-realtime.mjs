import WebSocket from 'ws';

/**
 * Phase 4 smoke test: the WebSocket gateway against a running stack.
 *
 *   node scripts/smoke-realtime.mjs [baseUrl]
 *
 * Everything here is checked over a real socket rather than by calling the gateway's methods:
 * authentication at upgrade, per-channel authorisation, live deltas between two clients,
 * presence, and catch-up after a reconnect. A unit test of the registries cannot tell you the
 * upgrade handler refuses an anonymous connection.
 */

const BASE = process.argv[2] ?? 'http://localhost:4000';
const WS_BASE = BASE.replace(/^http/, 'ws');
const PASSWORD = 'Demo!Passw0rd';

let passed = 0;
let failed = 0;

function check(description, condition, detail) {
  if (condition) {
    passed += 1;
    console.log(`  \x1b[32mPASS\x1b[0m  ${description}`);
  } else {
    failed += 1;
    console.log(`  \x1b[31mFAIL\x1b[0m  ${description}`);
    if (detail !== undefined) console.log(`        \x1b[2m${JSON.stringify(detail)}\x1b[0m`);
  }
}

function section(title) {
  console.log(`\n${title}`);
}

async function signIn(email) {
  const response = await fetch(`${BASE}/v1/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password: PASSWORD }),
  });
  const cookie = (response.headers.getSetCookie?.() ?? []).map((c) => c.split(';')[0]).join('; ');
  if (!cookie) throw new Error(`sign-in failed for ${email}`);
  return cookie;
}

/** A socket wrapper that queues frames so a test can await the next one of a given type. */
function connect(cookie) {
  const socket = new WebSocket(`${WS_BASE}/realtime`, { headers: { Cookie: cookie } });
  const queue = [];
  const waiters = [];

  socket.on('message', (raw) => {
    const message = JSON.parse(raw.toString());
    const waiter = waiters.findIndex((w) => w.match(message));
    if (waiter !== -1) {
      const [resolved] = waiters.splice(waiter, 1);
      clearTimeout(resolved.timer);
      resolved.resolve(message);
    } else {
      queue.push(message);
    }
  });

  return {
    socket,
    open: () =>
      new Promise((resolve, reject) => {
        socket.once('open', resolve);
        socket.once('error', reject);
        socket.once('unexpected-response', (_req, res) => reject(new Error(`HTTP ${res.statusCode}`)));
      }),
    send: (message) => socket.send(JSON.stringify(message)),
    /** Waits for the next message matching a predicate. */
    next: (match, timeoutMs = 5000) => {
      const index = queue.findIndex(match);
      if (index !== -1) return Promise.resolve(queue.splice(index, 1)[0]);

      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('timed out waiting for a message')), timeoutMs);
        waiters.push({ match, resolve, timer });
      });
    },
    close: () => socket.close(),
  };
}

async function main() {
  console.log(`\nTessera realtime smoke test against ${BASE}\n${'='.repeat(60)}`);

  const cookie = await signIn('owner@demo.tessera.local');

  // Find a table to watch.
  const get = async (path) => (await fetch(BASE + path, { headers: { cookie } })).json();
  const orgs = await get('/v1/me/organizations');
  const workspaces = await get(`/v1/organizations/${orgs.data[0].id}/workspaces?limit=100`);

  let tableId = null;
  for (const workspace of workspaces.data) {
    const bases = await get(`/v1/workspaces/${workspace.id}/bases`);
    for (const base of bases.data ?? []) {
      const tables = await get(`/v1/bases/${base.id}/tables`);
      if (tables.data?.length) {
        tableId = tables.data[0].id;
        break;
      }
    }
    if (tableId) break;
  }

  if (!tableId) throw new Error('no table to watch; import some data first');
  const channel = `table:${tableId}`;

  // ── Authentication ────────────────────────────────────────────────────────
  section('Authentication');

  const anonymous = connect('');
  let refused = false;
  try {
    await anonymous.open();
  } catch {
    refused = true;
  }
  check('an unauthenticated upgrade is refused', refused);
  anonymous.close();

  const alice = connect(cookie);
  await alice.open();
  const ready = await alice.next((m) => m.t === 'ready');
  check('an authenticated socket is accepted', Boolean(ready.connectionId), ready);

  // ── Authorisation ─────────────────────────────────────────────────────────
  section('Channel authorisation');

  alice.send({ t: 'subscribe', ch: ['table:tbl_0000000000000000000000000'] });
  const badChannel = await alice.next((m) => m.t === 'error');
  check('a malformed channel is refused', badChannel.code === 'BAD_CHANNEL', badChannel);

  // A well-formed id that does not exist must look the same as one belonging to another tenant.
  alice.send({ t: 'subscribe', ch: ['table:tbl_01ZZZZZZZZZZZZZZZZZZZZZZZZ'] });
  const unknown = await alice.next((m) => m.t === 'error');
  check('an unknown table is refused as FORBIDDEN, not NOT_FOUND', unknown.code === 'FORBIDDEN', unknown);

  alice.send({ t: 'subscribe', ch: [channel] });
  const subscribed = await alice.next((m) => m.t === 'subscribed');
  check('a permitted channel is joined', subscribed.ch === channel, subscribed);
  check('the join reports a sequence position', typeof subscribed.seq === 'number', subscribed);

  // ── Presence ──────────────────────────────────────────────────────────────
  section('Presence');

  const bob = connect(cookie);
  await bob.open();
  await bob.next((m) => m.t === 'ready');
  bob.send({ t: 'subscribe', ch: [channel] });
  await bob.next((m) => m.t === 'subscribed');

  const join = await alice.next((m) => m.t === 'presence' && m.join?.length);
  check('an existing viewer is told when someone joins', Boolean(join.join?.[0]?.userId), join);
  check('the newcomer carries a colour', typeof join.join?.[0]?.colour === 'string', join.join?.[0]);

  bob.send({ t: 'presence', ch: channel, recordId: null, fieldId: null, editing: true });
  const moved = await alice.next((m) => m.t === 'presence' && m.update?.length);
  check('a cursor move reaches other viewers', moved.update?.[0]?.editing === true, moved);

  // ── Live deltas ───────────────────────────────────────────────────────────
  section('Live deltas');

  const fields = await get(`/v1/tables/${tableId}/fields`);
  const writable = (fields.data ?? []).find((f) => f.type === 'singleLineText' || f.type === 'longText');

  const created = await fetch(`${BASE}/v1/tables/${tableId}/records`, {
    method: 'POST',
    headers: { cookie, 'content-type': 'application/json' },
    body: JSON.stringify({
      records: [{ fields: writable ? { [writable.id]: 'realtime smoke' } : {} }],
    }),
  });
  const createdBody = await created.json();
  check('a record can be created over HTTP', created.status === 201, createdBody?.error);

  const delta = await alice.next((m) => m.t === 'delta');
  check('the create reaches watchers as a delta', delta.ops?.[0]?.op === 'create', delta);
  check('the delta carries a sequence number', typeof delta.seq === 'number', delta);
  check('the delta names the actor', typeof delta.ops?.[0]?.actorId === 'string', delta.ops?.[0]);

  const recordId = createdBody?.data?.records?.[0]?.id;
  const version = createdBody?.data?.records?.[0]?.version;

  if (recordId && writable) {
    await fetch(`${BASE}/v1/tables/${tableId}/records/${recordId}`, {
      method: 'PATCH',
      headers: { cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ version, fields: { [writable.id]: 'edited' } }),
    });

    const update = await alice.next((m) => m.t === 'delta' && m.ops?.[0]?.op === 'update');
    check('an edit reaches watchers', update.ops?.[0]?.recordId === recordId, update);
    // The whole point of a delta: one cell changed, so one cell travels.
    check(
      'the delta carries only the changed field',
      Object.keys(update.ops[0].changed ?? {}).length === 1,
      update.ops[0].changed,
    );
  }

  // ── Catch-up after a reconnect ────────────────────────────────────────────
  section('Catch-up after reconnect');

  const lastSeq = subscribed.seq;
  const returning = connect(cookie);
  await returning.open();
  await returning.next((m) => m.t === 'ready');
  returning.send({ t: 'subscribe', ch: [channel], since: { [channel]: lastSeq } });

  const replayed = await returning.next((m) => m.t === 'delta' || m.t === 'resync');
  check('a returning client is caught up or told to resync', ['delta', 'resync'].includes(replayed.t), replayed);
  returning.close();

  // A client claiming a position the server never issued cannot be caught up.
  const ahead = connect(cookie);
  await ahead.open();
  await ahead.next((m) => m.t === 'ready');
  ahead.send({ t: 'subscribe', ch: [channel], since: { [channel]: 999_999 } });
  const resync = await ahead.next((m) => m.t === 'resync');
  check('a client ahead of the server is told to resync', resync.ch === channel, resync);
  ahead.close();

  // ── Malformed input ───────────────────────────────────────────────────────
  section('Malformed input');

  alice.socket.send('not json');
  const malformed = await alice.next((m) => m.t === 'error' && m.code === 'MALFORMED');
  check('invalid JSON is rejected without closing the socket', malformed.code === 'MALFORMED');

  alice.send({ t: 'nonsense' });
  const unknownType = await alice.next((m) => m.t === 'error' && m.code === 'MALFORMED');
  check('an unknown message type is rejected', unknownType.code === 'MALFORMED');

  check('the socket survived both', alice.socket.readyState === WebSocket.OPEN);

  // ── Departure ─────────────────────────────────────────────────────────────
  section('Departure');

  bob.close();
  const left = await alice.next((m) => m.t === 'presence' && m.leave?.length);
  check('closing a tab removes its cursor', left.leave.length === 1, left);

  alice.close();

  // Clean up the record this run created.
  if (recordId) {
    await fetch(`${BASE}/v1/tables/${tableId}/records`, {
      method: 'DELETE',
      headers: { cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ recordIds: [recordId] }),
    });
  }

  console.log(`\n${'='.repeat(60)}`);
  console.log(`${passed} passed, ${failed} failed\n`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error('\nRealtime smoke test crashed:', error);
  process.exit(1);
});

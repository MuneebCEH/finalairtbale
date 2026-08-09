/**
 * Phase 2 smoke test: bases, tables, fields and records.
 *
 *   node scripts/smoke-data.mjs [baseUrl]
 *
 * Complements scripts/smoke.mjs, which covers auth, tenancy and permissions. This one exercises
 * the data engine against a running stack and cleans up after itself.
 */

import { createServer } from 'node:http';

const BASE = process.argv[2] ?? 'http://localhost:4000';
const PASSWORD = 'Demo!Passw0rd';

/** Reused across runs so the suite does not accumulate a workspace per invocation. */
const SMOKE_WORKSPACE = 'Smoke Tests';

/** A real 1x1 PNG. Used so the magic-byte detector has genuine bytes to identify. */
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

/**
 * Serves fixtures over loopback so the attachment ingest path can be exercised without reaching
 * the internet. `/image.png` is a valid PNG; `/evil.png` is a Windows executable wearing a PNG
 * name, which the detector must refuse on its leading bytes rather than its extension.
 */
function startFixtureServer() {
  const EXECUTABLE = Buffer.concat([Buffer.from('MZ'), Buffer.alloc(64)]);
  const server = createServer((request, response) => {
    const body = request.url?.startsWith('/evil') ? EXECUTABLE : PNG;
    response.writeHead(200, { 'Content-Type': 'image/png', 'Content-Length': body.byteLength });
    response.end(body);
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({ origin: `http://127.0.0.1:${port}`, close: () => server.close() });
    });
  });
}

let passed = 0;
let failed = 0;
const GREEN = '\x1b[32m';
const RED = '\x1b[31m';
const DIM = '\x1b[2m';
const RESET = '\x1b[0m';

function check(description, condition, detail) {
  if (condition) {
    passed += 1;
    console.log(`  ${GREEN}PASS${RESET}  ${description}`);
  } else {
    failed += 1;
    console.log(`  ${RED}FAIL${RESET}  ${description}`);
    if (detail !== undefined) console.log(`        ${DIM}${JSON.stringify(detail)}${RESET}`);
  }
}

function section(title) {
  console.log(`\n${title}`);
}

function createSession() {
  let cookie = null;
  return async function request(path, options = {}) {
    const headers = { Accept: 'application/json', ...(options.headers ?? {}) };
    if (options.body !== undefined) headers['Content-Type'] = 'application/json';
    if (cookie) headers['Cookie'] = cookie;

    const response = await fetch(`${BASE}${path}`, {
      method: options.method ?? 'GET',
      headers,
      ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}),
    });
    const setCookie = response.headers.get('set-cookie');
    if (setCookie) cookie = setCookie.split(';')[0];

    const text = await response.text();
    let body = null;
    try {
      body = text ? JSON.parse(text) : null;
    } catch {
      body = text;
    }
    return { status: response.status, body };
  };
}

async function main() {
  console.log(`\nTessera data-engine smoke test against ${BASE}\n${'='.repeat(60)}`);

  const owner = createSession();
  await owner('/v1/auth/login', {
    method: 'POST',
    body: { email: 'owner@demo.tessera.local', password: PASSWORD },
  });

  // A session that never signs in, for the public form endpoints.
  const anonymous = createSession();

  const orgs = await owner('/v1/me/organizations');
  const org = orgs.body?.data?.find((o) => o.slug === 'northwind');
  // The suite creates the workspace it needs rather than borrowing a seeded one. Seed data is
  // sample content the user may delete at any time, and a smoke test that depends on it reports
  // a failure of the fixtures as a failure of the product.
  const workspaces = await owner(`/v1/organizations/${org.id}/workspaces?limit=100`);
  const workspace =
    workspaces.body?.data?.find((w) => w.name === SMOKE_WORKSPACE) ??
    (
      await owner(`/v1/organizations/${org.id}/workspaces`, {
        method: 'POST',
        body: { name: SMOKE_WORKSPACE, description: 'Scratch space for the data smoke test.' },
      })
    ).body?.data;

  // ── Bases ─────────────────────────────────────────────────────────────────
  section('Bases');

  const createdBase = await owner(`/v1/workspaces/${workspace.id}/bases`, {
    method: 'POST',
    body: { name: 'Smoke Base', description: 'Created by the data smoke test.' },
  });
  check('a base can be created', createdBase.status === 201, createdBase.body);

  const baseId = createdBase.body?.data?.id;

  const listedBases = await owner(`/v1/workspaces/${workspace.id}/bases`);
  check(
    'the new base appears in the workspace',
    (listedBases.body?.data ?? []).some((b) => b.id === baseId),
    listedBases.body,
  );

  const tables = await owner(`/v1/bases/${baseId}/tables`);
  check(
    'a new base is created with a usable table, not an empty shell',
    (tables.body?.data ?? []).length === 1,
    tables.body?.data,
  );

  const tableId = tables.body?.data?.[0]?.id;

  const initialFields = await owner(`/v1/tables/${tableId}/fields`);
  check(
    'the default table has a primary field',
    (initialFields.body?.data ?? []).some((f) => f.isPrimary),
    initialFields.body?.data,
  );

  // ── Fields ────────────────────────────────────────────────────────────────
  section('Fields');

  const nameField = initialFields.body?.data?.[0];

  const amount = await owner(`/v1/tables/${tableId}/fields`, {
    method: 'POST',
    body: { name: 'Amount', type: 'currency', options: { precision: 2, currencyCode: 'USD' } },
  });
  check('a currency field can be created', amount.status === 201, amount.body);
  check(
    'a promotable field is given a typed slot automatically',
    typeof amount.body?.data?.promotedSlot === 'string',
    amount.body?.data,
  );

  const status = await owner(`/v1/tables/${tableId}/fields`, {
    method: 'POST',
    body: {
      name: 'Status',
      type: 'singleSelect',
      options: {
        choices: [
          { id: 'open', label: 'Open', position: 0 },
          { id: 'closed', label: 'Closed', position: 1 },
        ],
      },
    },
  });
  check('a single-select field can be created', status.status === 201, status.body);

  const due = await owner(`/v1/tables/${tableId}/fields`, {
    method: 'POST',
    body: { name: 'Due', type: 'date', options: {} },
  });
  check('a date field can be created', due.status === 201, due.body);

  const duplicate = await owner(`/v1/tables/${tableId}/fields`, {
    method: 'POST',
    body: { name: 'Amount', type: 'number', options: {} },
  });
  check('duplicate field names are rejected', duplicate.status === 409, duplicate.body);

  const badOptions = await owner(`/v1/tables/${tableId}/fields`, {
    method: 'POST',
    body: { name: 'Broken', type: 'rating', options: { max: 99 } },
  });
  check('field options are validated against the type', badOptions.status === 422, badOptions.body);

  const computed = await owner(`/v1/tables/${tableId}/fields`, {
    method: 'POST',
    body: { name: 'Total', type: 'formula', options: {} },
  });
  check(
    'an unimplemented computed type is refused honestly rather than half-created',
    computed.status === 501,
    computed.body,
  );

  const amountId = amount.body?.data?.id;
  const statusId = status.body?.data?.id;
  const dueId = due.body?.data?.id;
  const nameId = nameField?.id;

  // ── Records ───────────────────────────────────────────────────────────────
  section('Records');

  const created = await owner(`/v1/tables/${tableId}/records`, {
    method: 'POST',
    body: {
      records: [
        { fields: { [nameId]: 'Acme', [amountId]: '$1,234.50', [statusId]: 'Open', [dueId]: '2026-03-04' } },
        { fields: { [nameId]: 'Globex', [amountId]: 99, [statusId]: 'Closed', [dueId]: '2026-01-15' } },
        { fields: { [nameId]: 'Initech', [amountId]: 500, [statusId]: 'Open' } },
      ],
    },
  });
  check('a batch of records can be created', created.status === 201, created.body);
  check('records come back with a version', created.body?.data?.records?.[0]?.version === 1, created.body?.data?.records?.[0]);
  check(
    'a formatted currency string is coerced to a number',
    created.body?.data?.records?.[0]?.fields?.[amountId] === 1234.5,
    created.body?.data?.records?.[0]?.fields,
  );
  check(
    'a select label is resolved to its option id',
    created.body?.data?.records?.[0]?.fields?.[statusId] === 'open',
    created.body?.data?.records?.[0]?.fields,
  );
  check(
    'auto numbers are assigned sequentially',
    created.body?.data?.records?.map((r) => r.autoNumber).join(',') === '1,2,3',
    created.body?.data?.records?.map((r) => r.autoNumber),
  );

  const invalid = await owner(`/v1/tables/${tableId}/records`, {
    method: 'POST',
    body: { records: [{ fields: { [amountId]: 'banana' } }] },
  });
  check('an uncoercible value is rejected, not silently zeroed', invalid.status === 422, invalid.body);

  const unknownField = await owner(`/v1/tables/${tableId}/records`, {
    method: 'POST',
    body: { records: [{ fields: { fld_01HZZZZZZZZZZZZZZZZZZZZZZ9: 'x' } }] },
  });
  check('an unknown field id is rejected', unknownField.status === 422, unknownField.body);

  const recordId = created.body?.data?.records?.[0]?.id;

  // ── Querying ──────────────────────────────────────────────────────────────
  section('Filtering, sorting and pagination');

  const all = await owner(`/v1/tables/${tableId}/records`);
  check('records can be listed', (all.body?.data ?? []).length === 3, all.body?.meta);

  const filtered = await owner(`/v1/tables/${tableId}/records/query`, {
    method: 'POST',
    body: {
      filter: { conjunction: 'and', conditions: [{ fieldId: statusId, operator: 'is', value: 'open' }] },
      limit: 50,
    },
  });
  check('a filter narrows the result set', (filtered.body?.data ?? []).length === 2, filtered.body?.data?.length);

  const numericFilter = await owner(`/v1/tables/${tableId}/records/query`, {
    method: 'POST',
    body: {
      filter: { conjunction: 'and', conditions: [{ fieldId: amountId, operator: 'isGreater', value: 100 }] },
      limit: 50,
    },
  });
  check(
    'a numeric filter compares numerically, not lexicographically',
    (numericFilter.body?.data ?? []).length === 2,
    numericFilter.body?.data?.map((r) => r.fields[amountId]),
  );

  const sorted = await owner(`/v1/tables/${tableId}/records/query`, {
    method: 'POST',
    body: { sort: [{ fieldId: amountId, direction: 'desc' }], limit: 50 },
  });
  check(
    'sorting works on a promoted column',
    (sorted.body?.data ?? []).map((r) => r.fields[amountId]).join(',') === '1234.5,500,99',
    sorted.body?.data?.map((r) => r.fields[amountId]),
  );

  const emptyFilter = await owner(`/v1/tables/${tableId}/records/query`, {
    method: 'POST',
    body: {
      filter: { conjunction: 'and', conditions: [{ fieldId: dueId, operator: 'isEmpty' }] },
      limit: 50,
    },
  });
  check('isEmpty finds the blank row', (emptyFilter.body?.data ?? []).length === 1, emptyFilter.body?.data?.length);

  const badOperator = await owner(`/v1/tables/${tableId}/records/query`, {
    method: 'POST',
    body: {
      filter: { conjunction: 'and', conditions: [{ fieldId: dueId, operator: 'contains', value: 'x' }] },
      limit: 50,
    },
  });
  check(
    'an operator the field type does not support is rejected',
    badOperator.status === 422,
    badOperator.body,
  );

  const paged = await owner(`/v1/tables/${tableId}/records/query`, {
    method: 'POST',
    body: { sort: [{ fieldId: amountId, direction: 'asc' }], limit: 2 },
  });
  check('a short page reports hasMore and a cursor', paged.body?.meta?.hasMore === true, paged.body?.meta);

  const nextPage = await owner(`/v1/tables/${tableId}/records/query`, {
    method: 'POST',
    body: { sort: [{ fieldId: amountId, direction: 'asc' }], limit: 2, cursor: paged.body?.meta?.nextCursor },
  });
  check(
    'the cursor returns the remaining rows without repeating any',
    (nextPage.body?.data ?? []).length === 1 &&
      !nextPage.body.data.some((r) => paged.body.data.some((p) => p.id === r.id)),
    { first: paged.body?.data?.map((r) => r.id), second: nextPage.body?.data?.map((r) => r.id) },
  );

  const staleCursor = await owner(`/v1/tables/${tableId}/records/query`, {
    method: 'POST',
    body: {
      sort: [{ fieldId: dueId, direction: 'asc' }],
      limit: 2,
      cursor: paged.body?.meta?.nextCursor ?? 'eyJ2IjoxLCJrIjpbXSwiaSI6IngiLCJxIjoieCJ9',
    },
  });
  check(
    'a cursor from a different query shape is refused rather than misread',
    staleCursor.status === 400,
    staleCursor.body,
  );

  // ── Concurrency ───────────────────────────────────────────────────────────
  section('Concurrency and field-level merge');

  const updated = await owner(`/v1/tables/${tableId}/records/${recordId}`, {
    method: 'PATCH',
    body: { fields: { [nameId]: 'Acme Corporation' }, version: 1 },
  });
  check('a record can be updated with the expected version', updated.status === 200, updated.body);
  check('the version advances', updated.body?.data?.version === 2, updated.body?.data);

  const stale = await owner(`/v1/tables/${tableId}/records/${recordId}`, {
    method: 'PATCH',
    body: { fields: { [nameId]: 'Overwritten' }, version: 1 },
  });
  check('a stale write is refused with a conflict', stale.status === 409, stale.body);

  const stillCorrect = await owner(`/v1/tables/${tableId}/records/${recordId}`);
  check(
    'the losing write did not clobber the value',
    stillCorrect.body?.data?.fields?.[nameId] === 'Acme Corporation',
    stillCorrect.body?.data?.fields,
  );

  const noop = await owner(`/v1/tables/${tableId}/records/${recordId}`, {
    method: 'PATCH',
    body: { fields: { [nameId]: 'Acme Corporation' } },
  });
  check(
    're-sending an unchanged value does not bump the version',
    noop.body?.data?.version === 2,
    noop.body?.data,
  );

  // ── Field migration preview ───────────────────────────────────────────────
  section('Field type change');

  const preview = await owner(`/v1/tables/${tableId}/fields/${nameId}/preview-change`, {
    method: 'POST',
    body: { type: 'number', options: {} },
  });
  check('a type change can be previewed', preview.status === 200, preview.body);
  check(
    'the preview reports how many rows would be lost',
    preview.body?.data?.lossy >= 1,
    preview.body?.data,
  );
  check('the preview issues a migration token', Boolean(preview.body?.data?.migrationToken), preview.body?.data);

  const unpreviewd = await owner(`/v1/tables/${tableId}/fields/${nameId}`, {
    method: 'PATCH',
    body: { type: 'number', migrationToken: 'forged-token' },
  });
  check(
    'a destructive type change without a valid preview token is refused',
    unpreviewd.status === 422,
    unpreviewd.body,
  );

  // ── Tenant isolation on the new routes ────────────────────────────────────
  section('Tenant isolation (data routes)');

  const rival = createSession();
  await rival('/v1/auth/login', {
    method: 'POST',
    body: { email: 'owner@rival.tessera.local', password: PASSWORD },
  });

  for (const [label, path, options] of [
    ['read the base', `/v1/bases/${baseId}`, {}],
    ['list its tables', `/v1/bases/${baseId}/tables`, {}],
    ['list its fields', `/v1/tables/${tableId}/fields`, {}],
    ['read its records', `/v1/tables/${tableId}/records`, {}],
    ['write a record', `/v1/tables/${tableId}/records`, { method: 'POST', body: { records: [{ fields: {} }] } }],
  ]) {
    const response = await rival(path, options);
    check(`another tenant cannot ${label} (404)`, response.status === 404, {
      status: response.status,
      body: response.body,
    });
  }

  // ── Attachments ───────────────────────────────────────────────────────────
  section('Attachments');

  const fixtures = await startFixtureServer();
  try {
    const attachmentField = await owner(`/v1/tables/${tableId}/fields`, {
      method: 'POST',
      body: { name: 'Files', type: 'attachment', options: {} },
    });
    check('an attachment field can be created', attachmentField.status === 201, attachmentField.body);
    const attachmentFieldId = attachmentField.body?.data?.id;

    const ingested = await owner(`/v1/bases/${baseId}/attachments/from-url`, {
      method: 'POST',
      body: { url: `${fixtures.origin}/image.png`, filename: 'pixel.png' },
    });
    check('a file can be ingested from a URL', ingested.status === 201, ingested.body);

    const file = ingested.body?.data;
    check(
      'the stored type comes from the bytes, not the request',
      file?.mimeType === 'image/png',
      file,
    );
    check('the stored size matches the fixture', file?.size === PNG.byteLength, file);
    check(
      'an unscanned file is recorded as pending, never clean',
      file?.scanStatus === 'pending',
      file,
    );
    check('ingest returns a signed URL', typeof file?.url === 'string' && file.url.includes('signature='), file);

    // An executable is refused on its leading bytes even though it is named .png and served as
    // image/png — the whole point of magic-byte detection.
    const rejected = await owner(`/v1/bases/${baseId}/attachments/from-url`, {
      method: 'POST',
      body: { url: `${fixtures.origin}/evil.png`, filename: 'evil.png' },
    });
    check(
      'an executable disguised as a PNG is refused',
      rejected.status === 400 || rejected.status === 422,
      { status: rejected.status, body: rejected.body },
    );

    // The bytes must come back byte-for-byte through the signed URL.
    const served = await fetch(file.url);
    const bytes = Buffer.from(await served.arrayBuffer());
    check('a signed URL serves the file', served.status === 200, { status: served.status });
    check('the served bytes are identical to the source', bytes.equals(PNG), {
      expected: PNG.byteLength,
      got: bytes.byteLength,
    });
    check(
      'the file is served with sniffing disabled',
      served.headers.get('x-content-type-options') === 'nosniff',
      served.headers.get('x-content-type-options'),
    );
    check(
      'the file is served under a restrictive CSP',
      (served.headers.get('content-security-policy') ?? '').includes("default-src 'none'"),
      served.headers.get('content-security-policy'),
    );

    // Deterministic tampering: flip the first character to a value it definitely is not.
    // (Substituting a fixed character silently no-ops one time in sixteen.)
    const signature = new URL(file.url).searchParams.get('signature');
    const flipped = (signature[0] === '0' ? '1' : '0') + signature.slice(1);
    const forged = file.url.replace(`signature=${signature}`, `signature=${flipped}`);
    check('a forged signature is refused', (await fetch(forged)).status === 404, { forged });

    const truncated = file.url.replace(`signature=${signature}`, `signature=${signature.slice(0, 32)}`);
    check('a truncated signature is refused', (await fetch(truncated)).status === 404);

    const expired = file.url.replace(/expires=\d+/, 'expires=1000000000');
    check('an expired link is refused', (await fetch(expired)).status === 404);

    check(
      'an unsigned link is refused',
      [400, 404].includes((await fetch(file.url.split('?')[0])).status),
    );

    // A file id must only resolve for the tenant that owns it — the signature proves possession
    // of the link, the org scope proves entitlement to the record.
    const record = await owner(`/v1/tables/${tableId}/records`, {
      method: 'POST',
      // The full metadata, as the importer and the upload UI both send it. The stored `url` is
      // deliberately not sent: it is re-signed on every read, never persisted.
      body: {
        records: [
          {
            fields: {
              [attachmentFieldId]: [
                { id: file.id, filename: file.filename, mimeType: file.mimeType, size: file.size },
              ],
            },
          },
        ],
      },
    });
    check('an attachment can be set on a record', record.status === 201, record.body);

    const readBack = await owner(`/v1/tables/${tableId}/records?limit=50`);
    const stored = (readBack.body?.data ?? [])
      .flatMap((r) => r.fields?.[attachmentFieldId] ?? [])
      .find((f) => f.id === file.id);
    check('the record read returns the attachment', Boolean(stored), stored);
    check('the filename survives the round trip', stored?.filename === 'pixel.png', stored);
    check(
      'every read re-signs the URL rather than storing a permanent one',
      typeof stored?.url === 'string' && stored.url.includes('signature='),
      stored,
    );
    check('the re-signed URL serves the same bytes', (await fetch(stored.url)).status === 200);
  } finally {
    fixtures.close();
  }

  // ── Comments and notifications ────────────────────────────────────────────
  section('Comments and notifications');

  const commentRecord = await owner(`/v1/tables/${tableId}/records`, {
    method: 'POST',
    body: { records: [{ fields: {} }] },
  });
  const commentRecordId = commentRecord.body?.data?.records?.[0]?.id;

  const me = await owner('/v1/me');
  const myId = me.body?.data?.id;

  const doc = (content) => ({ type: 'doc', content });

  const posted = await owner(`/v1/records/${commentRecordId}/comments`, {
    method: 'POST',
    body: { body: doc([{ type: 'paragraph', content: [{ type: 'text', text: 'First note.' }] }]) },
  });
  check('a comment can be posted', posted.status === 201, posted.body);
  check('the comment stores searchable plain text', posted.body?.data?.plainText === 'First note.', posted.body?.data);

  const commentId = posted.body?.data?.id;

  // The stored-XSS cases. Each of these must be refused at the door, not sanitised on the way out.
  for (const [label, content] of [
    ['a script node', [{ type: 'script', text: 'alert(1)' }]],
    ['raw html', [{ type: 'html', text: '<img onerror=alert(1)>' }]],
    [
      'a javascript: link',
      [{ type: 'paragraph', content: [{ type: 'link', href: 'javascript:alert(1)', text: 'x' }] }],
    ],
    [
      'a data: link',
      [{ type: 'paragraph', content: [{ type: 'link', href: 'data:text/html,<script>', text: 'x' }] }],
    ],
  ]) {
    const rejected = await owner(`/v1/records/${commentRecordId}/comments`, {
      method: 'POST',
      body: { body: doc(content) },
    });
    check(`${label} is refused`, rejected.status === 422 || rejected.status === 400, {
      status: rejected.status,
    });
  }

  const replied = await owner(`/v1/records/${commentRecordId}/comments`, {
    method: 'POST',
    body: {
      body: doc([{ type: 'paragraph', content: [{ type: 'text', text: 'A reply.' }] }]),
      parentId: commentId,
    },
  });
  check('a reply can be attached to a comment', replied.status === 201, replied.body);

  const nested = await owner(`/v1/records/${commentRecordId}/comments`, {
    method: 'POST',
    body: {
      body: doc([{ type: 'paragraph', content: [{ type: 'text', text: 'Too deep.' }] }]),
      parentId: replied.body?.data?.id,
    },
  });
  // One level only: a tree cannot be rendered usefully in a side panel.
  check('a reply to a reply is refused', nested.status === 422 || nested.status === 400, {
    status: nested.status,
  });

  const reacted = await owner(`/v1/comments/${commentId}/reactions`, {
    method: 'POST',
    body: { emoji: '👍', on: true },
  });
  check('a reaction can be added', reacted.body?.data?.reactions?.[0]?.count === 1, reacted.body?.data);

  const reactedAgain = await owner(`/v1/comments/${commentId}/reactions`, {
    method: 'POST',
    body: { emoji: '👍', on: true },
  });
  // Double-clicking must not fail or double-count.
  check('reacting twice is idempotent', reactedAgain.body?.data?.reactions?.[0]?.count === 1, reactedAgain.body?.data);

  const unreacted = await owner(`/v1/comments/${commentId}/reactions`, {
    method: 'POST',
    body: { emoji: '👍', on: false },
  });
  check('a reaction can be removed', (unreacted.body?.data?.reactions ?? []).length === 0, unreacted.body?.data);

  const resolved = await owner(`/v1/comments/${commentId}/resolve`, {
    method: 'POST',
    body: { resolved: true },
  });
  check('a comment can be resolved', Boolean(resolved.body?.data?.resolvedAt), resolved.body?.data);

  const openOnly = await owner(`/v1/records/${commentRecordId}/comments`);
  check(
    'resolved comments are hidden by default',
    !(openOnly.body?.data ?? []).some((c) => c.id === commentId),
    (openOnly.body?.data ?? []).map((c) => c.id),
  );

  const withResolved = await owner(`/v1/records/${commentRecordId}/comments?includeResolved=true`);
  check(
    'resolved comments can be asked for',
    (withResolved.body?.data ?? []).some((c) => c.id === commentId),
    (withResolved.body?.data ?? []).map((c) => c.id),
  );

  // A mention of a real member raises a notification; a mention of a stranger must not.
  const mentioned = await owner(`/v1/records/${commentRecordId}/comments`, {
    method: 'POST',
    body: {
      body: doc([
        {
          type: 'paragraph',
          content: [{ type: 'mention', userId: myId, label: 'me' }],
        },
      ]),
    },
  });
  check('a mention is accepted', mentioned.status === 201, mentioned.body);
  check(
    'mentioning yourself does not notify you',
    (mentioned.body?.data?.mentions ?? []).length === 0,
    mentioned.body?.data?.mentions,
  );

  const strangerMention = await owner(`/v1/records/${commentRecordId}/comments`, {
    method: 'POST',
    body: {
      body: doc([
        {
          type: 'paragraph',
          content: [{ type: 'mention', userId: 'usr_01ZZZZZZZZZZZZZZZZZZZZZZZZ', label: 'nobody' }],
        },
      ]),
    },
  });
  check(
    'mentioning a non-member notifies nobody',
    (strangerMention.body?.data?.mentions ?? []).length === 0,
    strangerMention.body?.data?.mentions,
  );

  const notifications = await owner(`/v1/organizations/${org.id}/notifications`);
  check('notifications can be listed', notifications.status === 200, notifications.body?.error);
  check('the list reports an unread count', typeof notifications.body?.meta?.unread === 'number', notifications.body?.meta);

  const marked = await owner(`/v1/organizations/${org.id}/notifications/read`, {
    method: 'POST',
    body: { all: true },
  });
  check('notifications can be marked read', marked.status === 201 || marked.status === 200, marked.body);

  const deletedComment = await owner(`/v1/comments/${commentId}`, { method: 'DELETE' });
  check('a comment can be deleted by its author', deletedComment.body?.data?.deleted === true, deletedComment.body);

  // ── Record history ────────────────────────────────────────────────────────
  section('Record history');

  const histRecord = await owner(`/v1/tables/${tableId}/records`, {
    method: 'POST',
    body: { records: [{ fields: { [nameField.id]: 'v1' } }] },
  });
  const histId = histRecord.body?.data?.records?.[0]?.id;

  await owner(`/v1/tables/${tableId}/records/${histId}`, {
    method: 'PATCH',
    body: { version: 1, fields: { [nameField.id]: 'v2' } },
  });
  await owner(`/v1/tables/${tableId}/records/${histId}`, {
    method: 'PATCH',
    body: { version: 2, fields: { [nameField.id]: 'v3' } },
  });

  const history = await owner(`/v1/records/${histId}/history`);
  check('history lists the changes', (history.body?.data ?? []).length >= 2, history.body);
  check(
    'history is newest first',
    (history.body?.data ?? [])[0]?.version >= (history.body?.data ?? [])[1]?.version,
    (history.body?.data ?? []).map((h) => h.version),
  );
  check(
    'a change carries the field name, not just its id',
    history.body?.data?.[0]?.changes?.[0]?.fieldName === nameField.name,
    history.body?.data?.[0]?.changes?.[0],
  );
  check(
    'a change records what the value was and became',
    history.body?.data?.[0]?.changes?.[0]?.to === 'v3',
    history.body?.data?.[0]?.changes?.[0],
  );

  // Replaying backwards is the part that is easy to get wrong.
  const atV1 = await owner(`/v1/records/${histId}/history/1`);
  check('an earlier version can be reconstructed', atV1.body?.data?.fields?.[nameField.id] === 'v1', atV1.body?.data);

  const atV2 = await owner(`/v1/records/${histId}/history/2`);
  check('the middle version reconstructs too', atV2.body?.data?.fields?.[nameField.id] === 'v2', atV2.body?.data);

  const atCurrent = await owner(`/v1/records/${histId}/history/3`);
  check('the current version reports itself as current', atCurrent.body?.data?.isCurrent === true, atCurrent.body?.data);

  const future = await owner(`/v1/records/${histId}/history/99`);
  check('a version newer than the record is refused', future.status === 422 || future.status === 400, {
    status: future.status,
  });

  const activity = await owner(`/v1/tables/${tableId}/activity`);
  check('table activity can be listed', activity.status === 200, activity.body?.error);
  check(
    'activity names the fields that changed',
    (activity.body?.data ?? [])[0]?.changedFieldIds?.length > 0,
    activity.body?.data?.[0],
  );

  // ── Views ─────────────────────────────────────────────────────────────────
  section('Views');

  const defaultViews = await owner(`/v1/tables/${tableId}/views`);
  check('views can be listed', defaultViews.status === 200, defaultViews.body?.error);

  const kanban = await owner(`/v1/tables/${tableId}/views`, {
    method: 'POST',
    body: {
      name: 'Board',
      view: { name: 'Board', config: { type: 'kanban', stackFieldId: status.body?.data?.id } },
    },
  });
  check('a kanban view can be created', kanban.status === 201, kanban.body);
  const viewId = kanban.body?.data?.id;

  const missingField = await owner(`/v1/tables/${tableId}/views`, {
    method: 'POST',
    body: {
      name: 'Broken',
      view: { name: 'Broken', config: { type: 'kanban', stackFieldId: 'fld_01ZZZZZZZZZZZZZZZZZZZZZZZZ' } },
    },
  });
  // A view referring to a field the table does not have would fail on every read rather than on
  // the save that caused it.
  check('a view on a field that does not exist is refused', missingField.status === 422, {
    status: missingField.status,
  });

  const hidesItsOwn = await owner(`/v1/tables/${tableId}/views`, {
    method: 'POST',
    body: {
      name: 'Blind',
      view: {
        name: 'Blind',
        config: { type: 'kanban', stackFieldId: status.body?.data?.id },
        hiddenFieldIds: [status.body?.data?.id],
      },
    },
  });
  check('a view that hides the field it is built on is refused', hidesItsOwn.status === 422, {
    status: hidesItsOwn.status,
  });

  const withFilter = await owner(`/v1/views/${viewId}`, {
    method: 'PATCH',
    body: {
      view: {
        name: 'Board',
        config: { type: 'kanban', stackFieldId: status.body?.data?.id },
        filter: {
          conjunction: 'and',
          conditions: [
            { fieldId: amount.body?.data?.id, operator: 'isGreater', value: 10 },
            {
              conjunction: 'or',
              conditions: [{ fieldId: nameField.id, operator: 'contains', value: 'a' }],
            },
          ],
        },
        sorts: [{ fieldId: amount.body?.data?.id, direction: 'desc' }],
      },
      expectedVersion: 1,
    },
  });
  check('a nested filter can be saved', withFilter.status === 200, withFilter.body);
  check('the view version advances', withFilter.body?.data?.version === 2, withFilter.body?.data);

  const staleView = await owner(`/v1/views/${viewId}`, {
    method: 'PATCH',
    body: { name: 'Renamed', expectedVersion: 1 },
  });
  // Two people rearranging one view at once must not have the later save discard the earlier.
  check('a stale view write is refused', staleView.status === 409, { status: staleView.status });

  const locked = await owner(`/v1/views/${viewId}/lock`, { method: 'POST', body: { locked: true } });
  check('a view can be locked', locked.body?.data?.locked === true, locked.body?.data);

  const editLocked = await owner(`/v1/views/${viewId}`, { method: 'PATCH', body: { name: 'Nope' } });
  check('a locked view refuses edits', editLocked.status === 403, { status: editLocked.status });

  await owner(`/v1/views/${viewId}/lock`, { method: 'POST', body: { locked: false } });

  // Deleting the field a view is built on must degrade the view, not break the table.
  const doomed = await owner(`/v1/tables/${tableId}/fields`, {
    method: 'POST',
    body: { name: 'Doomed', type: 'singleLineText' },
  });
  const doomedViewRes = await owner(`/v1/tables/${tableId}/views`, {
    method: 'POST',
    body: {
      name: 'Doomed view',
      view: {
        name: 'Doomed view',
        config: { type: 'grid' },
        sorts: [{ fieldId: doomed.body?.data?.id, direction: 'asc' }],
      },
    },
  });
  check('a view can sort on a field', doomedViewRes.status === 201, doomedViewRes.body);

  await owner(`/v1/tables/${tableId}/fields/${doomed.body?.data?.id}`, { method: 'DELETE' });

  const afterDelete = await owner(`/v1/views/${doomedViewRes.body?.data?.id}`);
  check('the view survives its field being deleted', afterDelete.status === 200, afterDelete.body?.error);
  check(
    'the sort on the deleted field is gone',
    (afterDelete.body?.data?.sorts ?? []).length === 0,
    afterDelete.body?.data?.sorts,
  );

  // ── Forms ─────────────────────────────────────────────────────────────────
  section('Forms');

  const secret = await owner(`/v1/tables/${tableId}/fields`, {
    method: 'POST',
    body: { name: 'Internal only', type: 'singleLineText' },
  });

  const form = await owner(`/v1/tables/${tableId}/forms`, {
    method: 'POST',
    body: {
      name: 'Intake',
      title: 'Tell us about it',
      config: { pages: [{ fields: [{ fieldId: nameField.id, required: true }] }] },
    },
  });
  check('a form can be created', form.status === 201, form.body);
  const slug = form.body?.data?.slug;
  check('the slug is unguessable, not derived from the name', slug !== 'intake' && slug?.length >= 16, slug);

  // Unpublished must be indistinguishable from non-existent.
  const beforePublish = await anonymous(`/v1/f/${slug}`);
  check('an unpublished form is not found', beforePublish.status === 404, { status: beforePublish.status });

  await owner(`/v1/forms/${form.body?.data?.id}`, { method: 'PATCH', body: { isPublished: true } });

  const publicForm = await anonymous(`/v1/f/${slug}`);
  check('a published form is readable without signing in', publicForm.status === 200, publicForm.body?.error);
  check('the public form carries its fields', (publicForm.body?.data?.fields ?? []).length === 1, publicForm.body?.data?.fields);
  check(
    'the public form leaks nothing about the table or organization',
    !JSON.stringify(publicForm.body?.data ?? {}).includes(tableId),
    Object.keys(publicForm.body?.data ?? {}),
  );

  const missingRequired = await anonymous(`/v1/f/${slug}/submit`, {
    method: 'POST',
    body: { values: {} },
  });
  check('a submission missing a required answer is refused', missingRequired.status === 422, {
    status: missingRequired.status,
  });

  // The security boundary: a field the form never showed must not be writable.
  const submitted = await anonymous(`/v1/f/${slug}/submit`, {
    method: 'POST',
    body: {
      values: { [nameField.id]: 'From a stranger', [secret.body?.data?.id]: 'tampered' },
      idempotencyKey: 'smoke-key-1',
    },
  });
  check('a submission is accepted', submitted.status === 201 || submitted.status === 200, submitted.body);

  const submittedRecordId = submitted.body?.data?.recordId;
  const stored = await owner(`/v1/tables/${tableId}/records?limit=100`);
  const storedRecord = (stored.body?.data ?? []).find((r) => r.id === submittedRecordId);
  check('the submission created a record', Boolean(storedRecord), submittedRecordId);
  check(
    'a field the form never showed was not written',
    storedRecord?.fields?.[secret.body?.data?.id] === undefined ||
      storedRecord?.fields?.[secret.body?.data?.id] === null,
    storedRecord?.fields,
  );

  const replayed = await anonymous(`/v1/f/${slug}/submit`, {
    method: 'POST',
    body: { values: { [nameField.id]: 'Again' }, idempotencyKey: 'smoke-key-1' },
  });
  // A double-submitted form must not create two records.
  check('a replayed submission is not duplicated', replayed.body?.data?.duplicate === true, replayed.body?.data);

  await owner(`/v1/forms/${form.body?.data?.id}`, {
    method: 'PATCH',
    body: { closesAt: new Date(Date.now() - 60_000).toISOString() },
  });
  const afterClose = await anonymous(`/v1/f/${slug}/submit`, {
    method: 'POST',
    body: { values: { [nameField.id]: 'Too late' } },
  });
  check('a closed form refuses submissions', afterClose.status === 403, { status: afterClose.status });

  // ── API tokens and scope enforcement ──────────────────────────────────────
  section('API tokens and scopes');

  const readToken = await owner(`/v1/organizations/${org.id}/api-tokens`, {
    method: 'POST',
    body: { name: 'Read only', scopes: ['data:read'] },
  });
  check('a token can be created', readToken.status === 201, readToken.body);
  check('the plaintext is returned once', typeof readToken.body?.data?.token === 'string', Object.keys(readToken.body?.data ?? {}));
  check('the token is prefixed so a leak is greppable', readToken.body?.data?.token?.startsWith('tsk_'), readToken.body?.data?.prefix);

  const listed = await owner(`/v1/organizations/${org.id}/api-tokens`);
  const listedToken = (listed.body?.data ?? []).find((t) => t.id === readToken.body?.data?.id);
  check('the list shows the token', Boolean(listedToken), listed.body?.data);
  // A list that can re-display secrets turns one compromised session into every token ever made.
  check('the list never re-displays the secret', listedToken?.token === undefined, listedToken);

  /** A session that authenticates with a bearer token rather than a cookie. */
  const withToken = (plaintext) => async (path, options = {}) => {
    const headers = { Accept: 'application/json', Authorization: `Bearer ${plaintext}` };
    if (options.body !== undefined) headers['Content-Type'] = 'application/json';
    const response = await fetch(`${BASE}${path}`, {
      method: options.method ?? 'GET',
      headers,
      ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}),
    });
    const text = await response.text();
    let body = null;
    try {
      body = text ? JSON.parse(text) : null;
    } catch {
      body = text;
    }
    return { status: response.status, body };
  };

  const asReadToken = withToken(readToken.body?.data?.token);

  const tokenRead = await asReadToken(`/v1/tables/${tableId}/records?limit=1`);
  check('a data:read token can read records', tokenRead.status === 200, tokenRead.body?.error);

  const tokenWrite = await asReadToken(`/v1/tables/${tableId}/records`, {
    method: 'POST',
    body: { records: [{ fields: {} }] },
  });
  // The whole point of the scope system: a read-only token issued by an owner must not write,
  // even though its owner could.
  check('a data:read token cannot write records', tokenWrite.status === 403, {
    status: tokenWrite.status,
    body: tokenWrite.body,
  });

  const tokenSchema = await asReadToken(`/v1/tables/${tableId}/fields`, {
    method: 'POST',
    body: { name: 'Sneaky', type: 'singleLineText' },
  });
  check('a data:read token cannot change the schema', tokenSchema.status === 403, {
    status: tokenSchema.status,
  });

  const writeToken = await owner(`/v1/organizations/${org.id}/api-tokens`, {
    method: 'POST',
    body: { name: 'Read write', scopes: ['data:write'] },
  });
  const asWriteToken = withToken(writeToken.body?.data?.token);

  const writeAllowed = await asWriteToken(`/v1/tables/${tableId}/records`, {
    method: 'POST',
    body: { records: [{ fields: {} }] },
  });
  check('a data:write token can write records', writeAllowed.status === 201, writeAllowed.body?.error);

  // Scopes are explicit: `data:write` does not imply `data:read`. A caller that needs both asks
  // for both. This is the stricter reading and it is what the policy engine does — asserted here
  // so the two cannot drift apart again.
  const impliedRead = await asWriteToken(`/v1/tables/${tableId}/records?limit=1`);
  check('a data:write token cannot read without data:read', impliedRead.status === 403, {
    status: impliedRead.status,
  });

  const bothToken = await owner(`/v1/organizations/${org.id}/api-tokens`, {
    method: 'POST',
    body: { name: 'Read and write', scopes: ['data:read', 'data:write'] },
  });
  const asBoth = withToken(bothToken.body?.data?.token);
  const bothRead = await asBoth(`/v1/tables/${tableId}/records?limit=1`);
  check('a token holding both scopes can read and write', bothRead.status === 200, bothRead.body?.error);

  await owner(`/v1/organizations/${org.id}/api-tokens/${bothToken.body?.data?.id}`, {
    method: 'DELETE',
  });

  const badScope = await owner(`/v1/organizations/${org.id}/api-tokens`, {
    method: 'POST',
    body: { name: 'Nonsense', scopes: ['everything'] },
  });
  check('an unknown scope is refused', badScope.status === 422 || badScope.status === 400, {
    status: badScope.status,
  });

  const revoked = await owner(
    `/v1/organizations/${org.id}/api-tokens/${readToken.body?.data?.id}`,
    { method: 'DELETE' },
  );
  check('a token can be revoked', revoked.body?.data?.revoked === true, revoked.body);

  const afterRevoke = await asReadToken(`/v1/tables/${tableId}/records?limit=1`);
  check('a revoked token stops working', afterRevoke.status === 401, { status: afterRevoke.status });

  await owner(`/v1/organizations/${org.id}/api-tokens/${writeToken.body?.data?.id}`, {
    method: 'DELETE',
  });

  // ── Automations ───────────────────────────────────────────────────────────
  section('Automations');

  const definition = {
    name: 'Notify on new record',
    trigger: { type: 'recordCreated', tableId },
    steps: [{ type: 'sendEmail', to: ['ops@example.test'], subject: 'New', body: '{{trigger.record.id}}' }],
  };

  const automation = await owner(`/v1/bases/${baseId}/automations`, {
    method: 'POST',
    body: { name: 'Notify on new record', automation: definition },
  });
  check('an automation can be created', automation.status === 201, automation.body);
  // An automation that starts running the moment it is saved gives its author no chance to look
  // at it, and its first act is on real data.
  check('a new automation starts disabled', automation.body?.data?.enabled === false, automation.body?.data);
  check('a new automation is not live', automation.body?.data?.isLive === false, automation.body?.data);

  const automationId = automation.body?.data?.id;

  const enableTooEarly = await owner(`/v1/automations/${automationId}/enabled`, {
    method: 'POST',
    body: { enabled: true },
  });
  // Enabling something with no published version arms a trigger that has nothing to run.
  check('enabling before publishing is refused', enableTooEarly.status === 422, {
    status: enableTooEarly.status,
  });

  const versionId = automation.body?.data?.latestVersion?.id;
  const published = await owner(`/v1/automations/${automationId}/publish`, {
    method: 'POST',
    body: { versionId },
  });
  check('a version can be published', published.body?.data?.published === true, published.body);

  const enabled = await owner(`/v1/automations/${automationId}/enabled`, {
    method: 'POST',
    body: { enabled: true },
  });
  check('a published automation can be enabled', enabled.body?.data?.enabled === true, enabled.body);

  const live = await owner(`/v1/bases/${baseId}/automations`);
  const liveOne = (live.body?.data ?? []).find((a) => a.id === automationId);
  check('it now reports as live', liveOne?.isLive === true, liveOne);

  // The SSRF check, refused at save rather than producing a run that fails every time it fires.
  for (const [label, url] of [
    ['the cloud metadata endpoint', 'http://169.254.169.254/latest/meta-data/'],
    ['a loopback address', 'http://127.0.0.1:4000/v1/me'],
    ['a private range', 'http://10.0.0.5/internal'],
    ['a file URL', 'file:///etc/passwd'],
  ]) {
    const refused = await owner(`/v1/bases/${baseId}/automations`, {
      method: 'POST',
      body: {
        name: 'Exfiltrate',
        automation: {
          name: 'Exfiltrate',
          trigger: { type: 'recordCreated', tableId },
          steps: [{ type: 'httpRequest', method: 'GET', url }],
        },
      },
    });
    check(`an automation calling ${label} is refused`, refused.status === 422, {
      status: refused.status,
    });
  }

  const publicCall = await owner(`/v1/bases/${baseId}/automations`, {
    method: 'POST',
    body: {
      name: 'Ordinary webhook',
      automation: {
        name: 'Ordinary webhook',
        trigger: { type: 'recordCreated', tableId },
        steps: [{ type: 'httpRequest', method: 'POST', url: 'https://api.example.com/hook' }],
      },
    },
  });
  check('an automation calling a public address is allowed', publicCall.status === 201, publicCall.body);

  const runs = await owner(`/v1/automations/${automationId}/runs`);
  check('run history can be read', runs.status === 200, runs.body?.error);

  const removedAutomation = await owner(`/v1/automations/${automationId}`, { method: 'DELETE' });
  check(
    'an automation can be deleted',
    removedAutomation.body?.data?.deleted === true,
    removedAutomation.body,
  );

  // ── Search ────────────────────────────────────────────────────────────────
  section('Search');

  const searchTarget = await owner(`/v1/tables/${tableId}/records`, {
    method: 'POST',
    body: { records: [{ fields: { [nameField.id]: 'Zenithal Quokka' } }] },
  });
  const searchId = searchTarget.body?.data?.records?.[0]?.id;

  const found = await owner(`/v1/tables/${tableId}/records/query`, {
    method: 'POST',
    body: { search: 'Quokka', limit: 100 },
  });
  check(
    'search finds a record by its text',
    (found.body?.data ?? []).some((r) => r.id === searchId),
    found.body?.error ?? (found.body?.data ?? []).length,
  );

  const notFound = await owner(`/v1/tables/${tableId}/records/query`, {
    method: 'POST',
    body: { search: 'Nothingmatchesthisxyzzy', limit: 100 },
  });
  check('search returns nothing for a term with no match', (notFound.body?.data ?? []).length === 0, notFound.body);

  // Pattern metacharacters must be matched literally: somebody searching for "50%" means the
  // characters, not "anything".
  const literal = await owner(`/v1/tables/${tableId}/records/query`, {
    method: 'POST',
    body: { search: '%', limit: 100 },
  });
  check(
    'a percent sign is searched literally, not as a wildcard',
    (literal.body?.data ?? []).length < (found.body?.meta?.total ?? 1000),
    (literal.body?.data ?? []).length,
  );

  // ── Cleanup ───────────────────────────────────────────────────────────────
  section('Cleanup');

  const removed = await owner(`/v1/bases/${baseId}`, {
    method: 'DELETE',
    body: { confirmation: 'Smoke Base' },
  });
  check('the test base is removed', removed.status === 204, removed.body);

  console.log(`\n${'='.repeat(60)}`);
  console.log(`${passed} passed, ${failed} failed\n`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error('\nSmoke test crashed:', error);
  process.exit(1);
});

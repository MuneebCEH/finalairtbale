/**
 * End-to-end smoke test against a running stack.
 *
 *   node scripts/smoke.mjs [baseUrl]      # default http://localhost:4000
 *
 * Exercises the Phase 1 surface through real HTTP, against the seeded demo data. It is not a
 * replacement for the Playwright suite — it is the thing you run to answer "is this deployment
 * actually working" in ten seconds, and it is deliberately blunt about the two properties that
 * matter most: tenant isolation and server-side permission enforcement.
 *
 * Exits non-zero if any check fails.
 */

const BASE = process.argv[2] ?? 'http://localhost:4000';
const PASSWORD = 'Demo!Passw0rd';

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

/** A minimal cookie jar, so each identity in the test keeps its own session. */
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
      redirect: 'manual',
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

    return { status: response.status, body, headers: response.headers };
  };
}

async function main() {
  console.log(`\nTessera smoke test against ${BASE}\n${'='.repeat(60)}`);

  // ── Health ────────────────────────────────────────────────────────────────
  section('Health');
  const anon = createSession();

  const live = await anon('/health/live');
  check('liveness returns 200', live.status === 200, live.body);

  const ready = await anon('/health/ready');
  check('readiness reports the database is reachable', ready.body?.checks?.database === true, ready.body);
  check(
    'readiness does not fail merely because the cache is down',
    ready.status === 200,
    ready.body,
  );

  // ── Authentication ────────────────────────────────────────────────────────
  section('Authentication');

  const unauth = await anon('/v1/me');
  check('unauthenticated request is rejected with 401', unauth.status === 401, unauth.body);
  check(
    'error body carries a code and a request id',
    unauth.body?.error?.code === 'UNAUTHENTICATED' && Boolean(unauth.body?.error?.requestId),
    unauth.body,
  );

  const wrongPassword = await anon('/v1/auth/login', {
    method: 'POST',
    body: { email: 'owner@demo.tessera.local', password: 'not-the-password' },
  });
  check('wrong password is rejected', wrongPassword.status === 401, wrongPassword.body);

  const unknownUser = await anon('/v1/auth/login', {
    method: 'POST',
    body: { email: 'nobody@nowhere.invalid', password: 'not-the-password' },
  });
  check(
    'unknown account is indistinguishable from a wrong password (no user enumeration)',
    unknownUser.status === wrongPassword.status &&
      unknownUser.body?.error?.message === wrongPassword.body?.error?.message,
    { unknownUser: unknownUser.body, wrongPassword: wrongPassword.body },
  );

  const badPayload = await anon('/v1/auth/login', {
    method: 'POST',
    body: { email: 'not-an-email', password: '' },
  });
  check('malformed payload returns 422 with field issues', badPayload.status === 422, badPayload.body);

  const massAssignment = await anon('/v1/auth/register', {
    method: 'POST',
    body: {
      email: `probe-${Date.now()}@example.test`,
      password: 'correct horse battery staple',
      name: 'Probe',
      acceptedTerms: true,
      isPlatformAdmin: true,
      role: 'owner',
    },
  });
  check(
    'unknown properties are rejected, not silently ignored (mass assignment)',
    massAssignment.status === 422,
    massAssignment.body,
  );

  // ── Session ───────────────────────────────────────────────────────────────
  section('Owner session');
  const owner = createSession();

  const login = await owner('/v1/auth/login', {
    method: 'POST',
    body: { email: 'owner@demo.tessera.local', password: PASSWORD },
  });
  check('owner signs in', login.status === 200, login.body);
  check(
    'session cookie is HttpOnly',
    (login.headers.get('set-cookie') ?? '').toLowerCase().includes('httponly'),
    login.headers.get('set-cookie'),
  );

  const me = await owner('/v1/me');
  check('authenticated profile is returned', me.body?.data?.email === 'owner@demo.tessera.local', me.body);

  const orgs = await owner('/v1/me/organizations');
  const northwind = orgs.body?.data?.find((o) => o.slug === 'northwind');
  check('owner sees exactly their own organizations', orgs.body?.data?.length === 1, orgs.body);
  check('Northwind is present with the owner role', northwind?.role === 'owner', northwind);

  // ── Workspaces ────────────────────────────────────────────────────────────
  section('Workspaces');

  const created = await owner(`/v1/organizations/${northwind.id}/workspaces`, {
    method: 'POST',
    body: { name: `Smoke ${Date.now()}`, description: 'Created by the smoke test.' },
  });
  check('a workspace can be created', created.status === 201, created.body);

  const workspaces = await owner(`/v1/organizations/${northwind.id}/workspaces?limit=50`);
  const names = (workspaces.body?.data ?? []).map((w) => w.name);
  // Asserts on the workspace this run just created, not on seeded fixtures. The seed is sample
  // data the user is free to delete; a suite that fails because they did is a suite that gets
  // ignored — and an ignored smoke test protects nothing.
  check('the new workspace is listed', names.includes(created.body?.data?.name), names);
  check('response carries pagination metadata', workspaces.body?.meta !== undefined, workspaces.body?.meta);

  const renamed = await owner(`/v1/workspaces/${created.body?.data?.id}`, {
    method: 'PATCH',
    body: { name: 'Smoke renamed' },
  });
  check('a workspace can be renamed', renamed.body?.data?.name === 'Smoke renamed', renamed.body);

  const wrongConfirmation = await owner(`/v1/workspaces/${created.body?.data?.id}`, {
    method: 'DELETE',
    body: { confirmation: 'not the name' },
  });
  check(
    'deletion requires the exact workspace name as confirmation',
    wrongConfirmation.status === 422,
    wrongConfirmation.body,
  );

  const deleted = await owner(`/v1/workspaces/${created.body?.data?.id}`, {
    method: 'DELETE',
    body: { confirmation: 'Smoke renamed' },
  });
  check('deletion succeeds with the correct confirmation', deleted.status === 204, deleted.body);

  // ── Permissions ───────────────────────────────────────────────────────────
  section('Permissions (enforced server-side)');
  const viewer = createSession();

  await viewer('/v1/auth/login', {
    method: 'POST',
    body: { email: 'viewer@demo.tessera.local', password: PASSWORD },
  });

  const viewerReads = await viewer(`/v1/organizations/${northwind.id}`);
  check('a member can read the organization', viewerReads.status === 200, viewerReads.body);

  const viewerMe = await viewer('/v1/me');
  const viewerId = viewerMe.body?.data?.id;

  const viewerRenames = await viewer(`/v1/organizations/${northwind.id}`, {
    method: 'PATCH',
    body: { name: 'Hijacked' },
  });
  check('a member cannot rename the organization', viewerRenames.status === 403, viewerRenames.body);

  const viewerInvites = await viewer(`/v1/organizations/${northwind.id}/invitations`, {
    method: 'POST',
    body: { emails: ['someone@example.test'], role: 'member' },
  });
  check(
    'a member cannot invite while the organization setting is off',
    viewerInvites.status === 403,
    viewerInvites.body,
  );

  // Two workspaces this run owns: one the member is granted, one it is not. Created here rather
  // than assumed from the seed, so the assertion holds whatever data the account happens to hold.
  const grantedWorkspace = await owner(`/v1/organizations/${northwind.id}/workspaces`, {
    method: 'POST',
    body: { name: `Visible ${Date.now()}` },
  });
  const hiddenWorkspace = await owner(`/v1/organizations/${northwind.id}/workspaces`, {
    method: 'POST',
    body: { name: `Hidden ${Date.now()}` },
  });

  await owner(`/v1/workspaces/${grantedWorkspace.body?.data?.id}/members`, {
    method: 'POST',
    body: { userId: viewerId, role: 'viewer' },
  });

  const ownerSees = await owner(`/v1/organizations/${northwind.id}/workspaces?limit=100`);
  const viewerSees = await viewer(`/v1/organizations/${northwind.id}/workspaces?limit=100`);

  const ownerNames = (ownerSees.body?.data ?? []).map((w) => w.name);
  const viewerNames = (viewerSees.body?.data ?? []).map((w) => w.name);

  // The property is "visibility follows the grant", not a particular count — a count assertion
  // fails the moment somebody deletes sample data, and teaches people to ignore the suite.
  check(
    'a workspace the member was granted is visible to them',
    viewerNames.includes(grantedWorkspace.body?.data?.name),
    viewerNames,
  );
  check(
    'a workspace the member was not granted is hidden from them',
    !viewerNames.includes(hiddenWorkspace.body?.data?.name),
    viewerNames,
  );
  check(
    'the owner sees both, so the difference is the grant and not the query',
    ownerNames.includes(grantedWorkspace.body?.data?.name) &&
      ownerNames.includes(hiddenWorkspace.body?.data?.name),
    ownerNames,
  );

  // Removed here rather than at the end: a suite that leaves residue eventually fails because of
  // its own leftovers — these two workspaces accumulated until they hit the plan's workspace
  // limit, and the failure looked like a product bug rather than a test one.
  for (const created of [grantedWorkspace, hiddenWorkspace]) {
    await owner(`/v1/workspaces/${created.body?.data?.id}`, {
      method: 'DELETE',
      body: { confirmation: created.body?.data?.name },
    });
  }

  // ── Tenant isolation ──────────────────────────────────────────────────────
  section('Tenant isolation');
  const rival = createSession();

  await rival('/v1/auth/login', {
    method: 'POST',
    body: { email: 'owner@rival.tessera.local', password: PASSWORD },
  });

  const rivalOrgs = await rival('/v1/me/organizations');
  const meridian = rivalOrgs.body?.data?.find((o) => o.slug === 'meridian');
  check('the second organization exists and its owner can see it', Boolean(meridian), rivalOrgs.body);

  const crossRead = await owner(`/v1/organizations/${meridian.id}`);
  check(
    'reading another tenant returns 404, not 403 (existence is not disclosed)',
    crossRead.status === 404,
    crossRead.body,
  );

  const crossList = await owner(`/v1/organizations/${meridian.id}/workspaces`);
  check("listing another tenant's workspaces returns 404", crossList.status === 404, crossList.body);

  const crossWrite = await owner(`/v1/organizations/${meridian.id}`, {
    method: 'PATCH',
    body: { name: 'Taken over' },
  });
  check("writing to another tenant returns 404", crossWrite.status === 404, crossWrite.body);

  const rivalStillIntact = await rival(`/v1/organizations/${meridian.id}`);
  check(
    'the other tenant is unchanged after those attempts',
    rivalStillIntact.body?.data?.name === 'Meridian Freight',
    rivalStillIntact.body,
  );

  // ── Session management ────────────────────────────────────────────────────
  section('Session management');

  const sessions = await owner('/v1/auth/sessions');
  check('the owner can list their sessions', Array.isArray(sessions.body?.data), sessions.body);
  check(
    'the current session is flagged',
    (sessions.body?.data ?? []).some((s) => s.isCurrent === true),
    sessions.body?.data,
  );

  const logout = await owner('/v1/auth/logout', { method: 'POST' });
  check('logout returns 204', logout.status === 204, logout.body);

  const afterLogout = await owner('/v1/me');
  check('the session is dead immediately after logout', afterLogout.status === 401, afterLogout.body);

  // ── Result ────────────────────────────────────────────────────────────────
  console.log(`\n${'='.repeat(60)}`);
  console.log(`${passed} passed, ${failed} failed\n`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error('\nSmoke test crashed:', error);
  process.exit(1);
});

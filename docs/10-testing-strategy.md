# Tessera — Testing Strategy

## 1. Shape

Not a pyramid — a **diamond**. The riskiest defects in a multi-tenant data platform are
integration-level (a permission not enforced, a query not scoped, a migration that locks), not
unit-level. Weighting follows the risk.

```
        ▲  E2E (Playwright)              ~60 specs, critical flows only
       ███  Integration (API + DB)       ~600 tests, the bulk of the value
      █████ Contract / schema            OpenAPI + Zod round-trips
       ███  Unit                         formula engine, query builder, policy engine, field types
        ▼  Static                        tsc --strict, ESLint, SAST, dep + container scan
```

## 2. Levels and tooling

| Level | Tool | Runs on |
|---|---|---|
| Unit | Vitest | every push, < 30 s |
| Integration (API+DB+Redis) | Vitest + Testcontainers (Postgres, Redis, MinIO) | every PR, < 8 min |
| Contract | Vitest + generated OpenAPI client | every PR |
| E2E | Playwright (Chromium, Firefox, WebKit) | every PR (Chromium) + nightly (all three) |
| Accessibility | axe-core in Playwright + jest-axe on components | every PR |
| Load | k6 | nightly + pre-release |
| Security | Semgrep, `npm audit`, Trivy (container), OWASP ZAP baseline | every PR + nightly |
| Migration | custom harness against a production-shaped snapshot | every PR touching `prisma/migrations` |
| Mutation (formula + policy engines only) | Stryker | weekly |

## 3. Non-negotiable suites

### 3.1 Tenant isolation (`packages/testing/isolation`)

The single most important suite in the repository. It runs on **every PR** and blocks merge.

```ts
// For every registered API route, automatically:
//   1. seed two orgs, A and B, each with a full object graph
//   2. authenticate as a member of A
//   3. call the route with B's resource ids substituted
//   4. assert 404 (never 200, never 403 — 403 leaks existence)
//   5. assert no row in B was read or written (verified by checksum + query log inspection)
```

Route discovery is reflective, driven by the Nest router. **A new endpoint is covered the moment
it is registered** — there is no way to add a route and forget the isolation test.

A second half of the suite operates at the repository layer, asserting that every generated SQL
statement contains an `organization_id` predicate, by intercepting the Prisma query event.

### 3.2 Permission matrix (`packages/testing/permissions`)

The matrix in `docs/03` is encoded as data:

```ts
const MATRIX: Array<[Role, Action, Expected]> = [
  ['org:member',        'workspace:create',  'allow-if-setting'],
  ['workspace:viewer',  'record:update',     'deny'],
  ['workspace:commenter','comment:create',   'allow'],
  // …every cell of every table in docs/03
];
```

The test iterates every cell against a real seeded graph through the real HTTP stack. If a doc
cell and the implementation disagree, CI fails — the documentation is executable, so it cannot rot.

### 3.3 Field type conformance

Every field type must pass a shared conformance suite covering: validation accept/reject cases,
serialisation round-trip, JSONB storage/read, filter operators (each declared operator produces
correct results), sort order (including nulls and locale), grouping keys, API representation,
CSV/XLSX import and export round-trip, and permission behaviour when the field is `hidden`.
Adding a field type without registering it in the conformance suite fails the build.

## 4. Critical E2E flows

Each has a Playwright spec, tagged `@critical`, run against a real stack in CI:

| # | Flow |
|---|---|
| 1 | Register → verify email → first login → create organization |
| 2 | Invite member → accept → role enforcement visible in UI and API |
| 3 | Create base → create table → create fields of 6 representative types |
| 4 | Edit records in the grid: type, tab, paste a 20×5 range from the clipboard, undo, redo |
| 5 | Create a linked-record field both ways; link and unlink; verify symmetry |
| 6 | Create a lookup and a rollup; change a source value; assert the dependent value updates |
| 7 | Create a formula field; introduce a cycle; assert rejection with the cycle path |
| 8 | Build a view with nested AND/OR filters, 2 sorts, 1 group; assert row set and order |
| 9 | Build and submit a public form; assert the record and submission metadata |
| 10 | Two browser contexts: presence, live cell update, conflict dialog on the same cell |
| 11 | Comment with an @mention → notification appears for the mentioned user |
| 12 | Build an automation (record updated → update record); trigger it; inspect the run log |
| 13 | Permission enforcement: viewer cannot edit in the UI *and* gets 403 from the API |
| 14 | Import a 5,000-row CSV with 3 bad rows; verify progress, counts, and the error report |
| 15 | Export a view to CSV and XLSX; verify content and formula-injection escaping |
| 16 | Upgrade subscription via Stripe test mode; assert entitlement change takes effect |
| 17 | Account deletion request → data export delivered → erasure completes |
| 18 | API: create a PAT, exercise CRUD, hit the rate limit, verify headers and 429 |
| 19 | Webhook: register endpoint, trigger event, verify signature, force failure, replay |
| 20 | Session management: log in on two devices, revoke one, assert the socket closes |

## 5. Fixtures

`packages/testing/fixtures` provides a fluent builder that produces realistic graphs, not
`user1@test.com` noise:

```ts
const world = await seed()
  .organization('Northwind', o => o
    .plan('professional')
    .member('owner@northwind.test', 'owner')
    .member('editor@northwind.test', 'member')
    .guest('contractor@external.test')
    .workspace('Operations', w => w
      .base('Logistics', b => b
        .table('Shipments', t => t
          .fields(['text:Reference', 'select:Status', 'date:ETA', 'number:Weight'])
          .link('Carrier', 'Carriers')
          .rollup('TotalWeight', 'Carrier', 'Weight', 'SUM')
          .records(5_000)))))
  .organization('Acme', /* … the isolation counterparty … */)
  .build();
```

Every integration test runs in a transaction that is rolled back, or against a template database
cloned per worker (`CREATE DATABASE … TEMPLATE`) — fast and perfectly isolated.

## 6. Migration testing

For each migration PR:
1. Restore a production-shaped anonymised snapshot (10M records).
2. Apply the migration with `lock_timeout=3s` while a synthetic write workload runs.
3. Assert: no statement held `ACCESS EXCLUSIVE` for > 200 ms, no failed application writes, the
   down migration restores the prior schema, and row counts/checksums are unchanged.

## 7. What CI enforces to merge

- `tsc --noEmit` clean across every package, `strict` + `noUncheckedIndexedAccess`.
- ESLint clean, including the custom `tessera/require-tenant-scope` and layering rules.
- Unit + integration + contract suites green.
- Isolation and permission-matrix suites green.
- `@critical` Playwright specs green on Chromium.
- axe-core: zero serious/critical violations on the audited page set.
- Coverage: ≥ 90% on `packages/permissions`, `packages/formula`, `packages/database/query`;
  ≥ 75% overall. Coverage cannot decrease.
- No High/Critical from Semgrep, `npm audit`, or Trivy.
- Migration harness green if `prisma/migrations` changed.

## 8. What we deliberately do not test

- Third-party SDK internals (Stripe, S3) — those are mocked at our adapter boundary, and the
  adapters are contract-tested against the providers' own test modes nightly, not per PR.
- Exact pixel rendering. Visual regression is limited to a small set of design-system stories,
  because full-page screenshot diffing produces more false positives than caught bugs.

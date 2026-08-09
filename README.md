# Tessera

A collaborative relational workspace: structured data with real relationships, edited in a grid
your team already knows how to use, with permissions enforced on the server and automation that
does not require code.

> **Original product.** Tessera is an independently designed platform. It contains no third-party
> branding, source code, icons, copy, or protected design elements.

---

## Current status

**Phase 1 of 9 is implemented.** The application runs, and the foundation is real rather than
scaffolded: authentication, multi-tenancy, organizations, workspaces, the permission engine, and
the design system are complete end to end — data layer, API, UI, validation, authorization, and
tests.

| Phase | Scope | State |
|---|---|---|
| 0 | Architecture and design documents | ✅ Complete — [`docs/`](./docs) |
| 1 | Foundation: auth, tenancy, organizations, workspaces, permissions, design system | ✅ Implemented |
| 2a | Field-type registry (29 types) and the filter/sort/group query engine | ✅ Implemented |
| 2b | Bases, tables, fields and records API | ✅ Implemented |
| 2c | Virtualised grid UI: windowed rows, inline editing, keyboard navigation, column resize | ✅ Implemented |
| 2d | Airtable importer (`packages/importer`) — 30 source field types mapped, confidence-reported | ✅ Implemented |
| 2e | CSV/XLSX import and export | ⬜ Not started |
| 3 | Linked records, lookups, rollups, formula engine, revisions | ⬜ Not started |
| 4 | Real-time collaboration, comments, notifications | ⬜ Not started |
| 5 | Kanban, calendar, gallery, timeline, gantt, forms | ⬜ Not started |
| 6 | Interface builder, automation engine | ⬜ Not started |
| 7 | Public API, tokens, webhooks, SDK, integrations | ⬜ Not started |
| 8 | Billing, SSO, SCIM, admin console | ⬜ Not started |
| 9 | Load testing, security hardening, scale-out | ⬜ Not started |

The roadmap with objectives and exit criteria for each phase is in
[`docs/12-roadmap.md`](./docs/12-roadmap.md).

---

## Getting started

**Requirements:** Node 20.10+, npm 10+, Docker (for Postgres, Redis, MinIO, OpenSearch, Mailpit).

```bash
cp .env.example .env
# Generate the three secrets the app refuses to start without:
node -e "console.log('SESSION_SECRET=' + require('crypto').randomBytes(48).toString('base64url'))"
node -e "console.log('JWT_SECRET=' + require('crypto').randomBytes(48).toString('base64url'))"
node -e "console.log('ENCRYPTION_KEY=' + require('crypto').randomBytes(32).toString('base64'))"

npm install
npm run infra:up          # postgres, redis, minio, opensearch, mailpit
npm run db:migrate        # create the schema
npm run db:secure         # row-level security, indexes, constraints
npm run db:seed           # demo organizations and accounts
npm run dev               # web :3000, api :4000, worker
npm run smoke             # 33 end-to-end checks: auth, tenancy, permissions
npm run smoke:data        # 42 end-to-end checks: bases, fields, records, queries
```

### No Docker?

`npm run db:local` starts a portable PostgreSQL through npm — no installer, no administrator
rights — and everything except the background worker runs against it. The API degrades
gracefully without Redis (the cache falls through to Postgres, the rate limiter fails open) and
`/health/ready` reports `degraded` so the state is visible rather than silent. The worker does
need a real Redis.

```bash
npm run db:local          # leave running; portable postgres on :5432
npm run db:migrate && npm run db:secure && npm run db:seed
npm run dev --workspace=@tessera/api
npm run dev --workspace=@tessera/web
```

| Surface | URL |
|---|---|
| Web application | http://localhost:3000 |
| API | http://localhost:4000/v1 |
| API documentation | http://localhost:4000/v1/docs |
| Mail catcher | http://localhost:8025 |
| Object storage console | http://localhost:9001 |

### Seeded accounts

Password for all of them: `Demo!Passw0rd`

| Email | Role |
|---|---|
| `owner@demo.tessera.local` | Owner of Northwind Logistics |
| `editor@demo.tessera.local` | Member; editor on one workspace only |
| `viewer@demo.tessera.local` | Member; viewer and commenter |
| `guest@external.local` | Guest with no workspace access until granted |
| `owner@rival.tessera.local` | Owner of a second organization — the isolation counterparty |

The second organization exists so tenant isolation is observable immediately: sign in as the
Northwind owner, try to reach anything belonging to Meridian, and you get a 404.

---

## Commands

| Command | Does |
|---|---|
| `npm run dev` | Runs web, API, and worker together |
| `npm run build` | Builds every package and app in dependency order |
| `npm run typecheck` | Strict TypeScript across the monorepo |
| `npm run lint` | ESLint, including the module-boundary and tenant-scope rules |
| `npm test` | Unit and integration suites |
| `npm run test:e2e` | Playwright browser tests |
| `npm run db:migrate` | Applies migrations in development |
| `npm run db:secure` | Applies RLS policies, indexes, and constraints |
| `npm run db:studio` | Prisma's data browser |
| `npm run infra:up` / `infra:down` | Starts and stops the local stack |

---

## Repository layout

```
apps/
  web/        Next.js App Router — the workspace UI and the design system
  api/        NestJS — REST, WebSockets, the guard pipeline
  worker/     BullMQ — recalculation, imports, automations, delivery, maintenance
packages/
  types/      Shared domain types, ids, errors, plans      (no runtime dependencies)
  config/     Environment validation and platform constants
  validation/ Zod schemas shared by the API, the web app, and the SDK
  logger/     Structured logging with secret redaction and correlation context
  permissions/The policy engine, role tables, and the permission inspector
  database/   Prisma schema, tenant-scoped repositories, cache keys, outbox, audit
  auth/       Password hashing, tokens, TOTP, envelope encryption
docs/         Architecture, database, security, API, testing, deployment, roadmap
infra/        Dockerfiles, Compose stack, Kubernetes chart, proxy configuration
```

Dependency rules and their enforcement are in
[`docs/13-monorepo-structure.md`](./docs/13-monorepo-structure.md).

---

## The decisions worth knowing

1. **Hybrid record storage** — a JSONB payload plus promoted typed columns. Schema changes are
   metadata-only, and the fields people actually filter and sort on get real indexes. The four
   rejected alternatives and why they fail are in
   [`docs/02-database-design.md`](./docs/02-database-design.md) §1.

2. **Tenant isolation is structural, not disciplined.** A repository cannot be constructed
   without a tenant context; a custom lint rule catches any query that bypasses the scope helper;
   Postgres row-level security turns anything that still slips through into an empty result set;
   and an automated suite probes every registered route with another tenant's ids.

3. **Protection is the default.** Authentication, tenant resolution, and authorization are global
   guards. A route opts *out* with `@Public()` or `@SkipTenantScope()` — both greppable and
   reviewed. The opposite arrangement makes every forgotten decorator an open endpoint.

4. **No `eval`, ever.** The formula language is a hand-written lexer, parser, type checker, and
   interpreter over a fixed function table, with step and depth budgets.
   ([`docs/07-formula-engine.md`](./docs/07-formula-engine.md))

5. **Conflicts are surfaced, never resolved silently.** Cell edits use field-level guards; when
   two people change the same field, both values are preserved and the user is asked.
   ([`docs/06-realtime-collaboration.md`](./docs/06-realtime-collaboration.md))

6. **Every infrastructure dependency sits behind a port** — storage, mail, secrets, queue,
   search, payments — so the platform is not welded to one cloud.

---

## Documentation

Start with [`docs/README.md`](./docs/README.md), which indexes all fourteen documents and
summarises the six decisions above.

## Security

Report vulnerabilities privately per [`SECURITY.md`](./SECURITY.md). The threat model, permission
matrix, and control inventory are in
[`docs/03-security-and-permissions.md`](./docs/03-security-and-permissions.md).

# Tessera — Monorepo Structure

npm workspaces + Turborepo. (`pnpm` is the preferred tool for a repo this size; npm workspaces is
used here because `pnpm` is not installed on the target machine and the layout is identical — the
switch is a one-line change in `package.json` plus a lockfile regeneration.)

```
tessera/
├── apps/
│   ├── web/                          Next.js 15 App Router
│   │   ├── src/app/
│   │   │   ├── (marketing)/          public pages
│   │   │   ├── (auth)/               login, register, verify, reset, mfa
│   │   │   ├── (workspace)/          authenticated shell
│   │   │   │   ├── [orgSlug]/
│   │   │   │   │   ├── layout.tsx    org chrome, nav, command palette
│   │   │   │   │   ├── page.tsx      org home
│   │   │   │   │   ├── settings/     members, groups, security, billing, audit
│   │   │   │   │   └── w/[workspaceId]/
│   │   │   │   │       ├── page.tsx
│   │   │   │   │       └── b/[baseId]/[tableId]/[viewId]/   ← the grid (Phase 2)
│   │   │   ├── (public)/             shared views, public forms
│   │   │   └── api/                  BFF route handlers (session cookie exchange only)
│   │   ├── src/features/             feature-sliced client code
│   │   │   ├── auth/ organizations/ workspaces/ grid/ views/ records/ …
│   │   │   │   ├── components/  hooks/  stores/  api/  types.ts
│   │   ├── src/lib/                  query client, ws client, theme, analytics
│   │   └── e2e/                      Playwright specs
│   │
│   ├── api/                          NestJS
│   │   ├── src/bootstrap/            middleware, guards, interceptors, filters, openapi
│   │   ├── src/modules/
│   │   │   ├── auth/                 controller · service · strategies · dto
│   │   │   ├── users/ organizations/ workspaces/ bases/ tables/ fields/ records/
│   │   │   ├── views/ comments/ notifications/ automations/ forms/ interfaces/
│   │   │   ├── templates/ integrations/ billing/ search/ audit/ admin/
│   │   │   ├── api-tokens/ webhooks/ files/ usage/ realtime/
│   │   │   └── <module>/
│   │   │       ├── <name>.controller.ts     presentation
│   │   │       ├── <name>.service.ts        application
│   │   │       ├── <name>.policy.ts         authorization rules
│   │   │       ├── domain/                  entities, value objects, events
│   │   │       ├── infra/                   repositories, adapters
│   │   │       └── dto/                     request/response schemas (from packages/validation)
│   │   └── test/                     integration tests
│   │
│   └── worker/                       BullMQ
│       ├── src/runtime/              worker bootstrap, tenant context, graceful shutdown
│       ├── src/handlers/
│       │   ├── compute/ io/ automation/ delivery/ index/ maintenance/
│       └── test/
│
├── packages/
│   ├── ui/                           design system: tokens, primitives, patterns, formula editor
│   ├── database/                     Prisma schema, migrations, tenant-scoped repositories,
│   │                                 query builder, cache keys, shard router seam
│   ├── auth/                         password hashing, tokens, TOTP, session logic, OAuth clients
│   ├── permissions/                  policy engine, role definitions, matrix, explain
│   ├── formula/                      lexer, parser, checker, interpreter, function catalogue
│   ├── config/                       env schema + loader, eslint/tsconfig/tailwind presets
│   ├── types/                        shared domain types (no runtime code)
│   ├── validation/                   Zod schemas shared by API, web, and SDK
│   ├── logger/                       pino wrapper, redaction, correlation ALS
│   ├── events/                       event envelope, outbox, bus port, job dispatcher, breaker
│   ├── sdk/                          generated + hand-written TypeScript client
│   └── testing/                      fixtures, factories, isolation suite, permission matrix,
│                                     conformance harness, k6 load scenarios
│
├── docs/                             this document set + runbooks/
├── infra/
│   ├── docker/                       Dockerfiles per app
│   ├── compose/                      docker-compose.yml + service configs
│   ├── k8s/                          Helm chart: deployments, HPA, KEDA, ingress, PDB
│   └── nginx/                        reverse proxy config
├── .github/workflows/                ci.yml, e2e.yml, security.yml, load.yml, release.yml
├── turbo.json  package.json  tsconfig.base.json  .env.example  README.md
```

## Dependency rules

```
apps/*        → packages/*         ✅
packages/*    → packages/*         ✅  (acyclic; enforced by turbo graph + eslint)
packages/*    → apps/*             ❌
apps/web      → apps/api           ❌  (only via packages/sdk over HTTP)
packages/ui   → packages/database  ❌  (UI never touches data access)
domain/       → infra/             ❌  (inside every module)
```

`packages/types` and `packages/validation` are the only packages every other package may depend
on. `packages/ui` depends on nothing but `types`, `validation`, and `config` — so it can be
extracted or storybooked in isolation.

## Package boundary enforcement

`packages/config/eslint/boundaries.js` configures `import/no-restricted-paths` with the zones
above. Violations are build errors, not warnings. The rule set is also asserted by a
`turbo run lint` job in CI so a new package cannot silently opt out.

## Build graph

```
turbo run build   →  types → validation → config → logger → events → permissions
                                     → database → auth → formula → sdk → ui
                                     → api / worker / web
```

`turbo.json` declares `dependsOn: ["^build"]` with remote caching keyed by content hash, so an
unchanged package is never rebuilt.

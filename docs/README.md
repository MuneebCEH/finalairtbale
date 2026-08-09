# Tessera — Design Documentation

Read in order. Each document is a decision record, not a wish list: where an option was rejected,
the reason is stated.

| # | Document | Answers |
|---|---|---|
| 00 | [Product requirements](./00-product-requirements.md) | Who it is for, what ships in v1, what does not, and the non-functional targets |
| 01 | [System architecture](./01-system-architecture.md) | Topology, layering, request lifecycle, event-driven core, caching, idempotency, failure isolation |
| 02 | [Database design](./02-database-design.md) | The five record-storage models compared, the hybrid choice and why, ERD, relationships, partitioning, concurrency, migration safety |
| 03 | [Security & permissions](./03-security-and-permissions.md) | Threat model, tenant isolation mechanics, principal model, policy engine, full permission matrix, secrets, headers, rate limits, audit |
| 04 | [API specification](./04-api-specification.md) | Conventions, envelopes, error codes, auth, endpoint catalogue, filtering, batching, webhook payloads |
| 05 | [Background jobs](./05-background-jobs.md) | Queue topology, the job contract, idempotency/retry/DLQ/cancellation, notable job designs, backpressure |
| 06 | [Real-time collaboration](./06-realtime-collaboration.md) | Where concurrency actually happens, the write path, conflict handling, presence, transport, catch-up, gateway scaling |
| 07 | [Formula engine](./07-formula-engine.md) | Pipeline, type system, grammar, function catalogue, dependency graph, recalculation, editor, security review |
| 08 | [Automation engine](./08-automation-engine.md) | Versioned graphs, triggers, actions, durable step execution, reliability guarantees, data model |
| 09 | [Scaling strategy](./09-scaling-strategy.md) | Scaling axes, the database ladder, the hot query, frontend budget, load-test scenarios, capacity heuristics |
| 10 | [Testing strategy](./10-testing-strategy.md) | The diamond, the non-negotiable suites, critical E2E flows, fixtures, migration testing, merge gates |
| 11 | [Deployment](./11-deployment.md) | Environments, images, Kubernetes shape, release + rollback, backups and DR, cloud portability, local setup |
| 12 | [Roadmap](./12-roadmap.md) | Nine phases with objectives, deliverables, and exit criteria |
| 13 | [Monorepo structure](./13-monorepo-structure.md) | Folder layout, dependency rules, boundary enforcement, build graph |
| 14 | [Airtable import](./14-airtable-import.md) | Read-only import: tokens, workspace mapping, attachments, type fidelity |

## The six decisions that shape everything else

1. **Hybrid record storage** — JSONB payload plus promoted typed columns. Flexible schema with
   real indexes where it matters. ([02 §1](./02-database-design.md))
2. **Tenant scope is structural, not disciplined** — repositories cannot be constructed without a
   tenant context, RLS is the backstop, and an automated suite probes every route for leakage.
   ([03 §2](./03-security-and-permissions.md))
3. **Field-level conflict surfacing, not OT/CRDT everywhere** — chosen after measuring where
   concurrency actually occurs. ([06 §1](./06-realtime-collaboration.md))
4. **An interpreted formula language, never `eval`** — with budgets, static typing, and cycle
   rejection at save time. ([07](./07-formula-engine.md))
5. **Automations execute as durable per-step jobs on a separate fleet** — versioned, idempotent,
   replayable, and unable to slow a cell edit. ([08](./08-automation-engine.md))
6. **Every infrastructure dependency sits behind a port** — storage, mail, secrets, queue, search,
   payments — so the platform is not welded to one cloud. ([11 §7](./11-deployment.md))

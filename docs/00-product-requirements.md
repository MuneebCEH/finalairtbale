# Tessera — Product Requirements Document

> **Product identity.** The platform is called **Tessera** (a *tessera* is a single tile in a
> mosaic — one record among many that together form a picture). All naming, copy, iconography,
> and visual language are original. No Airtable branding, source, assets, copy, or protected
> design elements are used or reproduced anywhere in this codebase.

---

## 1. Problem statement

Teams model their real work in spreadsheets because spreadsheets are the only tool that is
simultaneously *free-form*, *immediately editable*, and *shareable*. They then outgrow them:
no referential integrity, no permissions below the file level, no automation, no API, no audit
trail, and no way to build a purpose-built UI on top of the data.

The alternatives are worse. A real database requires engineers. A SaaS point-solution locks the
schema. An internal tool built in-house costs a quarter of engineering time and rots.

**Tessera is the middle path**: a relational database whose primary interface is a spreadsheet,
whose secondary interfaces are purpose-built apps, and whose behaviour is programmable without code.

## 2. Target users

| Segment | Size | Primary jobs-to-be-done | Willingness to pay |
|---|---|---|---|
| Solo operator / freelancer | 1 | Track clients, projects, invoices | Free → Starter |
| Startup team | 2–20 | Product roadmap, CRM, hiring pipeline | Starter → Professional |
| Agency | 10–100 | Client workspaces, guest access, reporting | Professional → Business |
| Department in an enterprise | 50–500 | Ops tracking, approvals, internal tools | Business |
| Enterprise IT | 500+ | Governance, SSO, SCIM, audit, residency | Enterprise |

The **primary persona** is the *ops-minded builder*: technical enough to think in tables and
relations, not technical enough (or not resourced) to write and deploy software. Every design
decision resolves in their favour when there is a conflict.

## 3. Product principles

1. **The grid is the product.** Everything else is secondary surface area. If the grid is slow,
   janky, or loses an edit, nothing else matters.
2. **Never lose a keystroke.** Optimistic UI, durable queues, conflict preservation. We would
   rather show a conflict dialog than silently drop a user's edit.
3. **The backend is the authority.** The UI hides things for ergonomics; the server denies them
   for security. Every permission is enforced at the data-access layer.
4. **Escape hatches at every level.** API, webhooks, export, and raw record IDs. Data is never
   held hostage.
5. **Fast by construction, not by optimisation.** Cursor pagination, virtualisation, and
   server-side query pushdown are the default path, not a later refactor.
6. **Multi-tenant from line one.** There is no single-tenant code path to retrofit later.

## 4. Scope — capability inventory

### 4.1 Must-have (v1.0 GA)

| Domain | Capability |
|---|---|
| Identity | Email+password, email verification, magic link, Google/Microsoft OAuth, TOTP 2FA + recovery codes, session management & revocation |
| Tenancy | Organizations → Workspaces → Bases → Tables → Views → Records; users in many orgs |
| Authorization | Role-based at org/workspace/base level; field- and record-level rules; server-enforced; inspectable |
| Data modelling | 40+ field types, linked records (1:1, 1:N, N:M, self-referencing), lookup, rollup, count, formula |
| Grid | Virtualised, frozen columns, inline edit, multi-select, copy/paste from spreadsheets, fill handle, undo/redo |
| Views | Grid, Kanban, Calendar, Gallery, List, Timeline, Gantt, Form, Chart, Dashboard, Map |
| Query | Nested AND/OR filter groups, multi-level sort, multi-level grouping with aggregates |
| Formula | Safe interpreted engine, ~80 functions, static type checking, dependency graph, cycle detection |
| Collaboration | Presence, live cell updates, comments, @mentions, notifications, activity history |
| Forms | Drag-drop builder, conditional visibility, validation, public + authenticated, submission metadata |
| Interfaces | Multi-page no-code app builder over base data, with actions and page permissions |
| Automations | Trigger → condition → action DAG, retries, DLQ, execution logs, versioning, test mode |
| Import/export | CSV, TSV, XLSX, JSON in; CSV, XLSX, JSON, base backup out; async with progress + error report |
| Search | Global, base, table, record, comment; permission-filtered; typo-tolerant |
| API | Versioned REST + OpenAPI, PATs, OAuth apps, scoped keys, rate limits, idempotency, batch ops |
| Webhooks | Signed, retried, replayable, with delivery logs and endpoint health |
| Files | Multipart upload, signed URLs, thumbnails, virus scan, type/size limits |
| History | Record/field/schema revisions, trash with retention, restore |
| Billing | Stripe subscriptions, seat + usage metering, plan enforcement, dunning |
| Admin | Platform console with audited impersonation, feature flags, limits, health |
| Observability | Structured logs, correlation IDs, traces, metrics, alerts |

### 4.2 Explicitly out of scope for v1.0

- Native mobile apps (responsive web only)
- Offline-first / local-first sync
- Real-time collaborative *rich-text* editing inside long-text cells (CRDT) — v1.1
- SAML SSO / SCIM **runtime** (v1 ships the data model and hook points; the IdP integration is Phase 8)
- Regional data residency **enforcement** (v1 ships the region column and routing seam)
- Marketplace for third-party extensions

## 5. Non-functional requirements

| Category | Requirement | Measurement |
|---|---|---|
| Latency | Grid scroll p95 < 16 ms frame time at 100k rows | Browser performance trace in CI |
| Latency | Cell edit → server ack p95 < 200 ms (same region) | API histogram |
| Latency | View query (filter+sort+group, 1M rows) p95 < 400 ms | DB benchmark suite |
| Throughput | 10k concurrent WebSocket clients per gateway node | k6 load test |
| Availability | 99.9% monthly for API; 99.5% for automations | Uptime monitor |
| Durability | RPO 5 min, RTO 1 h | Restore drill, quarterly |
| Correctness | Zero cross-tenant reads | Automated isolation test suite, every PR |
| Accessibility | WCAG 2.2 AA | axe-core in CI + manual audit |
| Security | No OWASP Top 10 findings at High+ | SAST + dependency scan in CI |

## 6. Success metrics

**Activation:** % of new orgs that create a base with ≥1 linked-record field and ≥10 records within 7 days.
**Retention:** W4 workspace retention (any write event).
**Depth:** median views per table; % of bases with ≥1 published automation.
**Reliability:** automation success rate; webhook delivery success rate; conflict rate per 1k edits.
**Commercial:** free→paid conversion; net revenue retention; seats per paying org.

## 7. Key product decisions & rationale

| # | Decision | Rationale | Rejected alternative |
|---|---|---|---|
| P1 | Hybrid record storage: JSONB payload + promoted typed columns | Flexible schema without DDL per field, but indexable/sortable on the fields that matter | Pure EAV (join explosion); pure JSONB (no good indexes for sort); dynamic physical tables (DDL lock storms, catalog bloat) |
| P2 | Interpreted formula AST, never `eval` | Formula injection is a real attack surface; interpretation gives us type checking, cycle detection, and per-cell cost accounting | JS sandbox (VM escape risk, cold-start cost) |
| P3 | Field-level last-write-wins with version guards, not OT/CRDT, for cell edits | Cell edits are small, disjoint, and rarely truly concurrent; OT/CRDT cost is not justified. Conflicts are *surfaced*, never silently resolved | Full OT (complexity); CRDT everywhere (payload bloat) |
| P4 | Automations execute in a separate worker fleet, never in the request path | A slow webhook must never slow a cell edit | Inline execution |
| P5 | Org-scoped, not DB-per-tenant | Millions of small tenants make DB-per-tenant operationally impossible; RLS + query-layer scoping gives isolation at manageable cost | Schema/DB per tenant |
| P6 | REST-first with OpenAPI; GraphQL only as a read-optimised secondary | Predictable rate limiting, caching, and idempotency semantics; GraphQL's arbitrary query shape is hostile to per-tenant cost control | GraphQL-first |

## 8. Compliance posture

- **GDPR:** lawful basis recorded per processing activity; data export and erasure implemented as
  first-class async jobs; sub-processor register; DPA-ready.
- **SOC 2:** access reviews, change management via PR + CI, audit logging of privileged actions,
  encryption in transit and at rest, vulnerability management via automated scanning.
- **Retention & legal hold:** per-org retention policy; legal hold flag suppresses hard deletion
  and is itself an audited action.

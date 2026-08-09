# Tessera — Deployment Strategy

## 1. Environments

| Env | Purpose | Data | Deploy trigger |
|---|---|---|---|
| Local | Development | Seeded demo | `npm run dev` |
| Preview | Per-PR ephemeral | Seeded, isolated namespace | PR opened/updated |
| Staging | Pre-production | Anonymised production-shaped snapshot | merge to `main` |
| Production | Live | Real | manual promotion of a staging-green build |

Preview environments are full stacks (web, api, worker, PG, Redis, MinIO) in a per-PR Kubernetes
namespace, torn down on merge/close. They exist because "it works on my machine with SQLite" is
how tenant-isolation bugs reach customers.

## 2. Containers

Four images, all multi-stage, distroless runtime, non-root, read-only root filesystem:

| Image | Base | Entrypoint |
|---|---|---|
| `tessera/web` | node:20-slim → distroless | `node apps/web/server.js` (Next standalone) |
| `tessera/api` | node:20-slim → distroless | `node apps/api/dist/main.js` |
| `tessera/worker` | node:20-slim → distroless | `node apps/worker/dist/main.js` |
| `tessera/migrate` | node:20-slim | `npx prisma migrate deploy` (Job, not Deployment) |

Build rules: dependencies installed in a layer keyed by lockfile hash; source copied after;
`npm prune --omit=dev`; no build tooling, shell, or package manager in the runtime layer; images
scanned by Trivy in CI with High+ blocking.

## 3. Kubernetes shape

```
Deployment  web        3+  HPA on CPU 60% / RPS
Deployment  api        4+  HPA on CPU 60% / p95 latency
Deployment  ws         3+  HPA on active connections (custom metric)
Deployment  worker-compute    2+  KEDA on `compute` queue depth
Deployment  worker-io         2+  KEDA on `io` queue depth
Deployment  worker-automation 2+  KEDA on `automation` queue depth
Deployment  worker-delivery   2+  KEDA on `delivery` queue depth
CronJob     maintenance
Job         migrate       (Helm pre-upgrade hook, runs to completion before pods roll)
```

Every pod: `readinessProbe` → `/health/ready`, `livenessProbe` → `/health/live`,
`startupProbe` for slow first boots, `preStop` sleep 5 s, `terminationGracePeriodSeconds: 60`,
`PodDisruptionBudget minAvailable: 50%`, resource requests/limits set, `topologySpreadConstraints`
across zones.

### Health endpoint semantics

| Endpoint | Checks | Meaning |
|---|---|---|
| `/health/live` | process responsive, event loop lag < 5 s | restart me if this fails |
| `/health/ready` | DB pool, Redis, migration version matches build | send me traffic |
| `/health/startup` | migrations applied, caches warm | I have finished booting |

`/health/ready` deliberately does **not** check OpenSearch or Stripe — a degraded optional
dependency must not remove every pod from service. It reports them in the body for observability.

## 4. Release process

```
1. Merge to main → CI builds and pushes images tagged with the commit sha
2. Auto-deploy to staging; smoke suite + @critical Playwright run
3. Manual promotion → production
4. Helm upgrade:
     a. migrate Job runs (expand-phase migrations only — always backward compatible)
     b. api/ws/worker roll (maxSurge 25%, maxUnavailable 0)
     c. web rolls
5. Canary: 5% of traffic to the new revision for 10 min, watched on error rate + p95
6. Auto-rollback if the canary breaches thresholds; otherwise ramp to 100%
```

**Migrations are always backward compatible with the previous release.** The old code must run
against the new schema, because during a roll both versions serve traffic simultaneously. Contract
migrations (dropping a column) ship at least one release after the code that stopped using it.

## 5. Rollback

| Failure | Action |
|---|---|
| Bad application code | `helm rollback` — previous images, no schema change needed (guaranteed by the expand/contract rule) |
| Bad expand migration | Roll back code; the additive schema is harmless and is removed in a follow-up |
| Data corruption | Restore from PITR to a new cluster, verify, cut over. RPO 5 min via WAL archiving |
| Bad config | Config is versioned in Git; revert and re-sync (ArgoCD) |

Rollback is rehearsed quarterly in staging, and the drill result is recorded.

## 6. Data protection

| Asset | Backup | Retention | Restore test |
|---|---|---|---|
| Postgres | Continuous WAL archiving + nightly base backup | 35 days PITR | Monthly automated restore + integrity check |
| Object storage | Cross-region replication + versioning | 90 days for deleted objects | Quarterly |
| Redis | Queue instance: AOF everysec. Cache instance: none (regenerable) | — | — |
| OpenSearch | None — fully rebuildable from Postgres | — | Reindex drill quarterly |
| Secrets | Sealed in the platform secret store, backed up out of band | — | Quarterly |

**Disaster recovery:** RPO 5 min / RTO 1 h. The runbook (`docs/runbooks/dr.md`) covers region loss,
primary loss, and accidental mass deletion, each with a rehearsed procedure and an owner.

## 7. Cloud portability

No provider SDK is imported outside an adapter:

| Concern | Port | Adapters |
|---|---|---|
| Object storage | `StoragePort` | S3, GCS, Azure Blob, MinIO |
| Email | `MailerPort` | SES, SendGrid, Postmark, SMTP |
| Secrets | `SecretsPort` | K8s secrets, AWS SM, GCP SM, Azure KV, Vault |
| Queue | `QueuePort` | BullMQ/Redis (default), SQS |
| Search | `SearchPort` | OpenSearch, Elasticsearch, Postgres FTS (dev) |
| Payments | `BillingPort` | Stripe |

Managed-service mapping: RDS/Cloud SQL/Azure PG · ElastiCache/Memorystore/Azure Cache ·
S3/GCS/Blob · OpenSearch Service/Elastic Cloud · EKS/GKE/AKS. Nothing in the application code
changes between them.

## 8. Local development

```bash
cp .env.example .env
docker compose up -d          # postgres, redis, minio, opensearch, mailpit
npm install
npm run db:migrate
npm run db:seed               # demo org, users, base with data
npm run dev                   # web :3000, api :4000, worker
```

Seeded accounts (local only, never in any deployed environment):

| Email | Password | Role |
|---|---|---|
| `owner@demo.tessera.local` | `Demo!Passw0rd` | Organization owner |
| `editor@demo.tessera.local` | `Demo!Passw0rd` | Member / base editor |
| `viewer@demo.tessera.local` | `Demo!Passw0rd` | Viewer |
| `guest@external.local` | `Demo!Passw0rd` | Guest on one base |

The seed refuses to run when `NODE_ENV=production` or when `DATABASE_URL` does not point at
localhost, unless `ALLOW_UNSAFE_SEED=true` is set explicitly.

## 9. Reverse proxy / ingress

nginx-ingress with: HTTP/2 and HTTP/3, gzip + brotli, WebSocket upgrade on `/ws`, 25 MB body limit
(uploads go direct-to-S3 with presigned URLs, so the app never proxies large files), request-id
generation, real-IP from the trusted proxy chain, and the security headers from `docs/03` §7 set
at the edge as well as in the app (defence in depth).

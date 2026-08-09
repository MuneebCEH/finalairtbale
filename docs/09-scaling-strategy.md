# Tessera — Scaling Strategy

## 1. Scaling axes and their limits

| Axis | v1 target | First bottleneck | Response |
|---|---|---|---|
| Concurrent users | 100k | WS gateway memory | Horizontal gateway pods (stateless) |
| Records per table | 10M | Sort on unpromoted field | Field promotion (see DB doc §1.5) |
| Records per tenant | 100M | `records` partition size | 32 hash partitions → 128 via a repartition migration |
| Tenants | 1M | Postgres connections, catalog | PgBouncer transaction pooling; no per-tenant DDL by design |
| Writes/s (platform) | 20k | Primary WAL + index maintenance | Batch writes, fillfactor tuning, then logical sharding by org |
| Automation runs/day | 50M | Worker fleet + Redis | Fleet autoscaling on queue depth |
| Search corpus | 1B docs | OpenSearch shards | Index per org-shard, time-based rollover |
| Attachment storage | PB | none (object store) | Lifecycle policies, IA tier |

## 2. Database scaling ladder

Executed in order, each step deferred until measurement demands it:

1. **Indexes and query shape** — cursor pagination, promoted columns, no N+1. (Day one.)
2. **Connection pooling** — PgBouncer in transaction mode, app pool ≤ 20/pod. (Day one.)
3. **Read replicas** — all view reads, search-backing reads, and analytics go to replicas. A
   `needsPrimary` flag set after a write in the same session pins subsequent reads for 2 s to
   preserve read-your-writes. (Phase 2.)
4. **Partitioning** — hash on `organization_id` for `records`/`record_links`; range on time for
   the append-only tables. (Day one for records, since retrofitting is expensive.)
5. **Vertical scale** — the cheapest real answer for a long time. Buy the bigger instance.
6. **Tenant sharding** — an `organizations.shard_id` column and a shard router in
   `packages/database`. The routing seam exists from v1 (all repositories resolve a client via
   `getClient(tenantCtx)`), even though every org resolves to shard 0 today. Retrofitting a router
   into 25 domains later is what makes this migration a rewrite; building the seam now makes it a
   config change.
7. **Move cold data out** — revisions and audit older than the retention window go to object
   storage as Parquet, queryable on demand.

## 3. The grid query — the hot path

The single query that must never regress:

```sql
SELECT r.id, r.version, r.data, r.created_at, r.updated_at
FROM records r
WHERE r.organization_id = $1
  AND r.table_id = $2
  AND r.deleted_at IS NULL
  AND r.n1 >= $3                       -- promoted filter
  AND r.data @> $4::jsonb              -- unpromoted filter
ORDER BY r.s0 ASC NULLS LAST, r.id ASC -- promoted sort + tiebreak for a stable cursor
LIMIT 101;                             -- 101 to detect hasMore without a count
```

Rules enforced by code review and by the query builder itself:
- **Never `COUNT(*)`** on a view load. Counts are approximate (`reltuples` scaled by the filter
  selectivity estimate) and exact only on explicit request.
- **Never `OFFSET`.** The cursor is `(sortValue, id)` encoded and signed.
- **Always a tiebreak** on `id`, or pagination silently drops or duplicates rows when sort values
  collide.
- **Always `LIMIT`.** The repository base class rejects a query built without one.

## 4. Frontend scaling

| Concern | Approach |
|---|---|
| Grid rendering | Windowed rows *and* columns; only visible cells mount. Row recycling with stable keys. Target: DOM node count independent of dataset size (~2k nodes at any scroll position) |
| Data fetching | Pages of 200 rows, prefetch ±2 pages on scroll velocity, LRU-evict pages beyond 20 |
| Re-render control | Cell components are memoised on `(value, version, isSelected, isEditing)`. Selection state lives in a Zustand store with selector subscriptions so moving the cursor re-renders 2 cells, not the grid |
| Bundle | Route-level code splitting; the workspace shell is ~180 KB gzip, each view type lazy-loads its renderer; charting and the interface builder are separate chunks |
| Long tasks | Paste parsing, CSV preview, and formula compilation for the editor run in a Web Worker; the main thread never blocks > 50 ms |
| Images | Attachment thumbnails via CDN with `srcset`; lazy loading below the fold |

## 5. Caching layers

See architecture doc §6. Two rules that matter most:

1. **Version-keyed, not time-keyed.** View caches embed `tableVersion`; a write bumps the version
   and every dependent cache entry becomes unreachable instantly. No stale reads, no invalidation
   fan-out, no thundering herd on expiry.
2. **Single-flight.** Concurrent misses on the same key coalesce behind a Redis lock so a cold
   popular view issues one database query, not five hundred.

## 6. Load-testing scenarios

Defined in `packages/testing/load` (k6). All run against a seeded staging dataset in CI nightly and
before every release.

| Scenario | Shape | Pass criteria |
|---|---|---|
| `grid-browse` | 5k VUs paging through a 1M-row table with filters+sort | p95 < 400 ms, error rate < 0.1% |
| `cell-edit-storm` | 1k VUs each editing 1 cell/s in the same base | p95 ack < 200 ms, zero lost writes (verified by post-run reconciliation), conflict rate reported |
| `realtime-fanout` | 10k sockets on 100 bases, 500 writes/s | p95 delta latency < 500 ms, zero dropped sockets |
| `bulk-import` | 5 concurrent 1M-row CSV imports | completes < 20 min each, API p95 unaffected (< 10% regression) |
| `automation-burst` | 100k records updated in 60 s triggering 3 automations each | all runs complete < 15 min, zero duplicate executions, DLQ empty |
| `api-hammer` | 50 tokens at plan rate limits sustained 30 min | correct 429 shaping, no primary DB saturation |
| `formula-cascade` | Update a field feeding a 6-level dependency chain across 500k records | completes < 10 min, no lock contention alerts |
| `mixed-steady-state` | Weighted blend of all of the above at 60% capacity for 4 h | no memory growth, no connection leak, stable p99 |

Every scenario asserts on **tenant isolation**: a canary tenant's row counts and checksums must be
unchanged by any other tenant's load.

## 7. Capacity planning heuristics

- 1 API pod (2 vCPU / 2 GiB) ≈ 400 rps of mixed traffic.
- 1 WS pod (2 vCPU / 4 GiB) ≈ 10k sockets.
- 1 compute worker (4 vCPU / 4 GiB) ≈ 20k formula cell evaluations/s.
- Postgres primary sized so that steady-state CPU ≤ 40% and buffer cache holds the working set;
  alert at 60%.
- Redis sized for presence + cache + queue with 30% headroom; `maxmemory-policy allkeys-lru` on
  the cache instance and `noeviction` on the queue instance — **separate instances**, because
  evicting a queue entry loses a job.

## 8. Cost control

- Per-tenant resource accounting (query time, worker seconds, storage, egress) written to
  `usage_events`; the top-50 consumers dashboard drives both pricing and abuse investigation.
- Plan-based concurrency caps prevent one tenant buying the whole fleet with a free account.
- Attachment lifecycle: originals → infrequent access at 90 days; thumbnails regenerated on demand
  rather than stored forever.

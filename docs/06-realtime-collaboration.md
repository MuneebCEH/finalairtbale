# Tessera — Real-Time Collaboration Strategy

## 1. What is actually concurrent

Choosing a concurrency strategy starts with measuring the collision surface, not with picking a
famous algorithm.

| Surface | Shape of edit | Real collision probability | Chosen strategy |
|---|---|---|---|
| Cell value (scalar: number, date, select, checkbox) | Whole-value replace | Low; two users rarely target the same cell in the same second | **Field-level LWW with version guard + conflict surfacing** |
| Cell value (long text) | Character-level insert/delete | Moderate when two people write a description together | LWW in v1.0, **CRDT (Yjs) in v1.1** for the expanded long-text editor only |
| Record creation | Append | None (distinct ULIDs) | Last-writer-irrelevant |
| Record deletion vs edit | Conflicting intent | Low but destructive | Deletion wins, edit is preserved in trash + revision, editor is notified |
| Schema (field add/rename/type change) | Structural | Low but catastrophic if interleaved | **Serialised** behind a per-base advisory lock |
| View configuration | Whole-config replace | Low | LWW with version guard |
| Comments | Append-only | None | Append |
| Record order (manual drag) | Position | Moderate | Fractional indexing (`LexoRank`-style keys) — concurrent inserts converge without renumbering |

The conclusion drives the design: **OT and CRDTs are the correct tool for character-level
co-editing and the wrong tool for a grid of scalar cells.** Applying a CRDT to every cell would
multiply storage by the metadata factor and complicate every query, to solve a collision that
happens on a fraction of a percent of edits — and it would still not give us the thing users
actually want in a grid, which is *to be told* that someone else changed the value.

## 2. The write path

```
1.  User edits cell → client applies optimistic patch, stores it in a pending-mutation map
                      keyed by (recordId, fieldId) with a client mutation id
2.  Client PATCHes /v1/records/:id { fields: {fldX: v}, version: n, clientMutationId }
3.  Server: authorise → validate/coerce against the field type
4.  UPDATE records
      SET data = jsonb_set(data, '{fldX}', $v), s2 = $v_promoted, version = version + 1, …
      WHERE id = $1 AND organization_id = $2 AND deleted_at IS NULL
        AND (version = $n OR $n IS NULL)                     ← guard
5.  0 rows → 409 RECORD_VERSION_CONFLICT { actualVersion, currentValue }
    1 row  → write record_revisions row, emit record.updated (outbox), commit
6.  Outbox relay → Redis pub/sub `view:{...}` and `record:{id}`
7.  Gateways forward the delta to subscribed sockets, EXCLUDING the originating socket
8.  Originating client reconciles: server version replaces optimistic value, pending entry cleared
```

**Field-level guard, not row-level.** The `version` check is deliberately *soft* for
non-overlapping fields: the update statement only touches the JSONB keys the client actually sent,
so two users editing two different columns of the same row both succeed and both see the other's
change. A conflict is raised only when the same *field* changed since the client's last known
version — which the server determines from `record_revisions`, not from the row version alone.

## 3. Conflict handling (never a silent overwrite)

On conflict the server returns 409 with:

```json
{ "error": { "code": "RECORD_VERSION_CONFLICT",
  "details": { "recordId": "rec_…", "fieldId": "fld_…",
               "yourValue": "Done", "theirValue": "In review",
               "theirActor": { "id": "usr_…", "name": "R. Mehta" },
               "changedAt": "2026-08-06T10:00:03Z", "actualVersion": 9 } } }
```

The client shows a non-blocking conflict chip on the cell offering **Keep mine · Keep theirs ·
Keep both (append to a comment)**. Until resolved:

- the incoming value is what is displayed and stored (the database is never left in a guessed state),
- the user's value is retained in the pending map and in a `record_conflicts` row so a refresh
  does not lose it,
- an entry is written to the record's activity history: *"Conflicting edit by A and B on {field}"*.

Requirement mapping: existing value preserved ✅ · incoming value preserved ✅ · affected user
notified ✅ · resolution options offered ✅ · recorded in activity history ✅.

## 4. Presence

Redis-backed, TTL-driven, so no node holds authoritative state.

```
HSET  presence:base:{baseId} {userId} {json: name, color, tableId, viewId, recordId, cell, at}
EXPIRE presence:base:{baseId} 60
```

Clients heartbeat every 15 s; the entry is removed on disconnect and expires if the heartbeat
stops. Presence broadcasts are throttled server-side to 1 message per 500 ms per channel and
coalesced into a single roster diff.

Displayed as: avatars in the base header, a coloured outline on the cell another user has
selected, and a "editing" pulse on the row. Colours are derived deterministically from the user
id so a person is the same colour for everyone.

## 5. Transport

| Layer | Choice |
|---|---|
| Primary | WebSocket, one per tab, multiplexed channels |
| Fallback | Server-Sent Events + POST for upstream messages (proxy-hostile networks) |
| Framing | JSON; binary MessagePack behind a flag for high-volume channels |
| Auth | Cookie/token validated on upgrade; re-validated every 15 min; a revoked session closes the socket with code 4401 |
| Heartbeat | Ping every 20 s, close on 2 missed pongs |
| Reconnect | Exponential backoff with jitter, capped at 30 s; resubscribes and requests a delta since the last received sequence number |

**Catch-up after reconnect.** Each channel maintains a monotonic sequence number in a Redis
Stream (capped, ~5 min of history). On reconnect the client sends its last sequence; if it is
within the retained window the gateway replays the missed deltas, otherwise it replies
`{ resync: true }` and the client refetches the current view page. This makes a 30-second network
blip invisible and a 10-minute outage merely a refresh.

## 6. Message shapes

```ts
// server → client
type ServerMessage =
  | { t: 'delta'; ch: string; seq: number; ops: RecordDelta[] }
  | { t: 'schema'; ch: string; seq: number; change: SchemaChange }
  | { t: 'presence'; ch: string; join?: PresenceEntry[]; leave?: string[]; update?: PresenceEntry[] }
  | { t: 'comment'; ch: string; comment: CommentDto }
  | { t: 'notification'; notification: NotificationDto }
  | { t: 'resync'; ch: string }
  | { t: 'error'; code: string; message: string };

interface RecordDelta {
  recordId: string;
  version: number;
  changed: Record<string /* fieldId */, unknown>;   // only what changed
  actorId: string | null;
  op: 'create' | 'update' | 'delete' | 'restore';
}
```

**Deltas carry only changed fields.** A 60-field record with one edited cell produces a ~120-byte
message, not a 12 KB record payload.

## 7. Scaling the gateway

- Gateways are stateless; any node serves any client. No sticky sessions required.
- Redis pub/sub fan-out; each node subscribes only to channels it has local subscribers for
  (subscription refcounting), so a node with 50 open bases does not receive traffic for 10,000.
- Target 10k sockets/node (Node.js with `ws`, ~40 KB/socket) → 100 nodes serve 1M concurrent.
- At the point Redis pub/sub fan-out becomes the bottleneck (~500k msg/s), the seam to swap in a
  dedicated bus (NATS/Kafka) is the `RealtimeBus` port in `packages/events` — one interface, one
  adapter.
- Backpressure: a slow client's send buffer is capped; on overflow the node drops the socket with
  `resync`, which is cheaper and more correct than unbounded buffering.

## 8. Client-side model

`packages/sdk` + TanStack Query:

- The view page cache is the single source of truth for rendered rows.
- Incoming deltas patch the cache directly (`queryClient.setQueryData`), so no refetch is needed.
- A delta for a record that does not match the current view's filter triggers removal from the
  page and a "1 record no longer matches this view" toast rather than a silent disappearance.
- Optimistic mutations use TanStack's `onMutate`/`onError`/`onSettled` with the pending-mutation
  map so a rollback restores the exact prior value, and a delta arriving mid-flight does not
  clobber the user's in-progress edit.

## 9. Undo/redo under concurrency

Undo is **semantic, not positional**: the client stores inverse operations (`set fld X on rec Y
back to Z, expecting version V`). If the world moved on, the inverse is re-authored against the
current value and the user is warned that the undo target changed. Undo never blindly writes a
stale snapshot.

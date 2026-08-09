# Tessera — API Specification

Base URL: `https://api.{domain}/v1`. OpenAPI 3.1 document generated from Zod schemas at
`/v1/openapi.json`; interactive docs at `/v1/docs`.

## 1. Conventions

| Aspect | Rule |
|---|---|
| Versioning | URL-prefixed (`/v1`). Breaking changes only in a new major prefix; additive changes never break |
| Naming | Plural, lower-kebab resource paths; `camelCase` JSON fields |
| Ids | ULID with a typed prefix: `usr_`, `org_`, `wsp_`, `bas_`, `tbl_`, `fld_`, `rec_`, `viw_`, `frm_`, `atm_`, `whk_`, `att_` |
| Time | RFC 3339 UTC with `Z` |
| Pagination | Cursor-based only. `?limit=100&cursor=…`. No offset pagination anywhere |
| Partial responses | `?fields=` allowlist on record endpoints |
| Concurrency | `If-Match: <version>` on updates; `ETag` on single-resource reads |
| Idempotency | `Idempotency-Key` header honoured on all POST/PATCH/DELETE |
| Request id | `X-Request-Id` echoed; generated if absent; present in every error body |
| Content type | `application/json` only (except upload endpoints, which use `multipart/form-data`) |

## 2. Envelope

**Success (collection):**

```json
{
  "data": [ { "id": "rec_01H...", "…": "…" } ],
  "meta": { "hasMore": true, "nextCursor": "eyJpZCI6…", "count": 100 }
}
```

**Success (single):** the resource object at the top level of `data`.

**Error:**

```json
{
  "error": {
    "code": "RECORD_VERSION_CONFLICT",
    "message": "The record was modified by another user.",
    "details": { "recordId": "rec_01H…", "expectedVersion": 7, "actualVersion": 9 },
    "requestId": "req_01H…"
  }
}
```

Stack traces, SQL, and internal identifiers are never returned. Unhandled exceptions become
`INTERNAL_ERROR` with the request id, and the full detail goes to the log and error tracker only.

## 3. Error codes

| HTTP | Code | Meaning |
|---|---|---|
| 400 | `MALFORMED_REQUEST` | Body is not valid JSON / bad cursor |
| 401 | `UNAUTHENTICATED` | Missing or invalid credentials |
| 401 | `MFA_REQUIRED` | Valid password, second factor outstanding |
| 403 | `FORBIDDEN` | Authenticated but not permitted (body carries the deny reason) |
| 403 | `PLAN_LIMIT_EXCEEDED` | Entitlement blocks the action; `details.limit`, `details.usage` |
| 404 | `NOT_FOUND` | Resource missing **or** outside the caller's tenant |
| 409 | `RECORD_VERSION_CONFLICT` | Optimistic concurrency failure |
| 409 | `SCHEMA_CONFLICT` | Concurrent schema change on the same base |
| 409 | `DUPLICATE_RESOURCE` | Unique constraint (e.g. field name in table) |
| 422 | `VALIDATION_FAILED` | Zod failure; `details.issues[]` with `path`, `code`, `message` |
| 422 | `FIELD_TYPE_MISMATCH` | Value not coercible to the field type |
| 422 | `FORMULA_ERROR` | Parse/type/cycle error; `details.position` |
| 429 | `RATE_LIMITED` | With `Retry-After` |
| 451 | `LEGAL_HOLD` | Deletion blocked by hold |
| 500 | `INTERNAL_ERROR` | Unexpected |
| 503 | `DEPENDENCY_UNAVAILABLE` | Search/storage degraded; `details.dependency` |

## 4. Authentication

| Method | Header | Use |
|---|---|---|
| Session cookie | `tessera_session` (HttpOnly) | First-party web app |
| Personal access token | `Authorization: Bearer tsk_…` | Scripts, integrations |
| OAuth access token | `Authorization: Bearer tsa_…` | Third-party apps |

Scopes: `data:read`, `data:write`, `schema:read`, `schema:write`, `webhook:manage`,
`automation:read`, `automation:run`, `user:read`, `org:admin`. Tokens are stored as SHA-256
hashes with a short random prefix for lookup; the plaintext is shown exactly once.

## 5. Endpoint catalogue (Phase 1 subset marked ★)

### Auth ★
```
POST   /v1/auth/register                 → 201 { user, verificationSent }
POST   /v1/auth/verify-email             → 200
POST   /v1/auth/login                    → 200 { user } + Set-Cookie | 401 MFA_REQUIRED { mfaToken }
POST   /v1/auth/mfa/verify               → 200 { user } + Set-Cookie
POST   /v1/auth/logout                   → 204
POST   /v1/auth/refresh                  → 200 (rotates refresh token)
POST   /v1/auth/magic-link               → 202
POST   /v1/auth/magic-link/consume       → 200
POST   /v1/auth/password/forgot          → 202 (always 202, no user enumeration)
POST   /v1/auth/password/reset           → 200
PATCH  /v1/auth/password                 → 200 (revokes other sessions)
GET    /v1/auth/oauth/:provider          → 302
GET    /v1/auth/oauth/:provider/callback → 302
POST   /v1/auth/mfa/enroll               → 200 { secret, otpauthUrl, qr }
POST   /v1/auth/mfa/activate             → 200 { recoveryCodes }
DELETE /v1/auth/mfa                      → 204
GET    /v1/auth/sessions                 → 200 [ { id, device, ip, lastSeenAt, current } ]
DELETE /v1/auth/sessions/:id             → 204
DELETE /v1/auth/sessions                 → 204 (all but current)
```

### Users ★
```
GET    /v1/me                            PATCH /v1/me
GET    /v1/me/organizations              GET   /v1/me/notifications
POST   /v1/me/avatar                     DELETE /v1/me   (async erasure job)
```

### Organizations ★
```
GET    /v1/organizations                 POST   /v1/organizations
GET    /v1/organizations/:orgId          PATCH  /v1/organizations/:orgId
DELETE /v1/organizations/:orgId
GET    /v1/organizations/:orgId/members  POST  /v1/organizations/:orgId/invitations
PATCH  /v1/organizations/:orgId/members/:userId      (role change)
DELETE /v1/organizations/:orgId/members/:userId
POST   /v1/organizations/:orgId/members/:userId/suspend
GET    /v1/organizations/:orgId/groups   POST  /v1/organizations/:orgId/groups
PATCH  /v1/organizations/:orgId/settings
POST   /v1/organizations/:orgId/transfer-ownership
GET    /v1/organizations/:orgId/audit-logs
GET    /v1/invitations/:token            POST  /v1/invitations/:token/accept
```

### Workspaces ★
```
GET    /v1/organizations/:orgId/workspaces    POST /v1/organizations/:orgId/workspaces
GET    /v1/workspaces/:workspaceId            PATCH /v1/workspaces/:workspaceId
POST   /v1/workspaces/:workspaceId/archive    POST  /v1/workspaces/:workspaceId/restore
DELETE /v1/workspaces/:workspaceId
GET    /v1/workspaces/:workspaceId/members    POST  /v1/workspaces/:workspaceId/members
PATCH  /v1/workspaces/:workspaceId/members/:userId
DELETE /v1/workspaces/:workspaceId/members/:userId
```

### Bases, tables, fields (Phase 2)
```
GET|POST   /v1/workspaces/:workspaceId/bases
GET|PATCH|DELETE /v1/bases/:baseId
POST       /v1/bases/:baseId/duplicate      POST /v1/bases/:baseId/export
GET|POST   /v1/bases/:baseId/tables
GET|PATCH|DELETE /v1/tables/:tableId
GET|POST   /v1/tables/:tableId/fields
GET|PATCH|DELETE /v1/fields/:fieldId
POST       /v1/fields/:fieldId/preview-change   → { affectedRecords, sample[], lossy }
```

### Records (Phase 2)
```
GET    /v1/tables/:tableId/records
         ?viewId= &filterByFormula= &sort= &fields= &limit= &cursor= &cellFormat=json|string
POST   /v1/tables/:tableId/records            (single or { records: [...] } up to 100)
GET    /v1/records/:recordId
PATCH  /v1/records/:recordId                  (If-Match)
DELETE /v1/records/:recordId
PATCH  /v1/tables/:tableId/records            (batch upsert, ≤100, atomic)
DELETE /v1/tables/:tableId/records            (batch, ≤100)
POST   /v1/tables/:tableId/records/search
GET    /v1/records/:recordId/revisions
POST   /v1/records/:recordId/restore
```

### Views, comments, forms, automations, webhooks, attachments — Phases 3–7
Full paths are generated into the OpenAPI document; the shape follows the same conventions.

## 6. Filtering in the API

Two mechanisms, both compiled to the same internal query IR:

1. **Structured** (preferred, used by the UI):
```json
{ "conjunction": "and",
  "conditions": [
    { "fieldId": "fld_a", "operator": "is", "value": "Active" },
    { "conjunction": "or", "conditions": [
      { "fieldId": "fld_b", "operator": "isAfter", "value": "2026-01-01" },
      { "fieldId": "fld_c", "operator": "isEmpty" } ] } ] }
```
2. **`filterByFormula`** — the same safe formula language as computed fields, restricted to a
   boolean result. Parsed to an AST, type-checked against the table's fields, then compiled to
   parameterised SQL. **No string interpolation ever reaches SQL.**

Operator support is declared per field type by the field-type registry, so the API rejects
`isAfter` on a checkbox at validation time with `FIELD_TYPE_MISMATCH`.

## 7. Batch semantics

- Max 100 items per batch. Larger → `VALIDATION_FAILED`.
- Batches are **atomic by default** (one transaction). `?partial=true` switches to per-item
  results with a `results[]` array carrying per-item status.
- A batch consumes one rate-limit token per 10 items, floor 1.

## 8. Webhook payload

```json
{
  "id": "evt_01H…",
  "type": "record.updated",
  "createdAt": "2026-08-06T10:00:00Z",
  "base": { "id": "bas_…" }, "table": { "id": "tbl_…" },
  "actor": { "type": "user", "id": "usr_…" },
  "payload": { "recordId": "rec_…", "changed": { "fld_…": { "from": 1, "to": 2 } } }
}
```

Headers: `X-Tessera-Event-Id`, `X-Tessera-Timestamp`, `X-Tessera-Signature: v1=<hex hmac>`.
Signature base string is `${timestamp}.${rawBody}`. Receivers must reject a timestamp older than
5 minutes and must dedupe on `X-Tessera-Event-Id`.

## 9. Deprecation policy

A deprecated endpoint returns `Deprecation: true` and `Sunset: <http-date>`, is documented in the
changelog, and remains available for at least 12 months.

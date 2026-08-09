# Tessera — Multi-Tenant Security Model & Permission Matrix

## 1. Threat model

| # | Threat | Control |
|---|---|---|
| T1 | Tenant A reads/writes tenant B's data via a forgotten `WHERE` | Tenant-scoped repositories (structurally impossible to omit) + Postgres RLS backstop + automated isolation test suite |
| T2 | IDOR — guessing a record/base id | ULIDs are non-sequential; every read resolves the resource *then* authorises it; 404 (not 403) for resources outside the tenant, so existence is not disclosed |
| T3 | Privilege escalation via mass assignment | DTOs are Zod-parsed allowlists; `role`, `organizationId`, `ownerId` are never bindable from request bodies |
| T4 | Session theft | HttpOnly + Secure + SameSite=Lax cookies, rotating refresh tokens with reuse detection, device binding hash, absolute + idle expiry |
| T5 | Credential stuffing | Argon2id hashing, per-account + per-IP rate limits with exponential backoff, breached-password check, optional enforced 2FA |
| T6 | Formula injection / RCE | AST interpreter with a fixed function table. No `eval`, no `Function`, no VM. Step budget + depth budget per evaluation |
| T7 | CSV injection on export | Cells beginning `= + - @ TAB CR` are prefixed with `'` on CSV/XLSX export |
| T8 | SSRF via webhooks/integrations | Outbound URL allowlist policy: DNS resolution + IP range denylist (RFC1918, link-local, metadata endpoints), no redirects to private ranges, fixed timeouts, egress proxy in production |
| T9 | Malicious upload | Content-type sniffing (magic bytes, not the declared header), extension allowlist, size caps, ClamAV scan before the file is servable, `Content-Disposition: attachment`, served from a separate origin |
| T10 | Path traversal in object storage | Storage keys are constructed only by a builder that hashes `{orgId}/{baseId}/{ulid}`; user input never reaches a key |
| T11 | Webhook spoofing (inbound) | HMAC-SHA256 signature over `timestamp.body`, ±5 min tolerance, constant-time compare, secret rotation with dual-accept window |
| T12 | Token leakage in logs | A redaction serializer in `packages/logger` strips `password`, `token`, `secret`, `authorization`, `cookie`, `set-cookie`, `apiKey`, `clientSecret` at every depth, plus value-shape detection for JWT/PAT prefixes |
| T13 | XSS via record content | React escapes by default; rich text is sanitised server-side with a strict allowlist on write **and** on render; CSP with nonces and no `unsafe-inline` |
| T14 | CSRF | SameSite=Lax cookies + double-submit token on all state-changing cookie-authenticated routes; bearer-token routes are exempt by construction |
| T15 | Rate-limit bypass via distributed IPs | Limits are keyed primarily by principal and tenant, not IP; IP is a secondary key for unauthenticated routes only |
| T16 | Admin abuse | Impersonation requires a second approver, is time-boxed, is banner-visible to the impersonated org, and writes an immutable audit record before the session starts |

## 2. Tenant scoping — how it is made structural

```ts
// packages/database/src/tenant/tenant-context.ts
export interface TenantContext {
  readonly organizationId: string;
  readonly workspaceId?: string;
  readonly baseId?: string;
  readonly principal: Principal;
  readonly correlationId: string;
}
```

Every repository extends `TenantScopedRepository`, whose constructor **requires** a
`TenantContext`. Its protected `scope()` helper returns the mandatory `where` fragment:

```ts
protected scope<T extends { organizationId?: string }>(where: T) {
  return { ...where, organizationId: this.ctx.organizationId };
}
```

A repository method that queries without `scope()` fails a custom ESLint rule
(`tessera/require-tenant-scope`) that inspects Prisma call sites inside repository classes. The
rule is `error`, not `warn`, and cannot be disabled without an eslint-disable comment that the
CODEOWNERS security reviewer must approve.

At the connection level, every transaction begins with:

```sql
SET LOCAL app.current_org = '<orgId>';
```

so RLS is armed even if all of the above fails.

## 3. Principal model

```ts
type Principal =
  | { type: 'user'; userId: string; sessionId: string; mfaSatisfied: boolean }
  | { type: 'api_token'; tokenId: string; userId: string; scopes: Scope[] }
  | { type: 'oauth'; appId: string; userId: string; scopes: Scope[] }
  | { type: 'service'; service: string }          // internal, never from the network
  | { type: 'anonymous'; shareId?: string };      // public shared views / public forms
```

A public share link produces an `anonymous` principal carrying the share id. The policy engine
grants exactly the share's declared capability (read of one view, or create-only on one form) —
never anything derived from the share creator's own permissions beyond that snapshot.

## 4. Authorization architecture

```
PolicyEngine.check(principal, action, resource) → Decision
   Decision = { allowed: true, via: Grant[] }
            | { allowed: false, reason: DenyReason, explanation: string }
```

Resolution order (first decisive result wins):

1. **Platform suspension** — org or user suspended → deny.
2. **Explicit record/field-level deny** — the only DENY that overrides everything below.
3. **Resource-level explicit grant** (base member, interface/form/view ACL).
4. **Workspace role** inherited by contained bases.
5. **Organization role** inherited by contained workspaces.
6. **Group membership** — union of the groups' grants.
7. **Share-link capability** for anonymous principals.
8. **Default deny.**

Decisions are cached in Redis for 60 s keyed `t:{org}:authz:{principalKey}:{resourceId}` and
busted eagerly on membership, group, or ACL change.

**Permission inspector.** `GET /v1/permissions/explain?principal=…&action=…&resource=…` returns the
full `Grant[]` chain or the `DenyReason`, so a user can be told *why*, e.g.
`"Denied: you have role 'commenter' on workspace ws_… which grants record:read and comment:create but not record:update."`

## 5. Permission matrix

### 5.1 Organization roles

| Capability | Owner | Admin | Member | Guest | Billing admin | Security admin |
|---|:--:|:--:|:--:|:--:|:--:|:--:|
| View organization | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| Rename / brand organization | ✅ | ✅ | — | — | — | — |
| Delete organization | ✅ | — | — | — | — | — |
| Transfer ownership | ✅ | — | — | — | — | — |
| Create workspace | ✅ | ✅ | ✅¹ | — | — | — |
| List workspaces⁵ | ✅ | ✅ | ✅ | — | ✅ | ✅ |
| Invite member | ✅ | ✅ | ✅¹ | — | — | — |
| Invite guest | ✅ | ✅ | ✅¹ | — | — | — |
| Remove / suspend member | ✅ | ✅ | — | — | — | ✅ |
| Assign org roles | ✅ | ✅ | — | — | — | — |
| Manage groups | ✅ | ✅ | — | — | — | ✅ |
| Manage approved email domains | ✅ | ✅ | — | — | — | ✅ |
| Restrict sharing / export / API | ✅ | ✅ | — | — | — | ✅ |
| Enforce 2FA / session policy | ✅ | — | — | — | — | ✅ |
| View audit log | ✅ | ✅ | — | — | — | ✅ |
| Export audit log | ✅ | — | — | — | — | ✅ |
| Manage SSO / SCIM | ✅ | — | — | — | — | ✅ |
| View billing | ✅ | ✅ | — | — | ✅ | — |
| Change plan / payment method | ✅ | — | — | — | ✅ | — |
| Manage API tokens (org-owned) | ✅ | ✅ | — | — | — | ✅ |

¹ subject to the org setting `member_can_create_workspaces` / `member_can_invite` (default: on for
Member, off for Guest).

⁵ **Listing** workspaces is organization-scoped and returns only the workspaces the caller holds a
grant on — the filtering happens in SQL, inside the query. This is deliberately a separate
capability from `workspace:read`, which governs one specific workspace. Conflating the two is a
real trap: requiring the per-workspace permission on the collection endpoint denies every user
who is not an organization administrator, including everyone whose access comes from individual
workspace grants — which is most of them.

### 5.2 Workspace / base roles

| Capability | Owner | Creator | Editor | Commenter | Viewer | Guest² |
|---|:--:|:--:|:--:|:--:|:--:|:--:|
| Read records | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| Create record | ✅ | ✅ | ✅ | — | — | ▲³ |
| Update record | ✅ | ✅ | ✅ | — | — | ▲³ |
| Delete record | ✅ | ✅ | ✅ | — | — | — |
| Comment | ✅ | ✅ | ✅ | ✅ | — | ✅ |
| Create/edit personal view | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| Create/edit shared view | ✅ | ✅ | ✅ | — | — | — |
| Lock / unlock view | ✅ | ✅ | — | — | — | — |
| Create / alter field | ✅ | ✅ | — | — | — | — |
| Delete field | ✅ | ✅ | — | — | — | — |
| Create / delete table | ✅ | ✅ | — | — | — | — |
| Create / edit base | ✅ | ✅ | — | — | — | — |
| Delete base | ✅ | — | — | — | — | — |
| Create / edit form | ✅ | ✅ | — | — | — | — |
| Create / edit interface | ✅ | ✅ | — | — | — | — |
| Create / edit automation | ✅ | ✅ | — | — | — | — |
| Run manual automation | ✅ | ✅ | ✅ | — | — | — |
| Share externally | ✅ | ✅⁴ | — | — | — | — |
| Export data | ✅ | ✅ | ✅⁴ | — | — | — |
| Manage base members | ✅ | ✅ | — | — | — | — |
| View revision history | ✅ | ✅ | ✅ | ✅ | ✅ | — |
| Restore from trash | ✅ | ✅ | ✅ | — | — | — |

² Guest = external collaborator, scoped to explicitly granted bases only; never sees the workspace
tree. ³ Guest record write requires an explicit per-base grant. ⁴ subject to org-level restriction
flags.

### 5.3 Field- and record-level

- **Field permission** rows: `(fieldId, subjectType, subjectId, access)` where access ∈
  `hidden | read | write`. Default is inherited. `hidden` removes the field from API responses,
  exports, search indexes, and webhook payloads — not just from the UI.
- **Record permission** rules are *declarative predicates*, not row grants:
  `"editable when {Assignee} contains CURRENT_USER()"`. They compile into a SQL fragment appended
  to every query for that principal, so a restricted user's page query never returns rows they
  cannot see. This keeps pagination correct (no post-filter holes).

### 5.4 Share links

| Setting | Options |
|---|---|
| Audience | anyone with link · password required · email-domain restricted · specific emails |
| Capability | view read-only · form submit-only · interface read · interface interact |
| Expiry | never · at datetime |
| Controls | allow copy/export · show record detail · allow comments |
| Revocation | immediate; the share id is invalidated in Redis and Postgres in one transaction |

## 6. Secrets & encryption

- **In transit:** TLS 1.3 everywhere, HSTS with preload, mTLS between internal services in K8s.
- **At rest:** volume-level encryption for Postgres and object storage.
- **Application-level envelope encryption** for the high-value subset: integration OAuth tokens,
  webhook secrets, 2FA secrets, SCIM tokens. AES-256-GCM with a per-record data key, wrapped by a
  KMS master key. Ciphertext columns are `bytea` and carry the key version for rotation.
- Secrets never appear in env vars in production; they are mounted from the platform secret store.
- `packages/config` fails startup if a required secret is missing — no silent insecure defaults.

## 7. Security headers & CSP

```
Content-Security-Policy: default-src 'self'; script-src 'self' 'nonce-{n}' 'strict-dynamic';
  style-src 'self' 'nonce-{n}'; img-src 'self' data: https://cdn.{domain};
  connect-src 'self' wss://{api-domain}; frame-ancestors 'none'; base-uri 'none';
  form-action 'self'; object-src 'none'; upgrade-insecure-requests
Strict-Transport-Security: max-age=63072000; includeSubDomains; preload
X-Content-Type-Options: nosniff
Referrer-Policy: strict-origin-when-cross-origin
Permissions-Policy: geolocation=(), camera=(), microphone=(), payment=()
Cross-Origin-Opener-Policy: same-origin
Cross-Origin-Resource-Policy: same-origin
```

Attachments are served from a **separate origin** (`files.{domain}`) with a permissive CORP and no
cookies, so a malicious upload cannot reach the app's session.

## 8. Rate limiting

| Route class | Limit | Key |
|---|---|---|
| Unauthenticated auth (login/register/reset) | 10 / 15 min | IP + email hash |
| Authenticated read | 300 / min | principal |
| Authenticated write | 120 / min | principal |
| Bulk write (batch endpoints) | 20 / min | principal |
| Public API (per plan) | 5 / 10 / 25 / 50 rps | token |
| Public form submit | 20 / hour | IP + form |
| Webhook delivery (outbound) | 30 / s per endpoint | endpoint |
| Search | 60 / min | principal |

Implemented as a Redis sliding-window counter with a Lua script (atomic). Responses always carry
`X-RateLimit-Limit`, `X-RateLimit-Remaining`, `X-RateLimit-Reset`, and `Retry-After` on 429.

## 9. Audit logging

Every privileged or security-relevant action writes an `audit_logs` row **in the same transaction**
as the effect:

```
id · organization_id · actor_type · actor_id · impersonator_id · action · resource_type ·
resource_id · before (jsonb) · after (jsonb) · ip · user_agent · correlation_id · created_at
```

`before`/`after` are field-diffs with sensitive values redacted. Audit rows are append-only
(no UPDATE/DELETE grant on the table for the application role); retention is enforced by dropping
old partitions under a documented policy, and a legal hold blocks the drop.

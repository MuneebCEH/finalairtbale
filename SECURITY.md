# Security Policy

## Reporting a vulnerability

Report privately to **security@tessera.example** with:

- what the issue is and where,
- steps to reproduce, or a proof of concept,
- what an attacker could do with it,
- any suggested remediation.

Please do not open a public issue for a security report.

**What to expect:** acknowledgement within 2 business days; an initial assessment within 5; a fix
or a documented mitigation plan within 30 days for High and Critical findings. We will credit you
in the release notes unless you prefer otherwise.

**Safe harbour.** We will not pursue action against research conducted in good faith against your
own test accounts, without accessing other people's data, without degrading service, and without
retaining any data you encounter.

## Scope

In scope: the web application, the API, the worker, the published container images, and this
repository's infrastructure definitions.

Out of scope: findings that require a compromised device or browser extension; missing headers
with no demonstrated impact; rate-limit thresholds absent an actual bypass; automated scanner
output with no verified exploitability; social engineering.

## Supported versions

The `main` branch and the most recent tagged release receive security fixes.

## What we have built in

The full threat model and control inventory is in
[`docs/03-security-and-permissions.md`](./docs/03-security-and-permissions.md). In short:

| Area | Control |
|---|---|
| Tenant isolation | Repositories that cannot be constructed without a tenant context, a lint rule that catches bypasses, Postgres row-level security as the backstop, and an automated per-route isolation suite |
| Authorization | Server-side policy engine, evaluated before every handler, with an inspector that explains any decision |
| Passwords | Argon2id, breached-password checking, constant-time failure paths, no user enumeration |
| Sessions | Server-side and revocable, HttpOnly cookies, refresh-token rotation with reuse detection |
| Secrets | Envelope encryption (AES-256-GCM) with key versioning for integration tokens, webhook secrets, and TOTP seeds |
| Logging | Key-based *and* value-shape redaction, applied at serialisation so a secret cannot reach a sink |
| Formulas | Interpreted AST with a fixed function table, budgets, and a linear-time regex engine. No `eval`, no VM |
| Outbound requests | SSRF guard re-evaluated on every attempt, private-range denylist, fixed timeouts |
| Uploads | Magic-byte type detection, extension denylist, virus scanning, served from a separate origin |
| Audit | Written in the same transaction as the effect, append-only at the database grant level |
| CI | Dependency audit, Semgrep, secret scanning, and container scanning on every pull request |

## Cryptography

- Passwords and recovery codes: Argon2id (19 MiB, t=2, p=1).
- Tokens (sessions, invitations, API keys): 256 bits from the CSPRNG, stored as SHA-256. A slow
  hash buys nothing against a value with no brute-forceable structure.
- Application-level secrets: AES-256-GCM envelope encryption with a versioned keyring.
- Webhook signatures: HMAC-SHA256 over `timestamp.body`, constant-time comparison, 5-minute
  tolerance, dual-accept window during rotation.

We do not implement our own primitives.

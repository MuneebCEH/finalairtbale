# 14. Airtable import

How an existing Airtable account is copied into Tessera.

## The one rule

**The Airtable account is read-only.** The importer reads; it never writes, and it is built so
that writing is not possible rather than merely not done:

- `packages/importer/src/airtable/rest-source.ts` has exactly one function that touches the
  network. It is private, and its HTTP method is the hard-coded literal `'GET'` — there is no
  parameter to override it.
- Before a request is built, the path is checked against an allowlist of three read endpoints.
  A path that is not on it throws.
- The token the importer uses carries only `schema.bases:read` and `data.records:read`. Even if
  the code above were wrong, the credential cannot authorise a write.

`packages/importer/src/__tests__/rest-source.test.ts` records every request made during the test
run and fails the suite if any used a method other than GET or reached a host other than
`api.airtable.com`. That check runs after *every* test in the file, not just the ones about
read-only behaviour.

## What you need

A read-only personal access token. Create one at <https://airtable.com/create/tokens>:

| Setting | Value |
| --- | --- |
| Scopes | `schema.bases:read`, `data.records:read` — nothing else |
| Access | Add every base you want to import |

Put it in `.env` at the repository root:

```
AIRTABLE_PAT=pat...
```

It is read directly by the importer process. It is never sent to the Tessera API, never written
to the database, and never logged.

## Where each base lands

Airtable's API does not report which workspace a base belongs to — `/v0/meta/bases` returns an
id, a name and a permission level, and that is all. The grouping exists only in Airtable's UI.

So it cannot be detected and must be stated. `airtable-workspaces.json` maps base id to
workspace name:

```json
{
  "default": "Imported from Airtable",
  "byBaseId": {
    "appR9JDSnX5vSkDSG": "delta med LLC",
    "app46gLXAy2HSAojv": "oxford backup"
  }
}
```

Workspaces are matched by name, case-insensitively, and created only when absent. A base with no
entry goes to `default` and is **listed in the report** — a base quietly landing in the wrong
place looks exactly like a successful import until somebody goes looking for it.

## Running it

```bash
cd packages/importer && IMPORT_EMAIL=owner@demo.tessera.local IMPORT_PASSWORD='Demo!Passw0rd' npx tsx src/cli.ts --all-bases --workspace-map ../../airtable-workspaces.json --all --with-attachments
```

Useful variations:

| Flag | Effect |
| --- | --- |
| `--schema-only` | Tables and fields only. Run this first against an unfamiliar account. |
| `--limit 25` | Cap records per table. The default is 100 — a full copy needs `--all`. |
| `--base "<name>"` | One base only. |
| `--base-id <id>` | Read specific bases instead of `--all-bases`. Repeatable. |
| `--workspace <id>` | Put everything in one existing workspace, ignoring the map. |

The importer signs in as a real user over the same REST API the browser uses. It has no
privileged path: every write passes the same validation, permission check, quota and audit
logging as one made by hand. An import that would violate a plan limit fails the same way a
person doing it would.

## Attachments

`--with-attachments` downloads each file and re-hosts it in Tessera's own storage.

This is not optional polish. Airtable's attachment URLs are signed and expire within hours, so
storing the link produces a table full of dead references a day later. The bytes are fetched,
identified by their leading bytes (never by the declared type), stored under a generated key, and
served afterwards from short-lived signed URLs of Tessera's own — see
`docs/03-security-and-permissions.md` §T9–T10.

Because those URLs expire, **a snapshot file cannot carry working attachment links**. Use the
live source (`--pat`) for any import where files matter; the CLI warns if you ask for attachments
from a snapshot.

## Type mapping

Every Airtable field type maps to a Tessera type with a recorded confidence:

- **exact** — no information lost.
- **lossy** — the value survives, some behaviour does not (e.g. a formula becomes its computed
  text, because the formula language differs).
- **fallback** — no close equivalent; the value is preserved as text rather than dropped.

Anything other than `exact` is printed in the import report, per field. The mapping table lives in
`packages/importer/src/airtable/mapping.ts`.

Select options are read from Airtable's own metadata when using `--pat`, which includes choices
no record currently uses. The snapshot path has to infer the option set from the values present,
and therefore cannot see an unused option — one more reason to prefer the live source.

## Re-running

The importer is additive: it creates bases, tables and fields that are absent and leaves existing
ones alone. It does **not** diff or delete. Re-running against a workspace that already holds an
import produces a second copy of the bases, so remove the previous import first if you want a
clean reload.

## Rate limits

Airtable allows 5 requests per second per base and answers a breach with a 30-second lockout. The
reader waits 220 ms between calls and, on a 429, waits out the full window and retries once — a
lockout costs far more than the pause.

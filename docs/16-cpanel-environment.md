# Environment variables for a cPanel deployment

Two cPanel Node.js applications, one per domain. Every variable below is entered in that
application's **Environment variables** section — never in a file in the repository.

The names are the ones `packages/config/src/env.ts` actually reads. Guessing them is how an
earlier version of this document demanded a variable the app does not use while staying silent
about eight it does.

## The web app — `airtable.sharptechitsolution.com`

| Variable | Value |
| --- | --- |
| `NODE_ENV` | `production` |
| `NEXT_PUBLIC_API_URL` | `https://api.airtable.sharptechitsolution.com` |

`NEXT_PUBLIC_*` values are inlined when Next.js builds, not when it starts, so this one has to be
set **before** `scripts/build-cpanel-bundle.mjs` runs. Setting it only in cPanel leaves the
uploaded bundle still pointing at localhost.

## The API — `api.airtable.sharptechitsolution.com`

| Variable | Value |
| --- | --- |
| `NODE_ENV` | `production` |
| `APP_URL` | `https://airtable.sharptechitsolution.com` |
| `API_URL` | `https://api.airtable.sharptechitsolution.com` |
| `DATABASE_URL` | the Neon connection string, including `?sslmode=require` |
| `REDIS_URL` | `redis://127.0.0.1:6379` |
| `REDIS_QUEUE_URL` | `redis://127.0.0.1:6379` |
| `STORAGE_DRIVER` | `s3` |
| `STORAGE_BUCKET` | `tessera-files` |
| `STORAGE_REGION` | `auto` |
| `STORAGE_ENDPOINT` | `https://<account-id>.r2.cloudflarestorage.com` |
| `STORAGE_PUBLIC_URL` | `https://api.airtable.sharptechitsolution.com/files` |
| `STORAGE_ACCESS_KEY_ID` | from the R2 API token |
| `STORAGE_SECRET_ACCESS_KEY` | from the R2 API token |
| `MAIL_DRIVER` | `smtp` |
| `MAIL_FROM` | `Tessera <noreply@sharptechitsolution.com>` |
| `SMTP_HOST` | `mail.sharptechitsolution.com` |
| `SMTP_PORT` | `465` |
| `SMTP_USER` | `noreply@sharptechitsolution.com` |
| `SMTP_PASSWORD` | that mailbox's password |
| `SESSION_SECRET` | 64 hex characters, generated |
| `JWT_SECRET` | 64 hex characters, generated, **different from the above** |
| `ENCRYPTION_KEY` | 64 hex characters, generated, different again |

Generate the three secrets with `openssl rand -hex 32`, once each. Reusing one value across all
three means a single leak compromises sessions, tokens and stored secrets together.

Note what `STORAGE_ENDPOINT` is **not**: it carries no bucket name. The bucket is
`STORAGE_BUCKET`. Putting `/tessera-files` on the end of the endpoint makes the SDK address
`tessera-files/tessera-files/...` and every upload fails.

`REDIS_URL` has to be a syntactically valid redis URL even where there is no Redis. Shared hosting
has none; the application degrades to no caching and no background queue rather than refusing to
start, so pointing it at a loopback address that nothing answers is the intended configuration.

## In the cPanel application form

| Field | Web | API |
| --- | --- | --- |
| Node.js version | 20 or newer | 20 or newer |
| Application mode | Production | Production |
| Application root | where `dist-cpanel/web` was uploaded | where `dist-cpanel/api` was uploaded |
| Application URL | `airtable.sharptechitsolution.com` | `api.airtable.sharptechitsolution.com` |
| Application startup file | `app.js` | `app.js` |

Do not run **NPM Install** from the cPanel panel. The dependencies are already in the uploaded
bundle, and reinstalling on the server replaces the Prisma engines with ones built for a different
platform.

## After it is running

Register through the sign-up page. The demo accounts in `packages/database/prisma/seed.ts` are
development fixtures with a password committed to the repository, and must never exist on a
server that is reachable from the internet.

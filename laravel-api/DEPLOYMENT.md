# Deploying Tessera to cPanel (Laravel API + MySQL + Next.js)

This is the whole point of the Laravel port: cPanel serves PHP + MySQL natively, so the API runs
as ordinary shared hosting with no Node process to babysit.

Two pieces deploy separately:

| Piece | Where | How |
|---|---|---|
| **API** (this Laravel app) | cPanel subdomain `api.example.com` | PHP + MySQL |
| **Frontend** (`apps/web`, Next.js) | Vercel/Netlify **or** static export | talks to the API over HTTPS |

> **Cookie rule (important).** The session is a `SameSite=Lax` cookie, which is only sent when the
> frontend and API are **same-site** (same registrable domain). Put them on
> `app.example.com` and `api.example.com` — both under `example.com` — and the cookie flows.
> Different domains would need `SameSite=None; Secure` and are not covered here.

---

## 1. Database (cPanel → MySQL Databases)

1. Create a database (e.g. `user_tessera`) and a user, and grant the user all privileges on it.
2. Note the DB name, user, and password for `.env`.

## 2. API (this app)

Upload the project to a folder **above** `public_html` — e.g. `~/tessera-api` — then in cPanel:

**Subdomain:** create `api.example.com` with its **document root set to `~/tessera-api/public`**
(never the project root — only `public/` may be web-served).

**Shell / Terminal (or "Setup PHP App" → run these):**

```bash
cd ~/tessera-api
composer install --no-dev --optimize-autoloader
cp .env.example .env            # then edit it (see below)
php artisan key:generate
php artisan migrate --force      # add --seed only for a demo/first run
php artisan config:cache
php artisan route:cache
chmod -R 775 storage bootstrap/cache
```

**`.env` for production:**

```env
APP_ENV=production
APP_DEBUG=false
APP_URL=https://api.example.com
APP_KEY=            # set by key:generate

DB_CONNECTION=mysql
DB_HOST=127.0.0.1
DB_DATABASE=user_tessera
DB_USERNAME=user_tessera
DB_PASSWORD=********

# The frontend origin, for CORS + the session cookie.
FRONTEND_ORIGIN=https://app.example.com
TESSERA_SESSION_COOKIE=tessera_session
TESSERA_SESSION_TTL_DAYS=30

SESSION_DRIVER=file
CACHE_STORE=file
QUEUE_CONNECTION=database
```

With `APP_ENV=production` the session cookie is automatically issued `Secure` (HTTPS only).

## 3. Background jobs (cron)

cPanel can't run a permanent worker, so drive Laravel's scheduler and queue from cron
(cPanel → Cron Jobs). Two entries, every minute:

```
* * * * * cd ~/tessera-api && php artisan schedule:run >/dev/null 2>&1
* * * * * cd ~/tessera-api && php artisan queue:work --stop-when-empty --max-time=55 >/dev/null 2>&1
```

The first runs due scheduled jobs (e.g. `tessera:prune-auth`); the second drains any queued jobs
and exits, so it never lingers.

## 4. Frontend (Next.js)

Next.js needs Node to render, which cPanel does not do well — so host it off cPanel:

**Option A — Vercel / Netlify (recommended, free tier):**
Deploy `apps/web`, set the env var `NEXT_PUBLIC_API_URL=https://api.example.com`, and point a
custom domain `app.example.com` at it. Zero servers to manage.

**Option B — static export onto cPanel:**
The app is a client SPA, so `next build` with `output: 'export'` can produce static files served
from `public_html`. This needs the dynamic routes (`[orgSlug]`, `[baseId]`, `[workspaceId]`)
handled as a client-routed shell and `next/image` set to `unoptimized` — a small, separate change.
Use Option A unless cPanel-only hosting is mandatory.

Either way, set `NEXT_PUBLIC_API_URL` to the API's HTTPS origin.

## 5. Verify

```bash
BASE=https://api.example.com bash scripts/smoke.sh
```

A green run (auth, tenancy, data, query, comments, isolation) means the deployment is live.

## Redeploying

Upload changed files, then:

```bash
cd ~/tessera-api
composer install --no-dev --optimize-autoloader
php artisan migrate --force
php artisan config:cache && php artisan route:cache
```

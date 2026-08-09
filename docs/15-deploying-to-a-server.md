# Deploying Tessera to a server

## Why not cPanel

Tessera will not run on a shared cPanel plan, and the reason is not configuration.

**It needs PostgreSQL.** Record data is stored as JSONB with promoted typed columns and partial
btree indexes; tenant isolation is enforced by row-level security; the filter compiler emits
Postgres SQL. A MySQL-only plan cannot run this, and porting it means rewriting the data engine
rather than changing a connection string.

**It is not PHP.** cPanel serves PHP files directly. This is Node.js: the TypeScript has to be
compiled, Next.js has to be built, and two long-running processes have to stay up — an API and a
web server — with the domain proxied to them. Cloning the repository into `public_html` gets you
a directory listing, which is exactly what it looks like when none of those steps have run.

Some cPanel plans do offer **Setup Node.js App** and **PostgreSQL Databases**. If yours has both,
it can be made to work, but you are running two apps and a database on shared hosting with a
build that wants more memory than such plans usually allow. A small VPS is cheaper in effort.

## What you need

- A VPS with at least **2 GB RAM** (the Next.js build is the memory-hungry step) and 20 GB disk
- Docker and the Compose plugin
- A domain pointed at the server's IP with an **A record**

Any provider works — Hetzner, DigitalOcean, Vultr, Contabo, or a VPS from your existing host.

## Setting it up

**1. Point the domain.** Add an A record for `airtable.cloudxhosting.us` to the server's IP.
Everything below fails at certificate issuance until this has propagated, so do it first.

**2. Install Docker.**

```bash
curl -fsSL https://get.docker.com | sh
```

**3. Clone the repository.**

```bash
git clone https://github.com/MuneebCEH/airtbaleshu.git /opt/tessera && cd /opt/tessera
```

**4. Write the secrets file** at `infra/compose/.env.prod`. Generate real values — the stack
refuses to start with any of these missing, deliberately:

```bash
cd infra/compose && printf 'DOMAIN=airtable.cloudxhosting.us\nPOSTGRES_PASSWORD=%s\nSESSION_SECRET=%s\nSIGNING_SECRET=%s\n' "$(openssl rand -hex 24)" "$(openssl rand -hex 32)" "$(openssl rand -hex 32)" > .env.prod
```

Keep this file. It is not in the repository and it is not recoverable: losing `POSTGRES_PASSWORD`
loses the database, and rotating `SIGNING_SECRET` invalidates every attachment link in existence.

**5. Start it.**

```bash
docker compose --env-file .env.prod -f docker-compose.prod.yml up -d --build
```

The first build takes ten to twenty minutes. Migrations run before the app services start, so the
API never comes up against a schema it does not expect.

**6. Check it.**

```bash
docker compose --env-file .env.prod -f docker-compose.prod.yml ps
```

Then open `https://airtable.cloudxhosting.us`. Caddy obtains the certificate on first request; if
that fails, the domain's A record has not propagated yet.

## Creating the first account

The demo accounts are seed data for local development and must not exist on a server. Register
through the sign-up page instead, then create your organization from the UI.

If you want the Airtable import on the server, run it there with your Airtable token in the
environment — the importer only ever issues GET requests, and copying an already-imported local
database is the slower path.

## Day to day

Deploy a change:

```bash
cd /opt/tessera && git pull && docker compose --env-file infra/compose/.env.prod -f infra/compose/docker-compose.prod.yml up -d --build
```

Read the logs:

```bash
docker compose --env-file infra/compose/.env.prod -f infra/compose/docker-compose.prod.yml logs -f api
```

Back up the database — do this on a schedule, not when you remember:

```bash
docker compose --env-file infra/compose/.env.prod -f infra/compose/docker-compose.prod.yml exec -T postgres pg_dump -U tessera tessera | gzip > "tessera-$(date +%F).sql.gz"
```

Attachments live in the `attachments` volume and are **not** in that dump. Back them up too:

```bash
docker run --rm -v tessera-prod_attachments:/data -v "$PWD:/backup" alpine tar czf "/backup/attachments-$(date +%F).tar.gz" -C /data .
```

## The managed alternative

If you would rather not run a server, the same code deploys to managed services: the web app to
Vercel, the API to Railway or Render, and Postgres to Neon or Supabase. It costs more per month
and removes the backup and patching work. The application does not change — only where each part
runs and what `DATABASE_URL` points at.

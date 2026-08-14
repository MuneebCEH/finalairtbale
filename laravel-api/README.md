# Tessera API — Laravel + MySQL

A Laravel 12 port of the Tessera backend, built to run on cPanel/PHP shared hosting with MySQL
(or MariaDB). It reproduces the NestJS API contract exactly — same paths, same `{ data }` /
`{ error }` envelopes, same `tessera_session` cookie — so the existing Next.js frontend can talk
to it unchanged.

> **Migration in progress.** The NestJS/PostgreSQL backend in `../apps/api` remains the source of
> truth until this port reaches parity. See `../docs` and the project memory for the phase plan.

## Status

- **Phase 1 — Foundation:** response/error envelopes, error-code catalogue, request-id, health.
- **Phase 2 — Auth:** register, email verification, login/logout, refresh, password
  forgot/reset/change, session listing/revocation, `GET`/`PATCH /v1/me`.

Remaining: organizations & permissions, the data plane (bases/tables/fields/records), import,
queue jobs, and the parity gate.

## Local setup

Requires PHP 8.2+, Composer, and MySQL/MariaDB (XAMPP works).

```bash
composer install
cp .env.example .env
php artisan key:generate
# create the database, then:
php artisan migrate --seed
php artisan serve --port=8000
```

Demo accounts (all password `Demo!Passw0rd`): `owner@demo.tessera.local` and four others.

## Endpoints

`GET /health/{live,ready}` · `POST /v1/auth/{register,verify-email,login,logout,refresh}` ·
`POST /v1/auth/password/{forgot,reset,change}` · `GET|DELETE /v1/auth/sessions[/{id}]` ·
`GET|PATCH /v1/me`

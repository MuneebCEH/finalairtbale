#!/usr/bin/env bash
#
# Parity smoke test for the Laravel + MySQL API.
#
# Exercises the core flows end to end against a running server, purely through the public API
# (no direct DB access), then cleans up after itself. This is the parity gate: it must pass before
# the Laravel backend can stand in for the NestJS one.
#
#   BASE=http://localhost:8000 bash scripts/smoke.sh
#
# Assumes the demo seed has been run (php artisan migrate --seed).
set -u

BASE="${BASE:-http://localhost:8000}"
OWNER='{"email":"owner@demo.tessera.local","password":"Demo!Passw0rd"}'
RIVAL='{"email":"owner@rival.tessera.local","password":"Demo!Passw0rd"}'
PASS=0 FAIL=0
oc=$(mktemp) rc=$(mktemp)

ok()   { echo "  ok   - $1"; PASS=$((PASS+1)); }
bad()  { echo "  FAIL - $1  ($2)"; FAIL=$((FAIL+1)); }
# first "id":"..." in the payload
id()   { grep -oE '"id":"[^"]+"' | head -1 | sed -E 's/"id":"([^"]+)"/\1/'; }

echo "Tessera API smoke — $BASE"

# 1. health
curl -s "$BASE/health/ready" | grep -q '"database":true' && ok "health: database up" || bad "health" "$(curl -s "$BASE/health/ready")"

# 2. auth
code=$(curl -s -o /dev/null -w '%{http_code}' -c "$oc" -X POST "$BASE/v1/auth/login" -H 'Content-Type: application/json' -d "$OWNER")
[ "$code" = 200 ] && ok "auth: owner login" || bad "auth login" "$code"
curl -s -o /dev/null -w '%{http_code}' -X POST "$BASE/v1/auth/login" -H 'Content-Type: application/json' -d '{"email":"owner@demo.tessera.local","password":"nope"}' | grep -q 401 && ok "auth: bad password rejected" || bad "auth reject" "x"
curl -s -b "$oc" "$BASE/v1/me" | grep -q 'owner@demo.tessera.local' && ok "auth: /v1/me via cookie" || bad "me" "x"

# 3. tenancy
ORG=$(curl -s -b "$oc" "$BASE/v1/me/organizations" | id)
[ -n "$ORG" ] && ok "tenancy: me/organizations" || bad "orgs" "empty"
WS=$(curl -s -b "$oc" "$BASE/v1/organizations/$ORG/workspaces" | id)
[ -n "$WS" ] && ok "tenancy: workspaces" || bad "workspaces" "empty"

# 4. data plane
BID=$(curl -s -b "$oc" -X POST "$BASE/v1/workspaces/$WS/bases" -H 'Content-Type: application/json' -d '{"name":"Smoke Base"}' | id)
[ -n "$BID" ] && ok "data: create base" || bad "base" "empty"
TJ=$(curl -s -b "$oc" -X POST "$BASE/v1/bases/$BID/tables" -H 'Content-Type: application/json' -d '{"name":"Smoke Table"}')
TID=$(echo "$TJ" | id)
PF=$(echo "$TJ" | grep -oE '"primaryFieldId":"[^"]+"' | sed -E 's/.*:"([^"]+)"/\1/')
{ [ -n "$TID" ] && [ -n "$PF" ]; } && ok "data: create table + primary field" || bad "table" "$TJ"
AGE=$(curl -s -b "$oc" -X POST "$BASE/v1/tables/$TID/fields" -H 'Content-Type: application/json' -d '{"name":"Age","type":"number"}' | id)
[ -n "$AGE" ] && ok "data: add field" || bad "field" "empty"
R1=$(curl -s -b "$oc" -X POST "$BASE/v1/tables/$TID/records" -H 'Content-Type: application/json' -d "{\"fields\":{\"$PF\":\"Ann\",\"$AGE\":41}}" | id)
curl -s -b "$oc" -X POST "$BASE/v1/tables/$TID/records" -H 'Content-Type: application/json' -o /dev/null -d "{\"fields\":{\"$PF\":\"Ben\",\"$AGE\":22}}"
[ -n "$R1" ] && ok "data: create records" || bad "records" "empty"

# 5. query engine
n=$(curl -s -b "$oc" -X POST "$BASE/v1/tables/$TID/records/query" -H 'Content-Type: application/json' -d "{\"filter\":{\"conjunction\":\"and\",\"conditions\":[{\"fieldId\":\"$AGE\",\"operator\":\"gt\",\"value\":30}]}}" | grep -o '"id"' | wc -l)
[ "$n" -eq 1 ] && ok "query: filter Age>30 = 1" || bad "query" "$n"

# 6. comments
CC=$(curl -s -b "$oc" -X POST "$BASE/v1/records/$R1/comments" -H 'Content-Type: application/json' -d '{"type":"doc","content":[{"type":"paragraph","content":[{"type":"text","text":"hi"}]}]}')
echo "$CC" | grep -q '"recordId"' && ok "comments: create" || bad "comment" "$CC"

# 7. tenant isolation
curl -s -o /dev/null -c "$rc" -X POST "$BASE/v1/auth/login" -H 'Content-Type: application/json' -d "$RIVAL"
code=$(curl -s -b "$rc" -o /dev/null -w '%{http_code}' "$BASE/v1/bases/$BID")
[ "$code" = 404 ] && ok "isolation: rival -> base 404" || bad "isolation" "$code"

# cleanup
curl -s -b "$oc" -o /dev/null -X DELETE "$BASE/v1/bases/$BID"
rm -f "$oc" "$rc"

echo "-----------------------------------------"
echo "PASS=$PASS  FAIL=$FAIL"
[ "$FAIL" -eq 0 ] && { echo "SMOKE OK"; exit 0; } || { echo "SMOKE FAILED"; exit 1; }

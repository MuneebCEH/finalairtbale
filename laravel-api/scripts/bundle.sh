#!/usr/bin/env bash
#
# Builds a cPanel-ready deployment bundle of the Laravel API — a tarball with production
# dependencies already installed, so a shared host without a build toolchain can just extract it.
# Secrets (.env), dev dependencies, logs, and VCS metadata are excluded.
#
#   bash scripts/bundle.sh
#
# Output: dist-cpanel/tessera-api-cpanel.tar.gz  (see DEPLOYMENT.md for the upload steps)
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OUT="$ROOT/dist-cpanel"
BUILD="$OUT/build"

echo "==> Staging source into $BUILD"
rm -rf "$BUILD"
mkdir -p "$BUILD"
tar -C "$ROOT" \
  --exclude='./dist-cpanel' --exclude='./vendor' --exclude='./node_modules' \
  --exclude='./.git' --exclude='./.env' --exclude='./storage/logs/*' \
  --exclude='./tests' --exclude='./.phpunit.cache' \
  -cf - . | tar -C "$BUILD" -xf -

echo "==> Installing production dependencies"
( cd "$BUILD" && composer install --no-dev --optimize-autoloader --no-interaction --quiet )

echo "==> Ensuring writable runtime directories exist"
mkdir -p "$BUILD/storage/framework/cache/data" \
         "$BUILD/storage/framework/sessions" \
         "$BUILD/storage/framework/views" \
         "$BUILD/storage/logs" \
         "$BUILD/bootstrap/cache"

echo "==> Packaging"
tar -C "$BUILD" -czf "$OUT/tessera-api-cpanel.tar.gz" .
rm -rf "$BUILD"

SIZE=$(du -h "$OUT/tessera-api-cpanel.tar.gz" | cut -f1)
echo "==> Bundle ready: $OUT/tessera-api-cpanel.tar.gz ($SIZE)"
echo "    Upload it above public_html, extract, then follow DEPLOYMENT.md."

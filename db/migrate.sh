#!/usr/bin/env bash
# Minimal, idempotent migration runner (plain SQL, applied in filename order).
# Usage: DATABASE_URL=postgres://migrator@host:5432/whreg ./db/migrate.sh [--seed]
set -euo pipefail
: "${DATABASE_URL:?DATABASE_URL is required (use the MIGRATOR role, never app_api)}"
DIR="$(cd "$(dirname "$0")" && pwd)"
PSQL=(psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -q -X)

"${PSQL[@]}" -c "CREATE TABLE IF NOT EXISTS public.schema_migrations (
  version text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())"

for f in "$DIR"/migrations/*.sql; do
  v="$(basename "$f")"
  if [[ -z "$("${PSQL[@]}" -tAc "SELECT 1 FROM public.schema_migrations WHERE version = '$v'")" ]]; then
    echo "→ applying $v"
    "${PSQL[@]}" --single-transaction -f "$f" -c "INSERT INTO public.schema_migrations(version) VALUES ('$v')"
  fi
done

# Set the API login password (never stored in migrations).
if [[ -n "${APP_API_PASSWORD:-}" ]]; then
  "${PSQL[@]}" -c "ALTER ROLE app_api PASSWORD '${APP_API_PASSWORD//\'/\'\'}'"
fi

if [[ "${1:-}" == "--seed" ]]; then
  echo "→ seeding dev data"
  "${PSQL[@]}" -f "$DIR/seed/seed_dev.sql"
fi
echo "✓ database up to date"

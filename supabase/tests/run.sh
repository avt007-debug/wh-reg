#!/usr/bin/env bash
# Database test-suite (RLS isolation, financial lockout, GST maths, override PIN,
# transfers, owner RPCs, WhatsApp worker RPCs, storage policies).
#
#   Real Supabase stack (CI / your PC with Docker):
#     supabase start && ./supabase/tests/run.sh --supabase
#   Plain Postgres 15+ (no Docker) — uses supabase/tests/stub/supabase_stub.sql:
#     ADMIN_URL=postgres://postgres@localhost:5432/postgres ./supabase/tests/run.sh --plain   (needs PostgreSQL 17+)
set -euo pipefail
DIR="$(cd "$(dirname "$0")/.." && pwd)"
TEST="$DIR/tests/rls_and_rules_test.sql"
clean() { sed -E 's/^psql:[^:]*:[0-9]*: //'; }

case "${1:-}" in
  --supabase)
    (cd "$DIR/.." && supabase db reset)
    DB_URL="${SUPABASE_DB_URL:-postgresql://postgres:postgres@127.0.0.1:54322/postgres}"
    psql "$DB_URL" -X -v ON_ERROR_STOP=1 -f "$TEST" 2>&1 | clean
    ;;
  --plain)
    : "${ADMIN_URL:?ADMIN_URL (superuser connection to the 'postgres' db) is required}"
    DB="whreg_test_$$"
    psql "$ADMIN_URL" -qX -c "CREATE DATABASE $DB"
    trap 'psql "$ADMIN_URL" -qX -c "DROP DATABASE IF EXISTS $DB WITH (FORCE)"' EXIT
    DB_URL="$(echo "$ADMIN_URL" | sed -E "s#/postgres(\?|$)#/$DB\1#")"
    psql "$DB_URL" -qX -v ON_ERROR_STOP=1 -f "$DIR/tests/stub/supabase_stub.sql" >/dev/null
    for f in "$DIR"/migrations/*.sql; do
      if ! out="$(psql "$DB_URL" -qX -v ON_ERROR_STOP=1 --single-transaction -f "$f" 2>&1)"; then
        echo "✗ migration failed: $(basename "$f")"; echo "$out" | clean; exit 1
      fi
    done
    psql "$DB_URL" -qX -v ON_ERROR_STOP=1 -f "$DIR/seed.sql" >/dev/null
    psql "$DB_URL" -X -v ON_ERROR_STOP=1 -f "$TEST" 2>&1 | clean
    ;;
  *) echo "usage: $0 --supabase | --plain"; exit 2 ;;
esac

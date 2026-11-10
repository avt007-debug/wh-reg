#!/usr/bin/env bash
# Creates a throwaway database, migrates, seeds and runs the SQL test-suite.
# Usage: ADMIN_URL=postgres://postgres@localhost:5432/postgres ./db/test.sh
set -euo pipefail
: "${ADMIN_URL:?ADMIN_URL (superuser connection to the 'postgres' db) is required}"
DIR="$(cd "$(dirname "$0")" && pwd)"
DB="whreg_test_$$"
psql "$ADMIN_URL" -qX -c "CREATE DATABASE $DB"
trap 'psql "$ADMIN_URL" -qX -c "DROP DATABASE IF EXISTS $DB WITH (FORCE)"' EXIT
TEST_URL="$(echo "$ADMIN_URL" | sed -E "s#/postgres(\?|$)#/$DB\1#")"
DATABASE_URL="$TEST_URL" "$DIR/migrate.sh" --seed >/dev/null
psql "$TEST_URL" -X -v ON_ERROR_STOP=1 -f "$DIR/tests/rls_and_rules_test.sql" 2>&1 | sed 's/^psql:[^:]*:[0-9]*: //'

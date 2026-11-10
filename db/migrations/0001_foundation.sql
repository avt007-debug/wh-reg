-- =============================================================================
-- 0001_foundation.sql
-- Extensions, schemas, database roles, enums and small helper functions.
--
-- Security model (read docs/ARCHITECTURE.md §3 for the full picture):
--   * The API connects as  app_api  (LOGIN, NOINHERIT, no table privileges).
--   * Per request it runs  SET LOCAL ROLE app_employee | app_owner | app_auth
--     and  set_config('app.user_id', <uuid>, true)  inside one transaction.
--   * GRANTs decide WHICH tables a role can touch at all (fin.* is invisible to
--     app_employee); RLS policies decide WHICH ROWS (warehouse isolation,
--     "own transactions today"). Both layers must fail for a leak to happen.
-- =============================================================================

CREATE EXTENSION IF NOT EXISTS pgcrypto;   -- gen_random_uuid(), crypt() for PINs
CREATE EXTENSION IF NOT EXISTS pg_trgm;    -- fuzzy item search
CREATE EXTENSION IF NOT EXISTS citext;     -- case-insensitive login ids
CREATE EXTENSION IF NOT EXISTS unaccent;

CREATE SCHEMA IF NOT EXISTS app;    -- helper + SECURITY DEFINER functions
CREATE SCHEMA IF NOT EXISTS auth;   -- credentials, refresh tokens (app_auth only)
CREATE SCHEMA IF NOT EXISTS fin;    -- owner-only financial data & analytics

-- ---------------------------------------------------------------------------
-- Roles (cluster-level; idempotent)
-- ---------------------------------------------------------------------------
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_employee') THEN
    CREATE ROLE app_employee NOLOGIN;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_owner') THEN
    CREATE ROLE app_owner NOLOGIN;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_auth') THEN
    CREATE ROLE app_auth NOLOGIN;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_api') THEN
    -- Password is set at deploy time:  ALTER ROLE app_api PASSWORD '...';
    CREATE ROLE app_api LOGIN NOINHERIT;
  END IF;
END$$;

DO $$
DECLARE r text;
BEGIN
  FOREACH r IN ARRAY ARRAY['app_employee','app_owner','app_auth'] LOOP
    IF NOT pg_has_role('app_api', r, 'MEMBER') THEN
      EXECUTE format('GRANT %I TO app_api', r);
    END IF;
  END LOOP;
END$$;

-- Lock down defaults: nobody gets anything implicitly.
REVOKE ALL ON SCHEMA public FROM PUBLIC;
REVOKE ALL ON SCHEMA app, auth, fin FROM PUBLIC;

GRANT USAGE ON SCHEMA public, app TO app_employee, app_owner, app_auth;
GRANT USAGE ON SCHEMA fin  TO app_owner;     -- employees cannot even resolve fin.*
GRANT USAGE ON SCHEMA auth TO app_auth;

-- ---------------------------------------------------------------------------
-- Enums
-- ---------------------------------------------------------------------------
CREATE TYPE user_role AS ENUM ('OWNER', 'ADMIN', 'EMPLOYEE', 'SYSTEM');
CREATE TYPE txn_status AS ENUM ('POSTED', 'CANCELLED');
CREATE TYPE transfer_status AS ENUM ('DRAFT', 'IN_TRANSIT', 'RECEIVED', 'CANCELLED');
CREATE TYPE transport_mode AS ENUM (
  'OWN_VEHICLE', 'TRANSPORTER', 'COURIER', 'CUSTOMER_PICKUP', 'RAIL', 'AIR'
);
CREATE TYPE movement_type AS ENUM (
  'PURCHASE_IN', 'DISPATCH_OUT', 'TRANSFER_OUT', 'TRANSFER_IN',
  'ADJUST_DAMAGE', 'ADJUST_LOSS', 'ADJUST_FOUND', 'ADJUST_AUDIT', 'OPENING',
  'REVERSAL'
);
CREATE TYPE outbox_status AS ENUM ('PENDING', 'SENDING', 'SENT', 'DELIVERED', 'FAILED', 'DEAD');

-- ---------------------------------------------------------------------------
-- Small pure helpers
-- ---------------------------------------------------------------------------

-- Business "today" is always Indian Standard Time, regardless of server TZ.
CREATE FUNCTION app.today_ist() RETURNS date
LANGUAGE sql STABLE AS $$ SELECT (now() AT TIME ZONE 'Asia/Kolkata')::date $$;

-- Start of today in IST as timestamptz (for index-friendly range filters).
CREATE FUNCTION app.today_ist_start() RETURNS timestamptz
LANGUAGE sql STABLE AS $$ SELECT (app.today_ist()::timestamp AT TIME ZONE 'Asia/Kolkata') $$;

-- Indian financial year label for a date, e.g. 2026-11-10 -> '26-27'.
CREATE FUNCTION app.fy_label(d date) RETURNS text
LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE WHEN extract(month FROM d) >= 4
              THEN to_char(d, 'YY') || '-' || to_char(d + interval '1 year', 'YY')
              ELSE to_char(d - interval '1 year', 'YY') || '-' || to_char(d, 'YY')
         END
$$;

-- GSTIN structural + checksum validation (15 chars, mod-36 check digit).
CREATE FUNCTION app.gstin_valid(g text) RETURNS boolean
LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE
  cs  constant text := '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ';
  s   int := 0;
  v   int;
  p   int;
BEGIN
  IF g IS NULL THEN RETURN true; END IF;              -- optional fields
  IF g !~ '^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$' THEN RETURN false; END IF;
  FOR i IN 1..14 LOOP
    v := strpos(cs, substr(g, i, 1)) - 1;
    p := v * (CASE WHEN i % 2 = 1 THEN 1 ELSE 2 END);
    s := s + (p / 36) + (p % 36);
  END LOOP;
  RETURN substr(cs, ((36 - (s % 36)) % 36) + 1, 1) = substr(g, 15, 1);
END$$;

-- Two-digit state code from a GSTIN (first two characters).
CREATE FUNCTION app.gstin_state(g text) RETURNS char(2)
LANGUAGE sql IMMUTABLE AS $$ SELECT CASE WHEN g IS NULL THEN NULL ELSE substr(g, 1, 2)::char(2) END $$;

-- Generic updated_at maintenance.
CREATE FUNCTION app.touch_updated_at() RETURNS trigger
LANGUAGE plpgsql AS $$ BEGIN NEW.updated_at := now(); RETURN NEW; END $$;

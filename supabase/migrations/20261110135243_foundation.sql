-- =============================================================================
-- foundation — extensions, private schemas, enums, pure helpers.
--
-- Supabase security model (see docs/ARCHITECTURE.md §3):
--   * Every signed-in user reaches the database as the built-in role
--     `authenticated`; identity comes from auth.uid() (the JWT `sub`).
--   * Tables in `public` are reachable through the Supabase Data API, so every
--     one has RLS enabled and explicit, minimal GRANTs (Supabase's defaults are
--     revoked in the rls migration).
--   * Schemas `app` (helpers), `fin` (owner-only finance) and `secure` (PIN
--     hashes) are NOT exposed by the Data API and not granted to anon /
--     authenticated. Owners reach fin.* only through owner_* RPCs that check
--     the caller's role in the users table.
-- =============================================================================

CREATE EXTENSION IF NOT EXISTS pgcrypto WITH SCHEMA extensions;   -- crypt()/gen_salt() for PINs
CREATE EXTENSION IF NOT EXISTS pg_trgm  WITH SCHEMA extensions;   -- fuzzy item search
CREATE EXTENSION IF NOT EXISTS citext   WITH SCHEMA extensions;   -- case-insensitive login ids
CREATE EXTENSION IF NOT EXISTS unaccent WITH SCHEMA extensions;

CREATE SCHEMA IF NOT EXISTS app;     -- helper + SECURITY DEFINER functions
CREATE SCHEMA IF NOT EXISTS fin;     -- owner-only financial data & analytics
CREATE SCHEMA IF NOT EXISTS secure;  -- override PIN hashes & attempts (no role but postgres)

REVOKE ALL ON SCHEMA app, fin, secure FROM PUBLIC, anon, authenticated;
GRANT USAGE ON SCHEMA app TO authenticated, service_role;   -- RLS policies call app.* helpers

-- ---------------------------------------------------------------------------
-- Enums
-- ---------------------------------------------------------------------------
CREATE TYPE user_role AS ENUM ('OWNER', 'ADMIN', 'EMPLOYEE');
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

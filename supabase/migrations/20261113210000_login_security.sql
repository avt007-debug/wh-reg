-- Login & security
--   • login history (success + failures) per device, owner alerts after repeated wrong passwords,
--     temporary lock of that User ID
--   • devices: optional owner approval of new phones for employees
--   • optional working-hours login window for employees
--   • session version: owner can "log out everywhere"; password reset / disable / remove also
--     signs the person out on every phone (the app checks every 2 minutes)
--   • owner recovery codes (one-time) for a forgotten owner password
--   • auto-lock after inactivity (setting read by the app)

ALTER TABLE users ADD COLUMN session_version int NOT NULL DEFAULT 0;

INSERT INTO app_settings(key, value) VALUES ('security', jsonb_build_object(
  'lock_after_failures', 5,           -- wrong passwords in 15 minutes before the User ID is locked
  'lock_minutes', 15,
  'require_device_approval', false,   -- employees: new phones need the owner's OK
  'staff_hours', jsonb_build_object('enabled', false, 'from', '07:00', 'to', '21:00'),
  'staff_idle_minutes', 30,           -- app locks after this much inactivity (0 = never)
  'owner_idle_minutes', 0
)) ON CONFLICT (key) DO NOTHING;

CREATE TABLE login_events (
  id           bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id      uuid REFERENCES users(id),
  login_id     text NOT NULL,
  success      boolean NOT NULL,
  device_id    text,
  device_name  text,
  user_agent   text,
  note         text,
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX login_events_login_idx ON login_events(lower(login_id), created_at DESC);
CREATE INDEX login_events_user_idx ON login_events(user_id, created_at DESC);

CREATE TABLE user_devices (
  user_id      uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  device_id    text NOT NULL CHECK (length(device_id) BETWEEN 8 AND 80),
  device_name  text,
  status       text NOT NULL DEFAULT 'APPROVED' CHECK (status IN ('PENDING', 'APPROVED', 'BLOCKED')),
  first_seen   timestamptz NOT NULL DEFAULT now(),
  last_seen    timestamptz NOT NULL DEFAULT now(),
  decided_by   uuid REFERENCES users(id),
  PRIMARY KEY (user_id, device_id)
);

CREATE TABLE secure.recovery_codes (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  code_hash   text NOT NULL,
  used_at     timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE login_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE user_devices ENABLE ROW LEVEL SECURITY;
ALTER TABLE secure.recovery_codes ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON login_events, user_devices FROM PUBLIC, anon, authenticated;
REVOKE ALL ON secure.recovery_codes FROM PUBLIC, anon, authenticated;

-- ---------------------------------------------------------------------------
-- Before / after the password check (called by the login screen, no session yet)
-- ---------------------------------------------------------------------------
CREATE FUNCTION app.login_lock_until(p_login text) RETURNS timestamptz
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, extensions, pg_temp AS $$
  WITH s AS (SELECT app.setting('security') AS v),
  f AS (SELECT e.created_at FROM login_events e, s
         WHERE lower(e.login_id) = lower(btrim(p_login)) AND NOT e.success AND coalesce(e.note, '') <> 'UNLOCKED'
           AND e.created_at > now() - interval '15 minutes'
           AND e.created_at > coalesce((SELECT max(created_at) FROM login_events x
                                         WHERE lower(x.login_id) = lower(btrim(p_login)) AND (x.success OR x.note = 'UNLOCKED')), '-infinity')
         ORDER BY e.created_at DESC)
  SELECT CASE WHEN count(*) >= (SELECT (v->>'lock_after_failures')::int FROM s)
              THEN max(created_at) + make_interval(mins => (SELECT (v->>'lock_minutes')::int FROM s)) END
    FROM f
$$;

-- Returns when this User ID may try again (NULL = now). Same answer for unknown IDs.
CREATE FUNCTION public.login_precheck(p_login_id text) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, extensions, pg_temp AS $$
  SELECT jsonb_build_object('locked_until', CASE WHEN app.login_lock_until(p_login_id) > now() THEN app.login_lock_until(p_login_id) END)
$$;

CREATE FUNCTION public.login_failed(p_login_id text, p_device_id text DEFAULT NULL, p_device_name text DEFAULT NULL) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, extensions, pg_temp AS $$
DECLARE v_login text := left(lower(btrim(coalesce(p_login_id, ''))), 40); v_user uuid; v_n int;
BEGIN
  IF v_login = '' THEN RETURN '{}'; END IF;
  -- at most 30 records a minute per ID (protects the table from floods)
  IF (SELECT count(*) FROM login_events WHERE lower(login_id) = v_login AND created_at > now() - interval '1 minute') >= 30 THEN
    RETURN public.login_precheck(v_login);
  END IF;
  SELECT id INTO v_user FROM users WHERE login_id = v_login::extensions.citext;
  INSERT INTO login_events(user_id, login_id, success, device_id, device_name)
  VALUES (v_user, v_login, false, left(p_device_id, 80), left(p_device_name, 80));
  SELECT count(*) INTO v_n FROM login_events WHERE lower(login_id) = v_login AND NOT success AND created_at > now() - interval '15 minutes';
  IF v_user IS NOT NULL AND v_n = (app.setting('security')->>'lock_after_failures')::int THEN
    PERFORM app.notify_owners('LOGIN_ALERT', 'Wrong passwords for ' || v_login,
      v_n || ' wrong passwords in 15 minutes' || coalesce(' on ' || p_device_name, '') || '. The User ID is locked for '
        || (app.setting('security')->>'lock_minutes') || ' minutes. Unlock it or reset the password in Settings.',
      jsonb_build_object('login_id', v_login), 'loginlock:' || v_login || ':' || to_char(now(), 'YYYYMMDDHH24'));
  END IF;
  RETURN public.login_precheck(v_login);
END$$;

-- ---------------------------------------------------------------------------
-- After a successful password check
-- ---------------------------------------------------------------------------
CREATE FUNCTION app.access_state(p_user uuid, p_device text) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, extensions, pg_temp AS $$
DECLARE s jsonb := app.setting('security'); u users; d user_devices; v_now time := (now() AT TIME ZONE 'Asia/Kolkata')::time;
BEGIN
  SELECT * INTO u FROM users WHERE id = p_user;
  IF NOT FOUND OR NOT u.is_active OR u.removed_at IS NOT NULL THEN
    RETURN jsonb_build_object('allowed', false, 'reason', 'DISABLED');
  END IF;
  IF u.role = 'EMPLOYEE' THEN
    IF (s->'staff_hours'->>'enabled')::boolean
       AND NOT (v_now BETWEEN (s->'staff_hours'->>'from')::time AND (s->'staff_hours'->>'to')::time) THEN
      RETURN jsonb_build_object('allowed', false, 'reason', 'OUTSIDE_HOURS', 'from', s->'staff_hours'->>'from', 'to', s->'staff_hours'->>'to');
    END IF;
    SELECT * INTO d FROM user_devices WHERE user_id = p_user AND device_id = p_device;
    IF d.status = 'BLOCKED' THEN RETURN jsonb_build_object('allowed', false, 'reason', 'DEVICE_BLOCKED'); END IF;
    IF (s->>'require_device_approval')::boolean AND coalesce(d.status, 'PENDING') <> 'APPROVED' THEN
      RETURN jsonb_build_object('allowed', false, 'reason', 'DEVICE_PENDING');
    END IF;
  END IF;
  RETURN jsonb_build_object('allowed', true, 'session_version', u.session_version,
    'idle_minutes', CASE WHEN u.role = 'EMPLOYEE' THEN (s->>'staff_idle_minutes')::int ELSE (s->>'owner_idle_minutes')::int END);
END$$;

CREATE FUNCTION public.session_start(p_device_id text, p_device_name text DEFAULT NULL, p_user_agent text DEFAULT NULL) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, extensions, pg_temp AS $$
DECLARE v_uid uuid := auth.uid(); u users; v_new boolean; st jsonb; s jsonb := app.setting('security');
BEGIN
  SELECT * INTO u FROM users WHERE id = v_uid;
  IF NOT FOUND THEN RAISE EXCEPTION 'No staff profile for this login' USING ERRCODE = 'WH002'; END IF;
  INSERT INTO user_devices(user_id, device_id, device_name, status)
  VALUES (v_uid, p_device_id, left(p_device_name, 80),
          CASE WHEN u.role = 'EMPLOYEE' AND (s->>'require_device_approval')::boolean
                    AND EXISTS (SELECT 1 FROM user_devices WHERE user_id = v_uid) THEN 'PENDING' ELSE 'APPROVED' END)
  ON CONFLICT (user_id, device_id) DO UPDATE SET last_seen = now(), device_name = coalesce(EXCLUDED.device_name, user_devices.device_name)
  RETURNING (xmax = 0) INTO v_new;
  st := app.access_state(v_uid, p_device_id);
  INSERT INTO login_events(user_id, login_id, success, device_id, device_name, user_agent, note)
  VALUES (v_uid, u.login_id, (st->>'allowed')::boolean, left(p_device_id, 80), left(p_device_name, 80), left(p_user_agent, 200),
          CASE WHEN (st->>'allowed')::boolean THEN NULL ELSE st->>'reason' END);
  IF st->>'reason' = 'DEVICE_PENDING' THEN
    PERFORM app.notify_owners('LOGIN_ALERT', 'New phone for ' || u.full_name,
      u.full_name || ' is trying to log in on a new device' || coalesce(' (' || p_device_name || ')', '') || '. Approve it in Settings → Login security.',
      jsonb_build_object('user_id', v_uid), 'newdevice:' || v_uid || ':' || p_device_id);
  END IF;
  RETURN st;
END$$;

-- Called by the app every 2 minutes and when it comes back to the screen.
CREATE FUNCTION public.session_check(p_device_id text, p_version int) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, extensions, pg_temp AS $$
DECLARE v_uid uuid := auth.uid(); st jsonb;
BEGIN
  IF v_uid IS NULL THEN RETURN jsonb_build_object('allowed', false, 'reason', 'SIGNED_OUT'); END IF;
  UPDATE user_devices SET last_seen = now() WHERE user_id = v_uid AND device_id = p_device_id;
  st := app.access_state(v_uid, p_device_id);
  IF (st->>'allowed')::boolean AND p_version IS NOT NULL AND (st->>'session_version')::int <> p_version THEN
    RETURN jsonb_build_object('allowed', false, 'reason', 'SIGNED_OUT_BY_OWNER');
  END IF;
  RETURN st;
END$$;

-- ---------------------------------------------------------------------------
-- Owner tools
-- ---------------------------------------------------------------------------
CREATE FUNCTION public.owner_login_activity(p_user uuid DEFAULT NULL, p_limit int DEFAULT 100) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, extensions, pg_temp AS $$
BEGIN
  PERFORM app.require_owner();
  RETURN jsonb_build_object(
    'events', (SELECT coalesce(jsonb_agg(row_to_json(e)::jsonb ORDER BY e.created_at DESC), '[]') FROM (
       SELECT le.id, le.login_id, u.full_name, le.success, le.device_name, le.note, le.created_at
         FROM login_events le LEFT JOIN users u ON u.id = le.user_id
        WHERE p_user IS NULL OR le.user_id = p_user
        ORDER BY le.created_at DESC LIMIT least(p_limit, 500)) e),
    'devices', (SELECT coalesce(jsonb_agg(jsonb_build_object('user_id', d.user_id, 'full_name', u.full_name, 'login_id', u.login_id,
                   'device_id', d.device_id, 'device_name', d.device_name, 'status', d.status, 'first_seen', d.first_seen, 'last_seen', d.last_seen)
                   ORDER BY (d.status = 'PENDING') DESC, d.last_seen DESC), '[]')
                  FROM user_devices d JOIN users u ON u.id = d.user_id WHERE p_user IS NULL OR d.user_id = p_user),
    'locked', (SELECT coalesce(jsonb_agg(jsonb_build_object('login_id', l, 'until', app.login_lock_until(l))), '[]')
                 FROM (SELECT DISTINCT lower(login_id) AS l FROM login_events WHERE NOT success AND created_at > now() - interval '15 minutes') z
                WHERE app.login_lock_until(l) > now()),
    'settings', app.setting('security'));
END$$;

CREATE FUNCTION public.owner_set_device(p_user uuid, p_device_id text, p_status text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, extensions, pg_temp AS $$
BEGIN
  PERFORM app.require_owner();
  IF p_status = 'FORGET' THEN DELETE FROM user_devices WHERE user_id = p_user AND device_id = p_device_id; RETURN; END IF;
  IF p_status NOT IN ('APPROVED', 'BLOCKED') THEN RAISE EXCEPTION 'Unknown device status' USING ERRCODE = 'WH005'; END IF;
  UPDATE user_devices SET status = p_status, decided_by = app.current_user_id() WHERE user_id = p_user AND device_id = p_device_id;
  IF p_status = 'APPROVED' THEN
    PERFORM app.notify_user(p_user, 'LOGIN_ALERT', 'Your phone is approved', 'You can now log in on this device.', '{}', NULL);
  END IF;
END$$;

CREATE FUNCTION public.owner_unlock_login(p_login_id text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, extensions, pg_temp AS $$
BEGIN
  PERFORM app.require_owner();
  INSERT INTO login_events(user_id, login_id, success, note)
  SELECT (SELECT id FROM users WHERE login_id = lower(btrim(p_login_id))::extensions.citext), lower(btrim(p_login_id)), false, 'UNLOCKED';
END$$;

-- Signs the person out on every phone/computer (the app notices within 2 minutes).
CREATE FUNCTION app.revoke_sessions(p_user uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, extensions, pg_temp AS $$
BEGIN
  UPDATE users SET session_version = session_version + 1 WHERE id = p_user;
  BEGIN
    EXECUTE 'DELETE FROM auth.sessions WHERE user_id = $1' USING p_user;   -- also kills refresh tokens (cascade)
  EXCEPTION WHEN undefined_table OR insufficient_privilege THEN NULL;
  END;
END$$;

CREATE FUNCTION public.owner_logout_everywhere(p_user uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, extensions, pg_temp AS $$
BEGIN
  PERFORM app.require_owner();
  IF p_user = app.current_user_id() THEN RAISE EXCEPTION 'Use Log out for yourself' USING ERRCODE = 'WH005'; END IF;
  PERFORM app.revoke_sessions(p_user);
END$$;

-- Used by the admin Edge Function when a password is reset or a login is disabled / removed.
CREATE FUNCTION public.svc_revoke_sessions(p_user uuid) RETURNS void
LANGUAGE sql SECURITY DEFINER SET search_path = public, extensions, pg_temp AS $$ SELECT app.revoke_sessions(p_user) $$;

CREATE FUNCTION public.owner_save_security_settings(p jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, extensions, pg_temp AS $$
DECLARE cur jsonb := app.setting('security');
BEGIN
  PERFORM app.require_owner();
  IF p ? 'require_device_approval' THEN cur := jsonb_set(cur, '{require_device_approval}', to_jsonb((p->>'require_device_approval')::boolean)); END IF;
  IF p ? 'staff_hours' THEN
    IF (p->'staff_hours'->>'from') !~ '^([01]\d|2[0-3]):[0-5]\d$' OR (p->'staff_hours'->>'to') !~ '^([01]\d|2[0-3]):[0-5]\d$'
       OR (p->'staff_hours'->>'from')::time >= (p->'staff_hours'->>'to')::time THEN
      RAISE EXCEPTION 'Login hours: from must be before to, like 07:00 and 21:00' USING ERRCODE = 'WH005';
    END IF;
    cur := jsonb_set(cur, '{staff_hours}', jsonb_build_object('enabled', coalesce((p->'staff_hours'->>'enabled')::boolean, false),
                                                               'from', p->'staff_hours'->>'from', 'to', p->'staff_hours'->>'to'));
  END IF;
  IF p ? 'staff_idle_minutes' THEN
    IF (p->>'staff_idle_minutes')::int NOT BETWEEN 0 AND 480 THEN RAISE EXCEPTION 'Auto-lock: 0 to 480 minutes' USING ERRCODE = 'WH005'; END IF;
    cur := jsonb_set(cur, '{staff_idle_minutes}', to_jsonb((p->>'staff_idle_minutes')::int));
  END IF;
  IF p ? 'owner_idle_minutes' THEN
    IF (p->>'owner_idle_minutes')::int NOT BETWEEN 0 AND 480 THEN RAISE EXCEPTION 'Auto-lock: 0 to 480 minutes' USING ERRCODE = 'WH005'; END IF;
    cur := jsonb_set(cur, '{owner_idle_minutes}', to_jsonb((p->>'owner_idle_minutes')::int));
  END IF;
  IF p ? 'lock_after_failures' THEN
    IF (p->>'lock_after_failures')::int NOT BETWEEN 3 AND 20 THEN RAISE EXCEPTION 'Lock after 3 to 20 wrong passwords' USING ERRCODE = 'WH005'; END IF;
    cur := jsonb_set(cur, '{lock_after_failures}', to_jsonb((p->>'lock_after_failures')::int));
  END IF;
  UPDATE app_settings SET value = cur, updated_by = app.current_user_id(), updated_at = now() WHERE key = 'security';
  RETURN cur;
END$$;

-- ---------------------------------------------------------------------------
-- Owner recovery codes (shown once; each works once)
-- ---------------------------------------------------------------------------
CREATE FUNCTION public.owner_new_recovery_codes() RETURNS text[]
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, secure, extensions, pg_temp AS $$
DECLARE v_uid uuid := app.current_user_id(); codes text[] := '{}'; c text; i int;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM users WHERE id = v_uid AND role = 'OWNER') THEN
    RAISE EXCEPTION 'Only the owner can create recovery codes' USING ERRCODE = 'WH002';
  END IF;
  DELETE FROM secure.recovery_codes WHERE user_id = v_uid;
  FOR i IN 1..8 LOOP
    c := upper(substr(encode(extensions.gen_random_bytes(8), 'hex'), 1, 4) || '-' || substr(encode(extensions.gen_random_bytes(8), 'hex'), 1, 4));
    INSERT INTO secure.recovery_codes(user_id, code_hash) VALUES (v_uid, extensions.crypt(c, extensions.gen_salt('bf')));
    codes := codes || c;
  END LOOP;
  RETURN codes;
END$$;

CREATE FUNCTION public.owner_recovery_codes_left() RETURNS int
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, secure, extensions, pg_temp AS $$
  SELECT count(*)::int FROM secure.recovery_codes WHERE user_id = app.current_user_id() AND used_at IS NULL
$$;

-- service role only (account Edge Function): checks and burns one code; returns the owner's id.
CREATE FUNCTION public.svc_use_recovery_code(p_login_id text, p_code text) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, secure, extensions, pg_temp AS $$
DECLARE v_uid uuid; v_id bigint;
BEGIN
  SELECT id INTO v_uid FROM users WHERE login_id = lower(btrim(p_login_id))::extensions.citext AND role = 'OWNER' AND is_active;
  IF v_uid IS NULL THEN RETURN NULL; END IF;
  IF app.login_lock_until(p_login_id) > now() THEN RETURN NULL; END IF;
  SELECT id INTO v_id FROM secure.recovery_codes
   WHERE user_id = v_uid AND used_at IS NULL AND code_hash = extensions.crypt(upper(btrim(p_code)), code_hash) LIMIT 1;
  IF v_id IS NULL THEN
    INSERT INTO login_events(user_id, login_id, success, note) VALUES (v_uid, lower(btrim(p_login_id)), false, 'RECOVERY_CODE_WRONG');
    RETURN NULL;
  END IF;
  UPDATE secure.recovery_codes SET used_at = now() WHERE id = v_id;
  INSERT INTO login_events(user_id, login_id, success, note) VALUES (v_uid, lower(btrim(p_login_id)), true, 'RECOVERY_CODE_USED');
  PERFORM app.revoke_sessions(v_uid);
  RETURN v_uid;
END$$;

REVOKE EXECUTE ON FUNCTION app.login_lock_until(text), app.access_state(uuid, text), app.revoke_sessions(uuid) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.svc_revoke_sessions(uuid), public.svc_use_recovery_code(text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.svc_revoke_sessions(uuid), public.svc_use_recovery_code(text, text) TO service_role;
REVOKE EXECUTE ON FUNCTION public.login_precheck(text), public.login_failed(text, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.login_precheck(text), public.login_failed(text, text, text) TO anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.session_start(text, text, text), public.session_check(text, int), public.owner_login_activity(uuid, int),
  public.owner_set_device(uuid, text, text), public.owner_unlock_login(text), public.owner_logout_everywhere(uuid),
  public.owner_save_security_settings(jsonb), public.owner_new_recovery_codes(), public.owner_recovery_codes_left() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.session_start(text, text, text), public.session_check(text, int), public.owner_login_activity(uuid, int),
  public.owner_set_device(uuid, text, text), public.owner_unlock_login(text), public.owner_logout_everywhere(uuid),
  public.owner_save_security_settings(jsonb), public.owner_new_recovery_codes(), public.owner_recovery_codes_left() TO authenticated;

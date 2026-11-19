-- Phone notifications (Web Push) — no extra app, no Meta account, free.
--
-- Each phone/computer that turns notifications on in the installed WH Reg app stores a push
-- subscription here. Every in-app notification (bell) — 09:00 clock-in reminder, 18:30
-- clock-out reminder, the owner's 20:00 summary, approvals, login alerts … — is also pushed
-- to that person's phones by the `push-relay` Edge Function.
--
-- Flow: INSERT INTO notifications → statement trigger pokes push-relay via pg_net (after
-- COMMIT) → push-relay claims unsent rows (push_claim), sends, reports back (push_report).
-- A 2-minute sweep retries if a poke was missed. Rows older than 3 hours are never pushed
-- (a reminder that arrives late is worse than none).
--
-- Needs: Vault secret `push_relay_secret` (= function secret PUSH_RELAY_SECRET), function
-- secrets VAPID_PUBLIC_KEY / VAPID_PRIVATE_JWK / VAPID_SUBJECT, and the public key in
-- app_settings 'push' (so the app can subscribe).

CREATE TABLE push_subscriptions (
  id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id       uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  endpoint      text NOT NULL UNIQUE CHECK (endpoint ~ '^https://'),
  p256dh        text NOT NULL,
  auth          text NOT NULL,
  device        text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  last_ok_at    timestamptz,
  last_error    text,
  failures      int NOT NULL DEFAULT 0
);
CREATE INDEX push_subscriptions_user_idx ON push_subscriptions(user_id);
ALTER TABLE push_subscriptions ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON push_subscriptions FROM PUBLIC, anon, authenticated;

ALTER TABLE notifications ADD COLUMN pushed_at timestamptz;
-- everything that exists today counts as already handled
UPDATE notifications SET pushed_at = created_at WHERE pushed_at IS NULL;
CREATE INDEX notifications_unpushed_idx ON notifications(id) WHERE pushed_at IS NULL;

INSERT INTO app_settings(key, value) VALUES ('push', jsonb_build_object('public_key', NULL))
ON CONFLICT (key) DO NOTHING;

-- ---------------------------------------------------------------- app side (signed-in user)
CREATE FUNCTION public.push_public_key() RETURNS text
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, extensions, pg_temp AS $$
  SELECT app.setting('push')->>'public_key'
$$;

/* p = { endpoint, p256dh, auth, device? } — the same phone signing in as someone else moves to them */
CREATE FUNCTION public.save_push_subscription(p jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, extensions, pg_temp AS $$
DECLARE v_user uuid := app.current_user_id();
BEGIN
  IF v_user IS NULL THEN RAISE EXCEPTION 'Not signed in' USING ERRCODE = 'WH002'; END IF;
  IF coalesce(p->>'endpoint', '') !~ '^https://' OR coalesce(p->>'p256dh', '') = '' OR coalesce(p->>'auth', '') = '' THEN
    RAISE EXCEPTION 'Incomplete notification subscription' USING ERRCODE = 'WH005';
  END IF;
  INSERT INTO push_subscriptions(user_id, endpoint, p256dh, auth, device)
  VALUES (v_user, p->>'endpoint', p->>'p256dh', p->>'auth', left(nullif(trim(p->>'device'), ''), 80))
  ON CONFLICT (endpoint) DO UPDATE SET user_id = EXCLUDED.user_id, p256dh = EXCLUDED.p256dh, auth = EXCLUDED.auth,
                                       device = EXCLUDED.device, failures = 0, last_error = NULL;
  RETURN public.my_push_status();
END$$;

CREATE FUNCTION public.delete_push_subscription(p_endpoint text) RETURNS void
LANGUAGE sql SECURITY DEFINER SET search_path = public, extensions, pg_temp AS $$
  DELETE FROM push_subscriptions WHERE endpoint = p_endpoint AND user_id = app.current_user_id()
$$;

CREATE FUNCTION public.my_push_status() RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, extensions, pg_temp AS $$
  SELECT jsonb_build_object(
    'ready', app.setting('push')->>'public_key' IS NOT NULL,
    'devices', coalesce((SELECT jsonb_agg(jsonb_build_object('endpoint', endpoint, 'device', device, 'since', created_at,
                                                             'last_ok_at', last_ok_at, 'last_error', last_error) ORDER BY created_at DESC)
                           FROM push_subscriptions WHERE user_id = app.current_user_id()), '[]'))
$$;

/* "Send me a test notification" */
CREATE FUNCTION public.send_test_push() RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, extensions, pg_temp AS $$
BEGIN
  IF app.current_user_id() IS NULL THEN RAISE EXCEPTION 'Not signed in' USING ERRCODE = 'WH002'; END IF;
  PERFORM app.notify_user(app.current_user_id(), 'TEST', 'Notifications are on ✓',
    'This phone will get your WH Reg reminders and alerts.', '{}', NULL);
END$$;

/* Owner: who has phone notifications on (Employees / Settings) */
CREATE FUNCTION public.owner_push_overview() RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, extensions, pg_temp AS $$
BEGIN
  PERFORM app.require_owner();
  RETURN coalesce((SELECT jsonb_agg(jsonb_build_object('user_id', u.id, 'name', u.full_name, 'login_id', u.login_id, 'role', u.role,
            'devices', (SELECT count(*) FROM push_subscriptions s WHERE s.user_id = u.id),
            'last_ok_at', (SELECT max(last_ok_at) FROM push_subscriptions s WHERE s.user_id = u.id))
           ORDER BY u.role DESC, u.full_name)
    FROM users u WHERE u.is_active AND u.removed_at IS NULL), '[]');
END$$;

-- ---------------------------------------------------------------- relay side (service role only)
/* Claims up to p_limit unsent notifications (marks them pushed) and returns what to send. */
CREATE FUNCTION public.push_claim(p_limit int DEFAULT 200) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, extensions, pg_temp AS $$
DECLARE v jsonb;
BEGIN
  WITH c AS (
    SELECT n.id FROM notifications n
     WHERE n.pushed_at IS NULL ORDER BY n.id LIMIT p_limit FOR UPDATE SKIP LOCKED),
  upd AS (
    UPDATE notifications n SET pushed_at = now() FROM c WHERE n.id = c.id
    RETURNING n.id, n.user_id, n.kind, n.title, n.body, n.created_at)
  SELECT coalesce(jsonb_agg(jsonb_build_object(
           'id', upd.id, 'kind', upd.kind, 'title', upd.title, 'body', upd.body,
           'subs', (SELECT coalesce(jsonb_agg(jsonb_build_object('id', s.id, 'endpoint', s.endpoint, 'p256dh', s.p256dh, 'auth', s.auth)), '[]')
                      FROM push_subscriptions s JOIN users u ON u.id = s.user_id AND u.is_active AND u.removed_at IS NULL
                     WHERE s.user_id = upd.user_id))), '[]')
    INTO v
    FROM upd
   WHERE upd.created_at > now() - interval '3 hours'
     AND EXISTS (SELECT 1 FROM push_subscriptions s WHERE s.user_id = upd.user_id);
  RETURN v;
END$$;

/* p = [{ subId, ok, gone, error }] */
CREATE FUNCTION public.push_report(p jsonb) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, extensions, pg_temp AS $$
BEGIN
  DELETE FROM push_subscriptions s USING jsonb_array_elements(coalesce(p, '[]')) e
   WHERE s.id = (e->>'subId')::bigint AND (e->>'gone')::boolean;
  UPDATE push_subscriptions s SET last_ok_at = now(), failures = 0, last_error = NULL
    FROM jsonb_array_elements(coalesce(p, '[]')) e
   WHERE s.id = (e->>'subId')::bigint AND (e->>'ok')::boolean;
  UPDATE push_subscriptions s SET failures = s.failures + 1, last_error = left(e->>'error', 300)
    FROM jsonb_array_elements(coalesce(p, '[]')) e
   WHERE s.id = (e->>'subId')::bigint AND NOT (e->>'ok')::boolean AND NOT (e->>'gone')::boolean;
  DELETE FROM push_subscriptions WHERE failures >= 20;            -- dead for weeks
END$$;

-- ---------------------------------------------------------------- poke the relay
CREATE FUNCTION app.invoke_push_relay() RETURNS bigint
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, extensions, pg_temp AS $$
DECLARE v_url text; v_secret text; v_req bigint;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM push_subscriptions) THEN RETURN NULL; END IF;
  EXECUTE $q$SELECT max(decrypted_secret) FILTER (WHERE name = 'project_url'),
                    max(decrypted_secret) FILTER (WHERE name = 'push_relay_secret')
               FROM vault.decrypted_secrets$q$ INTO v_url, v_secret;
  IF v_url IS NULL OR v_secret IS NULL THEN RETURN NULL; END IF;
  EXECUTE $q$SELECT net.http_post(url := $1, headers := $2, body := '{}'::jsonb, timeout_milliseconds := 10000)$q$
     INTO v_req
    USING rtrim(v_url, '/') || '/functions/v1/push-relay',
          jsonb_build_object('Content-Type', 'application/json', 'x-relay-secret', v_secret);
  RETURN v_req;
EXCEPTION WHEN undefined_table OR undefined_function OR invalid_schema_name THEN
  RETURN NULL;
END$$;

CREATE FUNCTION app.notifications_after_insert() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, extensions, pg_temp AS $$
BEGIN
  PERFORM app.invoke_push_relay();
  RETURN NULL;
END$$;
CREATE TRIGGER notifications_push AFTER INSERT ON notifications
  FOR EACH STATEMENT EXECUTE FUNCTION app.notifications_after_insert();

CREATE FUNCTION app.push_if_pending() RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, extensions, pg_temp AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM notifications n WHERE n.pushed_at IS NULL AND n.created_at < now() - interval '1 minute') THEN
    PERFORM app.invoke_push_relay();
  END IF;
END$$;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_cron') THEN
    PERFORM cron.schedule('whreg-push-retry', '*/2 * * * *', 'SELECT app.push_if_pending()');
  END IF;
END$$;

REVOKE EXECUTE ON FUNCTION app.invoke_push_relay(), app.notifications_after_insert(), app.push_if_pending() FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.push_claim(int), public.push_report(jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.push_claim(int), public.push_report(jsonb) TO service_role;
REVOKE EXECUTE ON FUNCTION public.push_public_key(), public.save_push_subscription(jsonb), public.delete_push_subscription(text),
  public.my_push_status(), public.send_test_push(), public.owner_push_overview() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.push_public_key(), public.save_push_subscription(jsonb), public.delete_push_subscription(text),
  public.my_push_status(), public.send_test_push(), public.owner_push_overview() TO authenticated;

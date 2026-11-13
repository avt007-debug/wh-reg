-- WhatsApp + in-app reminders and the owner's daily summary.
--   • 09:00 IST  clock-in reminder  → every active employee not yet clocked in today
--   • 18:30 IST  clock-out reminder → every employee still clocked in
--   • 20:00 IST  owner daily summary → sales (count, value, to whom), purchases (from whom),
--                attendance, market runs, payments collected
-- Times, working days and on/off are owner settings. A 5-minute pg_cron job decides what is due;
-- each message is queued once per day (dedupe key). Every message is ALSO stored as an in-app
-- notification, so it works before WhatsApp (Meta) is connected.

-- ---------------------------------------------------------------------------
-- Settings (single row per key)
-- ---------------------------------------------------------------------------
CREATE TABLE app_settings (
  key         text PRIMARY KEY,
  value       jsonb NOT NULL,
  updated_by  uuid REFERENCES users(id),
  updated_at  timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE app_settings ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON app_settings FROM PUBLIC, anon, authenticated;

INSERT INTO app_settings(key, value) VALUES ('notifications', jsonb_build_object(
  'clock_in',  jsonb_build_object('enabled', true, 'time', '09:00'),
  'clock_out', jsonb_build_object('enabled', true, 'time', '18:30'),
  'summary',   jsonb_build_object('enabled', true, 'time', '20:00'),
  'work_days', jsonb_build_array(1, 2, 3, 4, 5, 6),          -- ISO: 1 = Monday … 7 = Sunday
  'summary_every_day', true,
  'owner_numbers', '[]'::jsonb                                -- extra numbers; owners' own phones are always included
)) ON CONFLICT (key) DO NOTHING;

CREATE FUNCTION app.setting(p_key text) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, extensions, pg_temp AS $$
  SELECT value FROM app_settings WHERE key = p_key
$$;

-- ---------------------------------------------------------------------------
-- In-app notifications (bell)
-- ---------------------------------------------------------------------------
CREATE TABLE notifications (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id     uuid NOT NULL REFERENCES users(id),
  kind        text NOT NULL,
  title       text NOT NULL,
  body        text NOT NULL,
  data        jsonb NOT NULL DEFAULT '{}',
  dedupe_key  text UNIQUE,
  created_at  timestamptz NOT NULL DEFAULT now(),
  read_at     timestamptz
);
CREATE INDEX notifications_user_idx ON notifications(user_id, id DESC);
ALTER TABLE notifications ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON notifications FROM PUBLIC, anon, authenticated;

CREATE FUNCTION app.notify_user(p_user uuid, p_kind text, p_title text, p_body text, p_data jsonb DEFAULT '{}', p_dedupe text DEFAULT NULL)
RETURNS void LANGUAGE sql SECURITY DEFINER SET search_path = public, extensions, pg_temp AS $$
  INSERT INTO notifications(user_id, kind, title, body, data, dedupe_key)
  VALUES (p_user, p_kind, p_title, p_body, coalesce(p_data, '{}'), p_dedupe)
  ON CONFLICT (dedupe_key) DO NOTHING
$$;

CREATE FUNCTION app.notify_owners(p_kind text, p_title text, p_body text, p_data jsonb DEFAULT '{}', p_dedupe text DEFAULT NULL)
RETURNS void LANGUAGE sql SECURITY DEFINER SET search_path = public, extensions, pg_temp AS $$
  SELECT app.notify_user(u.id, p_kind, p_title, p_body, p_data, CASE WHEN p_dedupe IS NULL THEN NULL ELSE p_dedupe || ':' || u.id END)
    FROM users u WHERE u.role IN ('OWNER', 'ADMIN') AND u.is_active AND u.removed_at IS NULL
$$;

CREATE FUNCTION public.my_notifications(p_limit int DEFAULT 50) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, extensions, pg_temp AS $$
DECLARE v_uid uuid := app.require_user();
BEGIN
  RETURN jsonb_build_object(
    'unread', (SELECT count(*) FROM notifications WHERE user_id = v_uid AND read_at IS NULL),
    'items', (SELECT coalesce(jsonb_agg(to_jsonb(n) - 'user_id' - 'dedupe_key' ORDER BY n.id DESC), '[]')
                FROM (SELECT * FROM notifications WHERE user_id = v_uid ORDER BY id DESC LIMIT least(p_limit, 200)) n));
END$$;

CREATE FUNCTION public.mark_notifications_read(p_ids bigint[] DEFAULT NULL) RETURNS int
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, extensions, pg_temp AS $$
DECLARE v_uid uuid := app.require_user(); v_n int;
BEGIN
  UPDATE notifications SET read_at = now()
   WHERE user_id = v_uid AND read_at IS NULL AND (p_ids IS NULL OR id = ANY (p_ids));
  GET DIAGNOSTICS v_n = ROW_COUNT;
  RETURN v_n;
END$$;

-- ---------------------------------------------------------------------------
-- WhatsApp: generic template messages through the existing outbox + relay
-- ---------------------------------------------------------------------------
ALTER TABLE notification_outbox DROP CONSTRAINT notification_outbox_event_type_check;
ALTER TABLE notification_outbox ADD CONSTRAINT notification_outbox_event_type_check
  CHECK (event_type IN ('DISPATCH_ALERT', 'EOD_DIGEST', 'LOW_STOCK', 'WA_TEMPLATE'));

-- Indian mobile → WhatsApp number (91XXXXXXXXXX); NULL if unusable.
CREATE FUNCTION app.wa_number(p text) RETURNS text
LANGUAGE sql IMMUTABLE SET search_path = public, extensions, pg_temp AS $$
  SELECT CASE WHEN length(d) = 10 AND d ~ '^[6-9]' THEN '91' || d
              WHEN length(d) = 12 AND d LIKE '91%' THEN d
              WHEN length(d) BETWEEN 11 AND 15 AND p ~ '^\s*\+' THEN d END
    FROM (SELECT regexp_replace(coalesce(p, ''), '\D', '', 'g') AS d) x
$$;

-- WhatsApp template values may not contain newlines/tabs/long spaces and must stay short.
CREATE FUNCTION app.wa_text(p text, p_max int DEFAULT 200) RETURNS text
LANGUAGE sql IMMUTABLE SET search_path = public, extensions, pg_temp AS $$
  SELECT CASE WHEN v = '' THEN '-' WHEN length(v) > p_max THEN left(v, p_max - 1) || '…' ELSE v END
    FROM (SELECT btrim(regexp_replace(coalesce(p, ''), '\s+', ' ', 'g')) AS v) x
$$;

-- Join list items until the length budget is used, then "+N more".
CREATE FUNCTION app.wa_list(p_items text[], p_max int DEFAULT 200) RETURNS text
LANGUAGE plpgsql IMMUTABLE SET search_path = public, extensions, pg_temp AS $$
DECLARE v text := ''; i int; n int := coalesce(array_length(p_items, 1), 0); part text;
BEGIN
  IF n = 0 THEN RETURN 'None'; END IF;
  FOR i IN 1..n LOOP
    part := p_items[i];
    IF length(v) + length(part) + 2 > p_max - (CASE WHEN i < n THEN 10 ELSE 0 END) THEN
      RETURN v || CASE WHEN v = '' THEN '' ELSE '; ' END || '+' || (n - i + 1) || ' more';
    END IF;
    v := v || CASE WHEN v = '' THEN '' ELSE '; ' END || part;
  END LOOP;
  RETURN v;
END$$;

CREATE FUNCTION app.inr(p numeric) RETURNS text
LANGUAGE sql IMMUTABLE SET search_path = public, extensions, pg_temp AS $$
  -- Indian grouping: 12,34,567
  SELECT '₹' || CASE WHEN length(i) <= 3 THEN i
         ELSE regexp_replace(left(i, length(i) - 3), '(\d)(?=(\d\d)+$)', '\1,', 'g') || ',' || right(i, 3) END
    FROM (SELECT round(coalesce(p, 0))::bigint::text AS i) x
$$;

CREATE FUNCTION app.queue_whatsapp(p_dedupe text, p_numbers text[], p_template text, p_params text[], p_kind text, p_user uuid DEFAULT NULL)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, extensions, pg_temp AS $$
DECLARE v_to text[];
BEGIN
  SELECT array_agg(DISTINCT n) INTO v_to FROM unnest(p_numbers) n WHERE n IS NOT NULL;
  IF v_to IS NULL THEN RETURN false; END IF;
  INSERT INTO notification_outbox(event_type, dedupe_key, aggregate_id, payload)
  VALUES ('WA_TEMPLATE', p_dedupe, p_user,
          jsonb_build_object('kind', p_kind, 'to', to_jsonb(v_to), 'template', p_template, 'params', to_jsonb(p_params)))
  ON CONFLICT (dedupe_key) DO NOTHING;
  RETURN FOUND;
END$$;

CREATE FUNCTION public.wa_owner_numbers() RETURNS text[]
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, extensions, pg_temp AS $$
  SELECT array_agg(DISTINCT n) FROM (
    SELECT app.wa_number(phone) AS n FROM users WHERE role IN ('OWNER', 'ADMIN') AND is_active AND removed_at IS NULL
    UNION ALL
    SELECT app.wa_number(x) FROM jsonb_array_elements_text(coalesce(app.setting('notifications')->'owner_numbers', '[]')) x) z
   WHERE n IS NOT NULL
$$;

-- ---------------------------------------------------------------------------
-- Owner daily report (also the in-app "Daily report" page)
-- ---------------------------------------------------------------------------
CREATE FUNCTION app.daily_report(p_date date) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, fin, extensions, pg_temp AS $$
  SELECT jsonb_build_object(
    'date', p_date,
    'sales', (SELECT jsonb_build_object(
        'count', count(*), 'taxable', coalesce(sum(taxable_total), 0), 'total', coalesce(sum(grand_total), 0),
        'by_customer', coalesce((SELECT jsonb_agg(jsonb_build_object('name', c, 'bills', n, 'total', t, 'warehouses', whs) ORDER BY t DESC)
                                   FROM (SELECT d2.customer_name AS c, count(*) AS n, sum(d2.grand_total) AS t,
                                                string_agg(DISTINCT w2.code, '/') AS whs
                                           FROM dispatches d2 JOIN warehouses w2 ON w2.id = d2.warehouse_id
                                          WHERE d2.status = 'POSTED' AND d2.invoice_date = p_date GROUP BY 1) z), '[]'),
        'by_warehouse', coalesce((SELECT jsonb_agg(jsonb_build_object('code', code, 'name', name, 'bills', n, 'total', t) ORDER BY code)
                                    FROM (SELECT w3.code, w3.name, count(d3.id) AS n, coalesce(sum(d3.grand_total), 0) AS t
                                            FROM warehouses w3 LEFT JOIN dispatches d3 ON d3.warehouse_id = w3.id AND d3.status = 'POSTED' AND d3.invoice_date = p_date
                                           WHERE w3.is_active GROUP BY 1, 2) y), '[]'))
        FROM dispatches WHERE status = 'POSTED' AND invoice_date = p_date),
    'purchases', (SELECT jsonb_build_object(
        'count', count(*), 'total', coalesce(sum(grand_total), 0),
        'pending', count(*) FILTER (WHERE status = 'PENDING'),
        'by_vendor', coalesce((SELECT jsonb_agg(jsonb_build_object('name', v, 'bills', n, 'total', t, 'pending', pn) ORDER BY t DESC)
                                 FROM (SELECT p2.vendor_name AS v, count(*) AS n, sum(p2.grand_total) AS t,
                                              count(*) FILTER (WHERE p2.status = 'PENDING') AS pn
                                         FROM purchases p2 WHERE p2.status IN ('POSTED', 'PENDING')
                                          AND (p2.created_at AT TIME ZONE 'Asia/Kolkata')::date = p_date GROUP BY 1) z), '[]'))
        FROM purchases WHERE status IN ('POSTED', 'PENDING') AND (created_at AT TIME ZONE 'Asia/Kolkata')::date = p_date),
    'payments', (SELECT jsonb_build_object('count', count(*), 'total', coalesce(sum(amount), 0))
                   FROM fin.customer_payments WHERE paid_on = p_date),
    'attendance', (SELECT coalesce(jsonb_agg(jsonb_build_object(
          'name', u.full_name, 'warehouse', w.code,
          'first_in', a.first_in, 'last_out', a.last_out, 'open', coalesce(a.open, false), 'hours', coalesce(a.hours, 0)) ORDER BY u.full_name), '[]')
        FROM users u LEFT JOIN warehouses w ON w.id = u.primary_warehouse_id
        LEFT JOIN LATERAL (
          SELECT min(clock_in_at) AS first_in,
                 CASE WHEN bool_or(clock_out_at IS NULL) THEN NULL ELSE max(clock_out_at) END AS last_out,
                 bool_or(clock_out_at IS NULL) AS open,
                 round(sum(extract(epoch FROM (coalesce(clock_out_at, CASE WHEN work_date = app.today_ist() THEN now() END) - clock_in_at))) / 3600.0, 1) AS hours
            FROM attendance WHERE user_id = u.id AND work_date = p_date) a ON true
       WHERE u.role = 'EMPLOYEE' AND u.is_active AND u.removed_at IS NULL),
    'market_runs', (SELECT coalesce(jsonb_agg(jsonb_build_object('name', u.full_name, 'places', r.places, 'runs', r.runs,
                          'approached', coalesce(v.n, 0), 'orders', coalesce(v.orders, 0)) ORDER BY u.full_name), '[]')
        FROM users u
        JOIN (SELECT user_id, count(*) AS runs, string_agg(DISTINCT place, ', ') AS places FROM market_runs WHERE run_date = p_date GROUP BY 1) r ON r.user_id = u.id
        LEFT JOIN (SELECT user_id, count(*) AS n, count(*) FILTER (WHERE outcome = 'ORDER') AS orders
                     FROM customer_visits WHERE visit_date = p_date GROUP BY 1) v ON v.user_id = u.id)
  )
$$;

CREATE FUNCTION public.owner_daily_report(p_date date DEFAULT NULL) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, extensions, pg_temp AS $$
BEGIN
  PERFORM app.require_owner();
  RETURN app.daily_report(coalesce(p_date, app.today_ist()));
END$$;

-- The 5 values of the `daily_owner_summary` WhatsApp template (≈ 900 characters in total).
CREATE FUNCTION app.daily_summary_params(r jsonb) RETURNS text[]
LANGUAGE sql STABLE SET search_path = public, extensions, pg_temp AS $$
  SELECT ARRAY[
    to_char((r->>'date')::date, 'DD Mon YYYY (Dy)'),
    app.wa_text((r->'sales'->>'count') || ' bills, ' || app.inr((r->'sales'->>'total')::numeric) || ' incl. GST. To: ' ||
      app.wa_list(ARRAY(SELECT (x->>'name') || ' ' || app.inr((x->>'total')::numeric) || CASE WHEN (x->>'bills')::int > 1 THEN ' (' || (x->>'bills') || ' bills)' ELSE '' END
                          FROM jsonb_array_elements(r->'sales'->'by_customer') x), 190)
      || '. Payments received: ' || app.inr((r->'payments'->>'total')::numeric), 280),
    app.wa_text((r->'purchases'->>'count') || ' bills, ' || app.inr((r->'purchases'->>'total')::numeric) || '. From: ' ||
      app.wa_list(ARRAY(SELECT (x->>'name') || ' ' || app.inr((x->>'total')::numeric) || CASE WHEN (x->>'pending')::int > 0 THEN ' (awaiting approval)' ELSE '' END
                          FROM jsonb_array_elements(r->'purchases'->'by_vendor') x), 170), 210),
    app.wa_text(app.wa_list(ARRAY(SELECT (x->>'name') || ' ' ||
        CASE WHEN x->>'first_in' IS NULL THEN 'absent'
             ELSE to_char((x->>'first_in')::timestamptz AT TIME ZONE 'Asia/Kolkata', 'HH12:MI AM') || '-' ||
                  CASE WHEN (x->>'open')::boolean THEN 'not clocked out' ELSE to_char((x->>'last_out')::timestamptz AT TIME ZONE 'Asia/Kolkata', 'HH12:MI AM') END ||
                  ' (' || (x->>'hours') || 'h)' END
        FROM jsonb_array_elements(r->'attendance') x), 210), 220),
    app.wa_text(app.wa_list(ARRAY(SELECT (x->>'name') || ': ' || (x->>'places') || ', ' || (x->>'approached') || ' customers, ' || (x->>'orders') || ' orders'
        FROM jsonb_array_elements(r->'market_runs') x), 180), 190)
  ]
$$;

-- Leave days (used by reminders now; requests/approval screens come with the employee add-ins)
CREATE TABLE leave_days (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid NOT NULL REFERENCES users(id),
  leave_date  date NOT NULL,
  reason      text,
  status      text NOT NULL DEFAULT 'REQUESTED' CHECK (status IN ('REQUESTED', 'APPROVED', 'REJECTED', 'CANCELLED')),
  decided_by  uuid REFERENCES users(id),
  decided_at  timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, leave_date)
);
ALTER TABLE leave_days ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON leave_days FROM PUBLIC, anon, authenticated;


-- ---------------------------------------------------------------------------
-- Scheduler: runs every 5 minutes; each job fires once per day after its time
-- (catch-up window 3 hours, so a short outage does not lose the message).
-- ---------------------------------------------------------------------------
CREATE FUNCTION app.run_schedules(p_now timestamptz DEFAULT now()) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, fin, extensions, pg_temp AS $$
DECLARE
  s jsonb := app.setting('notifications');
  v_local timestamp := p_now AT TIME ZONE 'Asia/Kolkata';
  v_date date := v_local::date;
  v_time time := v_local::time;
  v_dow int := extract(isodow FROM v_local)::int;
  v_workday boolean := (s->'work_days') @> to_jsonb(v_dow);
  v_done jsonb := '[]';
  u record; r jsonb; v_first text;
  FUNCTION_DUE CONSTANT interval := interval '3 hours';
BEGIN
  IF s IS NULL THEN RETURN v_done; END IF;

  -- 1. Clock-in reminder
  IF (s->'clock_in'->>'enabled')::boolean AND v_workday
     AND v_time >= (s->'clock_in'->>'time')::time AND v_time < (s->'clock_in'->>'time')::time + FUNCTION_DUE THEN
    FOR u IN SELECT us.id, us.full_name, us.phone FROM users us
              WHERE us.role = 'EMPLOYEE' AND us.is_active AND us.removed_at IS NULL
                AND NOT EXISTS (SELECT 1 FROM attendance a WHERE a.user_id = us.id AND a.work_date = v_date)
                AND NOT EXISTS (SELECT 1 FROM leave_days l WHERE l.user_id = us.id AND l.leave_date = v_date AND l.status = 'APPROVED') LOOP
      v_first := split_part(u.full_name, ' ', 1);
      PERFORM app.notify_user(u.id, 'CLOCK_IN_REMINDER', 'Time to clock in',
        'Good morning ' || v_first || '. Please clock in for today in the app.', '{}', 'clockin:' || v_date || ':' || u.id);
      PERFORM app.queue_whatsapp('wa:clockin:' || v_date || ':' || u.id, ARRAY[app.wa_number(u.phone)], 'clock_in_reminder',
        ARRAY[app.wa_text(v_first, 40), to_char(v_date, 'DD Mon YYYY')], 'CLOCK_IN_REMINDER', u.id);
    END LOOP;
    v_done := v_done || '"clock_in"';
  END IF;

  -- 2. Clock-out reminder (only people still clocked in)
  IF (s->'clock_out'->>'enabled')::boolean AND v_workday
     AND v_time >= (s->'clock_out'->>'time')::time AND v_time < (s->'clock_out'->>'time')::time + FUNCTION_DUE THEN
    FOR u IN SELECT us.id, us.full_name, us.phone, a.clock_in_at FROM users us
               JOIN attendance a ON a.user_id = us.id AND a.clock_out_at IS NULL
              WHERE us.role = 'EMPLOYEE' AND us.is_active AND us.removed_at IS NULL LOOP
      v_first := split_part(u.full_name, ' ', 1);
      PERFORM app.notify_user(u.id, 'CLOCK_OUT_REMINDER', 'Remember to clock out',
        'You are clocked in since ' || to_char(u.clock_in_at AT TIME ZONE 'Asia/Kolkata', 'HH12:MI AM') || '. Clock out before leaving.',
        '{}', 'clockout:' || v_date || ':' || u.id);
      PERFORM app.queue_whatsapp('wa:clockout:' || v_date || ':' || u.id, ARRAY[app.wa_number(u.phone)], 'clock_out_reminder',
        ARRAY[app.wa_text(v_first, 40), to_char(u.clock_in_at AT TIME ZONE 'Asia/Kolkata', 'HH12:MI AM')], 'CLOCK_OUT_REMINDER', u.id);
    END LOOP;
    v_done := v_done || '"clock_out"';
  END IF;

  -- 3. Owner daily summary
  IF (s->'summary'->>'enabled')::boolean AND (coalesce((s->>'summary_every_day')::boolean, true) OR v_workday)
     AND v_time >= (s->'summary'->>'time')::time AND v_time < (s->'summary'->>'time')::time + FUNCTION_DUE
     AND NOT EXISTS (SELECT 1 FROM notifications WHERE dedupe_key LIKE 'summary:' || v_date || ':%') THEN
    r := app.daily_report(v_date);
    PERFORM app.notify_owners('DAILY_SUMMARY', 'Daily summary · ' || to_char(v_date, 'DD Mon'),
      (r->'sales'->>'count') || ' sales ' || app.inr((r->'sales'->>'total')::numeric) || ' · ' ||
      (r->'purchases'->>'count') || ' purchases ' || app.inr((r->'purchases'->>'total')::numeric) || ' · ' ||
      (SELECT count(*) FROM jsonb_array_elements(r->'attendance') x WHERE x->>'first_in' IS NOT NULL) || '/' ||
      jsonb_array_length(r->'attendance') || ' present',
      jsonb_build_object('date', v_date), 'summary:' || v_date);
    PERFORM app.queue_whatsapp('wa:summary:' || v_date, public.wa_owner_numbers(), 'daily_owner_summary',
      app.daily_summary_params(r), 'DAILY_SUMMARY', NULL);
    v_done := v_done || '"summary"';
  END IF;
  RETURN v_done;
END$$;

-- ---------------------------------------------------------------------------
-- Owner settings for the above
-- ---------------------------------------------------------------------------
CREATE FUNCTION public.owner_notification_settings() RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, extensions, pg_temp AS $$
BEGIN
  PERFORM app.require_owner();
  RETURN app.setting('notifications') || jsonb_build_object(
    'resolved_owner_numbers', to_jsonb(coalesce(public.wa_owner_numbers(), '{}')),
    'employees_without_phone', (SELECT coalesce(jsonb_agg(full_name ORDER BY full_name), '[]') FROM users
                                  WHERE role = 'EMPLOYEE' AND is_active AND removed_at IS NULL AND app.wa_number(phone) IS NULL),
    'whatsapp_connected', EXISTS (SELECT 1 FROM notification_outbox WHERE status IN ('SENT', 'DELIVERED') AND sent_at > now() - interval '7 days'
                                    AND coalesce(provider_message_id, '') NOT LIKE 'dry-run-%'));
END$$;

CREATE FUNCTION public.owner_save_notification_settings(p jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, extensions, pg_temp AS $$
DECLARE cur jsonb := app.setting('notifications'); k text;
BEGIN
  PERFORM app.require_owner();
  FOREACH k IN ARRAY ARRAY['clock_in', 'clock_out', 'summary'] LOOP
    IF p ? k THEN
      IF (p->k->>'time') !~ '^([01][0-9]|2[0-3]):[0-5][0-9]$' THEN
        RAISE EXCEPTION 'Time must look like 09:00 or 18:30' USING ERRCODE = 'WH005';
      END IF;
      cur := jsonb_set(cur, ARRAY[k], jsonb_build_object('enabled', coalesce((p->k->>'enabled')::boolean, true), 'time', p->k->>'time'));
    END IF;
  END LOOP;
  IF p ? 'work_days' THEN
    IF EXISTS (SELECT 1 FROM jsonb_array_elements_text(p->'work_days') d WHERE d !~ '^[1-7]$') THEN
      RAISE EXCEPTION 'Working days must be 1 (Mon) to 7 (Sun)' USING ERRCODE = 'WH005';
    END IF;
    cur := jsonb_set(cur, '{work_days}', p->'work_days');
  END IF;
  IF p ? 'summary_every_day' THEN cur := jsonb_set(cur, '{summary_every_day}', to_jsonb(coalesce((p->>'summary_every_day')::boolean, true))); END IF;
  IF p ? 'owner_numbers' THEN
    IF EXISTS (SELECT 1 FROM jsonb_array_elements_text(p->'owner_numbers') x WHERE app.wa_number(x) IS NULL) THEN
      RAISE EXCEPTION 'Each extra number must be a 10-digit Indian mobile number' USING ERRCODE = 'WH005';
    END IF;
    cur := jsonb_set(cur, '{owner_numbers}', p->'owner_numbers');
  END IF;
  UPDATE app_settings SET value = cur, updated_by = app.current_user_id(), updated_at = now() WHERE key = 'notifications';
  RETURN public.owner_notification_settings();
END$$;

-- Owner can send today's summary right now (e.g. to test WhatsApp).
CREATE FUNCTION public.owner_send_summary_now() RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, extensions, pg_temp AS $$
DECLARE r jsonb; v_key text := 'wa:summary-manual:' || to_char(now(), 'YYYYMMDDHH24MISS');
BEGIN
  PERFORM app.require_owner();
  r := app.daily_report(app.today_ist());
  RETURN jsonb_build_object('queued', app.queue_whatsapp(v_key, public.wa_owner_numbers(), 'daily_owner_summary', app.daily_summary_params(r), 'DAILY_SUMMARY'),
                            'params', to_jsonb(app.daily_summary_params(r)));
END$$;

-- Outbox list for the owner shows what each message is.
CREATE OR REPLACE FUNCTION public.owner_notifications(p_limit int DEFAULT 50) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, extensions, pg_temp AS $$
BEGIN
  PERFORM app.require_owner();
  RETURN (SELECT coalesce(jsonb_agg(row_to_json(t)::jsonb ORDER BY t.id DESC), '[]') FROM (
    SELECT o.id, o.event_type, o.dedupe_key, o.status, o.attempts, o.last_error, o.created_at, o.sent_at, o.delivered_at,
           o.payload->>'kind' AS kind, o.payload->'to' AS sent_to_numbers, u.full_name AS person
      FROM notification_outbox o LEFT JOIN users u ON u.id = o.aggregate_id AND o.event_type = 'WA_TEMPLATE'
     ORDER BY o.id DESC LIMIT least(p_limit, 200)) t);
END$$;

-- ---------------------------------------------------------------------------
-- Cron: replace the old 20:30 digest with the 5-minute scheduler
-- ---------------------------------------------------------------------------
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_cron') THEN
    BEGIN PERFORM cron.unschedule('whreg-eod-digest'); EXCEPTION WHEN OTHERS THEN NULL; END;
    PERFORM cron.schedule('whreg-schedules', '*/5 * * * *', 'SELECT app.run_schedules()');
  END IF;
END$$;

REVOKE EXECUTE ON FUNCTION app.wa_number(text), app.wa_text(text, int), app.wa_list(text[], int), app.inr(numeric), app.setting(text), app.notify_user(uuid, text, text, text, jsonb, text), app.notify_owners(text, text, text, jsonb, text),
  app.queue_whatsapp(text, text[], text, text[], text, uuid), app.daily_report(date), app.daily_summary_params(jsonb), app.run_schedules(timestamptz),
  public.wa_owner_numbers() FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.my_notifications(int), public.mark_notifications_read(bigint[]), public.owner_daily_report(date),
  public.owner_notification_settings(), public.owner_save_notification_settings(jsonb), public.owner_send_summary_now() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.my_notifications(int), public.mark_notifications_read(bigint[]), public.owner_daily_report(date),
  public.owner_notification_settings(), public.owner_save_notification_settings(jsonb), public.owner_send_summary_now() TO authenticated;

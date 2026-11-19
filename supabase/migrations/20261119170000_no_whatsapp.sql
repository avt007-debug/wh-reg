-- WhatsApp switched off (owner's decision, 19-Nov-2026). Everything goes to the phone as a
-- notification from the installed app (web push) and to the app's bell:
--   • 09:00 clock-in / 18:30 clock-out reminders → employees
--   • 20:00 daily summary → owner (and Manager)
-- The WhatsApp code stays in place but nothing is queued for it while app_settings
-- 'whatsapp'.enabled is false.

INSERT INTO app_settings(key, value) VALUES ('whatsapp', '{"enabled": false}')
ON CONFLICT (key) DO UPDATE SET value = '{"enabled": false}', updated_at = now();

-- one switch for every WhatsApp message (sale alerts, 8:30 digest, reminders, summary)
CREATE FUNCTION app.outbox_whatsapp_gate() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, extensions, pg_temp AS $$
BEGIN
  IF coalesce((app.setting('whatsapp')->>'enabled')::boolean, false) THEN RETURN NEW; END IF;
  RETURN NULL;                                   -- WhatsApp is off: drop silently
END$$;
CREATE TRIGGER notification_outbox_gate BEFORE INSERT ON notification_outbox
  FOR EACH ROW EXECUTE FUNCTION app.outbox_whatsapp_gate();

UPDATE notification_outbox SET status = 'DEAD', last_error = 'WhatsApp switched off — sent as phone notifications instead'
 WHERE status IN ('PENDING', 'FAILED', 'SENDING');

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_cron') THEN
    BEGIN PERFORM cron.unschedule('whreg-whatsapp-retry'); EXCEPTION WHEN OTHERS THEN NULL; END;
    BEGIN PERFORM cron.unschedule('whreg-eod-digest');     EXCEPTION WHEN OTHERS THEN NULL; END;
  END IF;
END$$;

-- ---------------------------------------------------------------- the summary notification text
-- Short enough for a phone notification, but with everything the owner checks at night:
-- "Sales 4 bills ₹1,25,400 · Collected ₹30,000 · Purchases 1 ₹2,10,000 (1 to approve) ·
--  Present 3/6 · Market runs 2 · Top: Sri Hardware ₹62,000"
CREATE FUNCTION app.summary_text(r jsonb) RETURNS text
LANGUAGE sql STABLE SET search_path = public, extensions, pg_temp AS $$
  SELECT concat_ws(' · ',
    'Sales ' || coalesce(r->'sales'->>'count', '0') || ' bill' || CASE WHEN (r->'sales'->>'count') = '1' THEN '' ELSE 's' END
      || ' ' || app.inr(coalesce((r->'sales'->>'total')::numeric, 0)),
    'Collected ' || app.inr(coalesce((r->'payments'->>'total')::numeric, 0)),
    'Purchases ' || coalesce(r->'purchases'->>'count', '0') || ' ' || app.inr(coalesce((r->'purchases'->>'total')::numeric, 0))
      || CASE WHEN coalesce((r->'purchases'->>'pending')::int, 0) > 0 THEN ' (' || (r->'purchases'->>'pending') || ' to approve)' ELSE '' END,
    'Present ' || (SELECT count(*) FROM jsonb_array_elements(coalesce(r->'attendance', '[]')) x WHERE x->>'first_in' IS NOT NULL)
      || '/' || jsonb_array_length(coalesce(r->'attendance', '[]')),
    CASE WHEN jsonb_array_length(coalesce(r->'market_runs', '[]')) > 0 THEN
      'Market runs ' || (SELECT coalesce(sum((x->>'runs')::int), 0) FROM jsonb_array_elements(r->'market_runs') x) END,
    (SELECT 'Top: ' || (x->>'name') || ' ' || app.inr((x->>'total')::numeric)
       FROM jsonb_array_elements(coalesce(r->'sales'->'by_customer', '[]')) x ORDER BY (x->>'total')::numeric DESC LIMIT 1))
$$;
REVOKE EXECUTE ON FUNCTION app.summary_text(jsonb), app.outbox_whatsapp_gate() FROM PUBLIC, anon, authenticated;

DO $$
DECLARE def text := pg_get_functiondef('app.run_schedules(timestamptz)'::regprocedure);
  old text := $o$(r->'sales'->>'count') || ' sales ' || app.inr((r->'sales'->>'total')::numeric) || ' · ' ||
      (r->'purchases'->>'count') || ' purchases ' || app.inr((r->'purchases'->>'total')::numeric) || ' · ' ||
      (SELECT count(*) FROM jsonb_array_elements(r->'attendance') x WHERE x->>'first_in' IS NOT NULL) || '/' ||
      jsonb_array_length(r->'attendance') || ' present',$o$;
BEGIN
  IF position(old IN def) = 0 THEN RAISE EXCEPTION 'run_schedules summary text patch target missing'; END IF;
  EXECUTE replace(def, old, 'app.summary_text(r),');
END$$;

-- "Send today's summary now" → a phone notification to the owner right away
CREATE OR REPLACE FUNCTION public.owner_send_summary_now() RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, extensions, pg_temp AS $$
DECLARE r jsonb; v_text text;
BEGIN
  PERFORM app.require_owner();
  r := app.daily_report(app.today_ist());
  v_text := app.summary_text(r);
  PERFORM app.notify_user(app.current_user_id(), 'DAILY_SUMMARY', 'Summary so far · ' || to_char(app.today_ist(), 'DD Mon'),
    v_text, jsonb_build_object('date', app.today_ist()), NULL);
  RETURN jsonb_build_object('queued', true, 'text', v_text);
END$$;

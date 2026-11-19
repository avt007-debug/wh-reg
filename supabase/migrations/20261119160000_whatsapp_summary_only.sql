-- WhatsApp is used only for the owner's daily summary. Clock-in / clock-out reminders reach
-- employees as phone notifications (web push) and in the app's bell — never on WhatsApp.
CREATE OR REPLACE FUNCTION app.queue_whatsapp(p_dedupe text, p_numbers text[], p_template text, p_params text[], p_kind text, p_user uuid DEFAULT NULL)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, extensions, pg_temp AS $$
DECLARE v_to text[];
BEGIN
  IF p_kind IS DISTINCT FROM 'DAILY_SUMMARY' THEN RETURN false; END IF;      -- summary only
  SELECT array_agg(DISTINCT n) INTO v_to FROM unnest(p_numbers) n WHERE n IS NOT NULL;
  IF v_to IS NULL THEN RETURN false; END IF;
  INSERT INTO notification_outbox(event_type, dedupe_key, aggregate_id, payload)
  VALUES ('WA_TEMPLATE', p_dedupe, p_user,
          jsonb_build_object('kind', p_kind, 'to', to_jsonb(v_to), 'template', p_template, 'params', to_jsonb(p_params)))
  ON CONFLICT (dedupe_key) DO NOTHING;
  RETURN FOUND;
END$$;
REVOKE EXECUTE ON FUNCTION app.queue_whatsapp(text, text[], text, text[], text, uuid) FROM PUBLIC, anon, authenticated;

-- reminders already waiting in the queue will not be sent
UPDATE notification_outbox SET status = 'DEAD', last_error = 'Reminders are sent as phone notifications, not WhatsApp'
 WHERE event_type = 'WA_TEMPLATE' AND payload->>'kind' IN ('CLOCK_IN_REMINDER', 'CLOCK_OUT_REMINDER') AND status IN ('PENDING', 'FAILED');

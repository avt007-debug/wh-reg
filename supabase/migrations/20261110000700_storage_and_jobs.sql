-- =============================================================================
-- storage_and_jobs — Supabase Storage buckets/policies, and the WhatsApp
-- pipeline wiring (pg_net → Edge Function, pg_cron for EOD + retries).
--
-- The jobs part is written so the migration also succeeds where pg_cron /
-- pg_net / Vault are unavailable (e.g. a plain Postgres used for tests): it
-- simply does nothing there.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- Storage
--   product-images : public bucket (catalogue photos are not sensitive);
--                    only owners can upload/replace.
--   purchase-docs  : private (lorry receipts, vendor invoices). Staff may
--                    upload only under '<their warehouse id>/...'; only
--                    owners can read them back.
-- ---------------------------------------------------------------------------
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types) VALUES
  ('product-images', 'product-images', true,  5242880,  ARRAY['image/jpeg','image/png','image/webp']),
  ('purchase-docs',  'purchase-docs',  false, 10485760, ARRAY['image/jpeg','image/png','image/webp','application/pdf'])
ON CONFLICT (id) DO NOTHING;

CREATE POLICY "owners manage product images" ON storage.objects FOR ALL TO authenticated
  USING (bucket_id = 'product-images' AND (SELECT app.is_owner()))
  WITH CHECK (bucket_id = 'product-images' AND (SELECT app.is_owner()));

CREATE POLICY "staff upload purchase docs to own warehouse" ON storage.objects FOR INSERT TO authenticated
  WITH CHECK (bucket_id = 'purchase-docs'
              AND ((SELECT app.is_owner())
                   OR (storage.foldername(name))[1] = (SELECT app.current_warehouse_id())::text));

CREATE POLICY "owners read purchase docs" ON storage.objects FOR SELECT TO authenticated
  USING (bucket_id = 'purchase-docs' AND (SELECT app.is_owner()));

-- ---------------------------------------------------------------------------
-- WhatsApp relay trigger: when an outbox row appears (sale committed, or the
-- EOD digest enqueued), poke the `whatsapp-relay` Edge Function via pg_net.
-- pg_net sends only after COMMIT, so a rolled-back sale never alerts.
--
-- Needs two Vault secrets (create once per project — see docs/WHATSAPP.md):
--   project_url            https://<project-ref>.supabase.co
--   whatsapp_relay_secret  random string, also set as the function secret RELAY_SECRET
-- ---------------------------------------------------------------------------
CREATE FUNCTION app.invoke_whatsapp_relay() RETURNS bigint
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, extensions, pg_temp AS $$
DECLARE v_url text; v_secret text; v_req bigint;
BEGIN
  EXECUTE $q$SELECT max(decrypted_secret) FILTER (WHERE name = 'project_url'),
                    max(decrypted_secret) FILTER (WHERE name = 'whatsapp_relay_secret')
               FROM vault.decrypted_secrets$q$ INTO v_url, v_secret;
  IF v_url IS NULL OR v_secret IS NULL THEN RETURN NULL; END IF;     -- not configured yet: outbox just waits
  EXECUTE $q$SELECT net.http_post(url := $1, headers := $2, body := '{}'::jsonb, timeout_milliseconds := 5000)$q$
     INTO v_req
    USING rtrim(v_url, '/') || '/functions/v1/whatsapp-relay',
          jsonb_build_object('Content-Type', 'application/json', 'x-relay-secret', v_secret);
  RETURN v_req;
EXCEPTION WHEN undefined_table OR undefined_function OR invalid_schema_name THEN
  RETURN NULL;                                                         -- Vault / pg_net not installed
END$$;

CREATE FUNCTION app.outbox_after_insert() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, extensions, pg_temp AS $$
BEGIN
  PERFORM app.invoke_whatsapp_relay();
  RETURN NULL;
END$$;
CREATE TRIGGER notification_outbox_relay AFTER INSERT ON notification_outbox
  FOR EACH STATEMENT EXECUTE FUNCTION app.outbox_after_insert();

-- Retry sweep: only calls the function when something is actually due.
CREATE FUNCTION app.relay_if_pending() RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, extensions, pg_temp AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM notification_outbox
              WHERE (status IN ('PENDING','FAILED') AND next_attempt_at <= now())
                 OR (status = 'SENDING' AND next_attempt_at < now() - interval '10 minutes')) THEN
    PERFORM app.invoke_whatsapp_relay();
  END IF;
END$$;

REVOKE EXECUTE ON FUNCTION app.invoke_whatsapp_relay(), app.outbox_after_insert(), app.relay_if_pending()
  FROM PUBLIC, anon, authenticated;

-- ---------------------------------------------------------------------------
-- Schedules (pg_cron runs in UTC): 20:30 IST = 15:00 UTC
-- ---------------------------------------------------------------------------
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_available_extensions WHERE name = 'pg_net') THEN
    CREATE EXTENSION IF NOT EXISTS pg_net WITH SCHEMA extensions;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_available_extensions WHERE name = 'pg_cron') THEN
    CREATE EXTENSION IF NOT EXISTS pg_cron;
    PERFORM cron.schedule('whreg-eod-digest', '0 15 * * *', 'SELECT app.enqueue_eod_digest()');
    PERFORM cron.schedule('whreg-whatsapp-retry', '*/2 * * * *', 'SELECT app.relay_if_pending()');
  ELSE
    RAISE NOTICE 'pg_cron not available: EOD digest and WhatsApp retries are not scheduled';
  END IF;
END$$;

-- push-relay reads its keys from Vault (no function secrets to set by hand).
-- Vault secrets: push_relay_secret, vapid_public_key, vapid_private_jwk, vapid_subject (optional),
-- project_url. Only the service role (the Edge Function) can call this.
CREATE FUNCTION public.push_config() RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, extensions, pg_temp AS $$
DECLARE v jsonb;
BEGIN
  EXECUTE $q$SELECT jsonb_build_object(
      'relay_secret', max(decrypted_secret) FILTER (WHERE name = 'push_relay_secret'),
      'public_key',   max(decrypted_secret) FILTER (WHERE name = 'vapid_public_key'),
      'private_jwk',  max(decrypted_secret) FILTER (WHERE name = 'vapid_private_jwk'),
      'subject',      max(decrypted_secret) FILTER (WHERE name = 'vapid_subject'))
    FROM vault.decrypted_secrets$q$ INTO v;
  RETURN v;
EXCEPTION WHEN undefined_table OR invalid_schema_name THEN
  RETURN '{}'::jsonb;
END$$;
REVOKE EXECUTE ON FUNCTION public.push_config() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.push_config() TO service_role;

-- =============================================================================
-- hardening — fixes from the Supabase security advisor.
--   function_search_path_mutable: pin search_path on the small helper functions.
-- Intentionally NOT changed (reviewed):
--   * rls_enabled_no_policy on fin.*, secure.*, audit_log, outbox, invoice_series,
--     stock_adjustments — these are deliberately unreachable by app roles.
--   * authenticated_security_definer_function_executable on owner_* — each one
--     starts with app.require_owner(); this is the only door into fin.*.
-- =============================================================================
ALTER FUNCTION app.today_ist()             SET search_path = public, extensions, pg_temp;
ALTER FUNCTION app.today_ist_start()       SET search_path = public, extensions, pg_temp;
ALTER FUNCTION app.fy_label(date)          SET search_path = public, extensions, pg_temp;
ALTER FUNCTION app.gstin_valid(text)       SET search_path = public, extensions, pg_temp;
ALTER FUNCTION app.gstin_state(text)       SET search_path = public, extensions, pg_temp;
ALTER FUNCTION app.touch_updated_at()      SET search_path = public, extensions, pg_temp;
ALTER FUNCTION app.require_owner()         SET search_path = public, extensions, pg_temp;
ALTER FUNCTION app.require_warehouse(uuid) SET search_path = public, extensions, pg_temp;

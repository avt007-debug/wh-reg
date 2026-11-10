-- =============================================================================
-- rls — GRANTs + Row Level Security for Supabase.
--
-- Supabase grants ALL on new public tables/functions to anon & authenticated
-- by default. We revoke that and grant back only what the app needs.
--   anon          : nothing at all (no data before login)
--   authenticated : staff AND owners; RLS separates them by users.role
--   service_role  : Edge Functions (WhatsApp relay, admin user creation);
--                   bypasses RLS, so it is never shipped to devices
-- =============================================================================

-- ---------------------------------------------------------------------------
-- Start from zero
-- ---------------------------------------------------------------------------
REVOKE ALL ON ALL TABLES    IN SCHEMA public FROM anon, authenticated;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM anon, authenticated;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA public FROM PUBLIC, anon, authenticated;
ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON TABLES    FROM anon, authenticated;
ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON SEQUENCES FROM anon, authenticated;
ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC, anon, authenticated;

REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA app FROM PUBLIC, anon, authenticated;
ALTER DEFAULT PRIVILEGES IN SCHEMA app REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;

-- Helpers used inside policies, column defaults and CHECK constraints.
GRANT EXECUTE ON FUNCTION
  app.today_ist(), app.today_ist_start(), app.fy_label(date), app.gstin_valid(text),
  app.gstin_state(text), app.norm(text),
  app.current_user_id(), app.current_app_role(), app.is_owner(), app.current_warehouse_id(),
  app.require_owner(), app.require_warehouse(uuid), app.search_products(text, int, uuid, uuid)
TO authenticated, service_role;

-- ---------------------------------------------------------------------------
-- Table grants (authenticated). Writes that span several tables go through the
-- create_* RPCs; these grants exist so RLS (not the RPC code) is the guard.
-- ---------------------------------------------------------------------------
GRANT SELECT ON
  gst_rates, warehouses, users, brands, categories, products, product_aliases, product_images,
  product_uoms, vendors, customers, sales_agents, inventory_levels, reorder_rules,
  stock_movements, stock_overrides, purchases, purchase_items, purchase_attachments,
  dispatches, dispatch_items, transfer_notes, transfer_note_items
TO authenticated;

GRANT INSERT ON
  product_aliases, vendors, customers, purchases, purchase_items, purchase_attachments,
  dispatches, dispatch_items, transfer_notes, transfer_note_items
TO authenticated;

-- Master data the owner may edit from the app (RLS limits these to owners).
GRANT INSERT, UPDATE ON
  gst_rates, warehouses, brands, categories, products, product_images, product_uoms,
  vendors, customers, sales_agents, reorder_rules
TO authenticated;
GRANT DELETE ON product_aliases, product_images, product_uoms, reorder_rules TO authenticated;
-- Only logistics fields of a posted invoice may be corrected; money/qty never.
GRANT UPDATE (transporter_name, vehicle_reg_no, driver_phone, lr_number, eway_bill_no) ON dispatches TO authenticated;
GRANT UPDATE (lorry_receipt_no) ON purchases TO authenticated;

-- No grants at all (reach only through owner_* / wa_* RPCs):
--   stock_adjustments, invoice_series, notification_outbox, audit_log, fin.*, secure.*

-- ---------------------------------------------------------------------------
-- Enable RLS on every table in exposed and private schemas
-- ---------------------------------------------------------------------------
DO $$
DECLARE r record;
BEGIN
  FOR r IN SELECT schemaname, tablename FROM pg_tables WHERE schemaname IN ('public', 'fin', 'secure') LOOP
    EXECUTE format('ALTER TABLE %I.%I ENABLE ROW LEVEL SECURITY', r.schemaname, r.tablename);
  END LOOP;
END$$;

-- Owner/Admin: everything their grants allow, re-checked from users.role.
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'gst_rates','warehouses','users','brands','categories','products','product_aliases',
    'product_images','product_uoms','vendors','customers','sales_agents','inventory_levels',
    'reorder_rules','stock_movements','stock_overrides','purchases','purchase_items',
    'purchase_attachments','dispatches','dispatch_items','transfer_notes','transfer_note_items']
  LOOP
    EXECUTE format(
      'CREATE POLICY owner_all ON public.%I FOR ALL TO authenticated
         USING ((SELECT app.is_owner())) WITH CHECK ((SELECT app.is_owner()))', t);
  END LOOP;
END$$;

-- ---------------------------------------------------------------------------
-- Staff policies (owners also match these; permissive policies are OR-ed)
-- ---------------------------------------------------------------------------
CREATE POLICY staff_read ON gst_rates       FOR SELECT TO authenticated USING (is_active);
CREATE POLICY staff_read ON warehouses      FOR SELECT TO authenticated USING (is_active);
CREATE POLICY staff_read ON brands          FOR SELECT TO authenticated USING (is_active);
CREATE POLICY staff_read ON categories      FOR SELECT TO authenticated USING (is_active);
CREATE POLICY staff_read ON products        FOR SELECT TO authenticated USING (is_active);
CREATE POLICY staff_read ON product_images  FOR SELECT TO authenticated USING (true);
CREATE POLICY staff_read ON product_uoms    FOR SELECT TO authenticated USING (true);
CREATE POLICY staff_read ON product_aliases FOR SELECT TO authenticated USING (true);
CREATE POLICY staff_add  ON product_aliases FOR INSERT TO authenticated WITH CHECK ((SELECT app.current_user_id()) IS NOT NULL);
CREATE POLICY staff_read ON vendors         FOR SELECT TO authenticated USING (is_active);
CREATE POLICY staff_add  ON vendors         FOR INSERT TO authenticated WITH CHECK ((SELECT app.current_user_id()) IS NOT NULL);
CREATE POLICY staff_read ON customers       FOR SELECT TO authenticated USING (is_active);
CREATE POLICY staff_add  ON customers       FOR INSERT TO authenticated WITH CHECK ((SELECT app.current_user_id()) IS NOT NULL);
CREATE POLICY staff_read ON sales_agents    FOR SELECT TO authenticated USING (is_active);

CREATE POLICY staff_self ON users FOR SELECT TO authenticated USING (id = (SELECT app.current_user_id()));

-- Physical stock: own warehouse only.
CREATE POLICY staff_own_wh ON inventory_levels FOR SELECT TO authenticated
  USING (warehouse_id = (SELECT app.current_warehouse_id()));
CREATE POLICY staff_own_wh ON reorder_rules FOR SELECT TO authenticated
  USING (warehouse_id = (SELECT app.current_warehouse_id()));
CREATE POLICY staff_own_wh ON stock_movements FOR SELECT TO authenticated
  USING (warehouse_id = (SELECT app.current_warehouse_id()));
CREATE POLICY staff_own ON stock_overrides FOR SELECT TO authenticated
  USING (requested_by = (SELECT app.current_user_id()));

-- INWARD: write into own warehouse; read back ONLY own entries from today (IST).
CREATE POLICY staff_insert ON purchases FOR INSERT TO authenticated
  WITH CHECK (warehouse_id = (SELECT app.current_warehouse_id()));
CREATE POLICY staff_today ON purchases FOR SELECT TO authenticated
  USING (warehouse_id = (SELECT app.current_warehouse_id())
         AND created_by = (SELECT app.current_user_id())
         AND created_at >= (SELECT app.today_ist_start()));
CREATE POLICY staff_via_header ON purchase_items FOR SELECT TO authenticated
  USING (EXISTS (SELECT 1 FROM purchases p WHERE p.id = purchase_id));
CREATE POLICY staff_via_header_ins ON purchase_items FOR INSERT TO authenticated
  WITH CHECK (EXISTS (SELECT 1 FROM purchases p WHERE p.id = purchase_id));
CREATE POLICY staff_via_header ON purchase_attachments FOR SELECT TO authenticated
  USING (EXISTS (SELECT 1 FROM purchases p WHERE p.id = purchase_id));
CREATE POLICY staff_via_header_ins ON purchase_attachments FOR INSERT TO authenticated
  WITH CHECK (EXISTS (SELECT 1 FROM purchases p WHERE p.id = purchase_id));

-- OUTWARD: same shape.
CREATE POLICY staff_insert ON dispatches FOR INSERT TO authenticated
  WITH CHECK (warehouse_id = (SELECT app.current_warehouse_id()));
CREATE POLICY staff_today ON dispatches FOR SELECT TO authenticated
  USING (warehouse_id = (SELECT app.current_warehouse_id())
         AND created_by = (SELECT app.current_user_id())
         AND created_at >= (SELECT app.today_ist_start()));
CREATE POLICY staff_via_header ON dispatch_items FOR SELECT TO authenticated
  USING (EXISTS (SELECT 1 FROM dispatches d WHERE d.id = dispatch_id));
CREATE POLICY staff_via_header_ins ON dispatch_items FOR INSERT TO authenticated
  WITH CHECK (EXISTS (SELECT 1 FROM dispatches d WHERE d.id = dispatch_id));

-- TRANSFERS: visible to both ends; only the source warehouse can raise one.
CREATE POLICY staff_either_end ON transfer_notes FOR SELECT TO authenticated
  USING ((SELECT app.current_warehouse_id()) IN (from_warehouse_id, to_warehouse_id));
CREATE POLICY staff_insert ON transfer_notes FOR INSERT TO authenticated
  WITH CHECK (from_warehouse_id = (SELECT app.current_warehouse_id()));
CREATE POLICY staff_via_header ON transfer_note_items FOR SELECT TO authenticated
  USING (EXISTS (SELECT 1 FROM transfer_notes n WHERE n.id = transfer_note_id));
CREATE POLICY staff_via_header_ins ON transfer_note_items FOR INSERT TO authenticated
  WITH CHECK (EXISTS (SELECT 1 FROM transfer_notes n WHERE n.id = transfer_note_id
                        AND n.from_warehouse_id = (SELECT app.current_warehouse_id())));

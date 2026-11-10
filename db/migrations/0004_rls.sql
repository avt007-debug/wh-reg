-- =============================================================================
-- 0004_rls.sql
-- Layer 1: GRANTs  — which tables/functions a role may touch at all.
-- Layer 2: RLS     — which rows. Every owner policy ALSO re-checks
--                    app.is_owner() from the users table, so even if the API
--                    wrongly ran SET ROLE app_owner for an employee, the
--                    database would still return nothing.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- Functions: nothing is executable unless granted. Critical: internal
-- SECURITY DEFINER functions such as app.apply_movement must never be
-- callable directly by an app role.
-- ---------------------------------------------------------------------------
REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA app FROM PUBLIC;
ALTER DEFAULT PRIVILEGES IN SCHEMA app REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;

-- Pure / identity helpers used in defaults, CHECKs and policies.
GRANT EXECUTE ON FUNCTION
  app.today_ist(), app.today_ist_start(), app.fy_label(date), app.gstin_valid(text),
  app.gstin_state(text), app.norm(text),
  app.current_user_id(), app.current_app_role(), app.is_owner(), app.current_warehouse_id(),
  app.require_owner(), app.require_warehouse(uuid)
TO app_employee, app_owner, app_auth;

-- Business operations exposed to floor staff.
GRANT EXECUTE ON FUNCTION
  app.search_products(text, int, uuid, uuid),
  app.request_stock_override(text, uuid, text),
  app.dispatch_transfer(uuid, uuid),
  app.receive_transfer(uuid, jsonb)
TO app_employee, app_owner;

-- Owner-only operations.
GRANT EXECUTE ON FUNCTION
  app.cancel_dispatch(uuid, text), app.cancel_purchase(uuid, text), app.set_override_pin(text)
TO app_owner;

-- ---------------------------------------------------------------------------
-- Table grants
-- ---------------------------------------------------------------------------
-- Floor staff: read reference + operational tables, insert transactions.
GRANT SELECT ON
  gst_rates, warehouses, users, brands, categories, products, product_aliases, product_images,
  product_uoms, vendors, customers, sales_agents, inventory_levels, reorder_rules,
  stock_movements, stock_overrides, purchases, purchase_items, purchase_attachments,
  dispatches, dispatch_items, transfer_notes, transfer_note_items
TO app_employee;

GRANT INSERT ON
  product_aliases, vendors, customers, purchases, purchase_items, purchase_attachments,
  dispatches, dispatch_items, transfer_notes, transfer_note_items
TO app_employee;

-- Owner/Admin: everything operational + fin.*; ledgers stay append-only.
GRANT SELECT ON ALL TABLES IN SCHEMA public TO app_owner;
GRANT INSERT, UPDATE ON
  gst_rates, warehouses, users, brands, categories, products, product_aliases, product_images,
  product_uoms, vendors, customers, sales_agents, reorder_rules
TO app_owner;
GRANT DELETE ON product_aliases, product_images, product_uoms, reorder_rules TO app_owner;
GRANT INSERT ON purchases, purchase_items, purchase_attachments, dispatches, dispatch_items,
                transfer_notes, transfer_note_items, stock_adjustments TO app_owner;
-- Only logistics fields of a posted invoice may be corrected; money/qty never.
GRANT UPDATE (transporter_name, vehicle_reg_no, driver_phone, lr_number, eway_bill_no) ON dispatches TO app_owner;
GRANT UPDATE (lorry_receipt_no) ON purchases TO app_owner;
GRANT INSERT, UPDATE ON notification_outbox TO app_owner;     -- worker runs as SYSTEM (owner-class)

GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA fin TO app_owner;

-- Owners can create users / reset passwords but can NEVER read hashes or PINs.
GRANT USAGE ON SCHEMA auth TO app_owner;
GRANT SELECT (user_id), INSERT (user_id, password_hash),
      UPDATE (password_hash, failed_attempts, locked_until, password_changed_at)
  ON auth.credentials TO app_owner;
GRANT UPDATE (revoked_at) , SELECT (id, user_id, revoked_at) ON auth.refresh_tokens TO app_owner;  -- force logout

-- Login path only.
GRANT SELECT ON users TO app_auth;
GRANT UPDATE (last_login_at) ON users TO app_auth;
GRANT SELECT, INSERT, UPDATE ON auth.credentials, auth.refresh_tokens TO app_auth;

-- ---------------------------------------------------------------------------
-- Enable RLS everywhere app roles can reach
-- ---------------------------------------------------------------------------
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'gst_rates','warehouses','users','brands','categories','products','product_aliases',
    'product_images','product_uoms','vendors','customers','sales_agents','inventory_levels',
    'reorder_rules','stock_movements','stock_adjustments','stock_overrides','purchases',
    'purchase_items','purchase_attachments','invoice_series','dispatches','dispatch_items',
    'transfer_notes','transfer_note_items','notification_outbox','audit_log',
    'fin.purchase_discounts','fin.customer_payments','fin.customer_credit',
    'fin.purchase_orders','fin.purchase_order_items']
  LOOP
    EXECUTE format('ALTER TABLE %s ENABLE ROW LEVEL SECURITY', t);
  END LOOP;
END$$;

-- Helper to cut repetition: owner gets everything their GRANTs allow.
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'gst_rates','warehouses','users','brands','categories','products','product_aliases',
    'product_images','product_uoms','vendors','customers','sales_agents','inventory_levels',
    'reorder_rules','stock_movements','stock_adjustments','stock_overrides','purchases',
    'purchase_items','purchase_attachments','invoice_series','dispatches','dispatch_items',
    'transfer_notes','transfer_note_items','notification_outbox','audit_log',
    'fin.purchase_discounts','fin.customer_payments','fin.customer_credit',
    'fin.purchase_orders','fin.purchase_order_items']
  LOOP
    EXECUTE format(
      'CREATE POLICY owner_all ON %s AS PERMISSIVE FOR ALL TO app_owner
         USING ((SELECT app.is_owner())) WITH CHECK ((SELECT app.is_owner()))', t);
  END LOOP;
END$$;

-- ---------------------------------------------------------------------------
-- Employee policies
-- ---------------------------------------------------------------------------

-- Reference data: readable.
CREATE POLICY emp_read ON gst_rates      FOR SELECT TO app_employee USING (is_active);
CREATE POLICY emp_read ON warehouses     FOR SELECT TO app_employee USING (is_active);  -- names only; needed for transfer destinations
CREATE POLICY emp_read ON brands         FOR SELECT TO app_employee USING (is_active);
CREATE POLICY emp_read ON categories     FOR SELECT TO app_employee USING (is_active);
CREATE POLICY emp_read ON products       FOR SELECT TO app_employee USING (is_active);
CREATE POLICY emp_read ON product_images FOR SELECT TO app_employee USING (true);
CREATE POLICY emp_read ON product_uoms   FOR SELECT TO app_employee USING (true);
CREATE POLICY emp_read ON product_aliases FOR SELECT TO app_employee USING (true);
CREATE POLICY emp_add  ON product_aliases FOR INSERT TO app_employee WITH CHECK ((SELECT app.current_user_id()) IS NOT NULL);
CREATE POLICY emp_read ON vendors        FOR SELECT TO app_employee USING (is_active);
CREATE POLICY emp_add  ON vendors        FOR INSERT TO app_employee WITH CHECK ((SELECT app.current_user_id()) IS NOT NULL);
CREATE POLICY emp_read ON customers      FOR SELECT TO app_employee USING (is_active);
CREATE POLICY emp_add  ON customers      FOR INSERT TO app_employee WITH CHECK ((SELECT app.current_user_id()) IS NOT NULL);
CREATE POLICY emp_read ON sales_agents   FOR SELECT TO app_employee USING (is_active);

-- Users: only themselves.
CREATE POLICY emp_self ON users FOR SELECT TO app_employee USING (id = (SELECT app.current_user_id()));
CREATE POLICY auth_lookup ON users FOR SELECT TO app_auth USING (true);
CREATE POLICY auth_touch  ON users FOR UPDATE TO app_auth USING (true) WITH CHECK (true);

-- Physical stock: own warehouse only.
CREATE POLICY emp_own_wh ON inventory_levels FOR SELECT TO app_employee
  USING (warehouse_id = (SELECT app.current_warehouse_id()));
CREATE POLICY emp_own_wh ON reorder_rules FOR SELECT TO app_employee
  USING (warehouse_id = (SELECT app.current_warehouse_id()));
CREATE POLICY emp_own_wh ON stock_movements FOR SELECT TO app_employee
  USING (warehouse_id = (SELECT app.current_warehouse_id()));
CREATE POLICY emp_own ON stock_overrides FOR SELECT TO app_employee
  USING (requested_by = (SELECT app.current_user_id()));

-- INWARD: write into own warehouse; read back ONLY own entries from today (IST).
CREATE POLICY emp_insert ON purchases FOR INSERT TO app_employee
  WITH CHECK (warehouse_id = (SELECT app.current_warehouse_id()));
CREATE POLICY emp_today ON purchases FOR SELECT TO app_employee
  USING (warehouse_id = (SELECT app.current_warehouse_id())
         AND created_by = (SELECT app.current_user_id())
         AND created_at >= (SELECT app.today_ist_start()));

-- Child rows inherit header visibility (the sub-select is itself RLS-filtered).
CREATE POLICY emp_via_header ON purchase_items FOR SELECT TO app_employee
  USING (EXISTS (SELECT 1 FROM purchases p WHERE p.id = purchase_id));
CREATE POLICY emp_via_header_ins ON purchase_items FOR INSERT TO app_employee
  WITH CHECK (EXISTS (SELECT 1 FROM purchases p WHERE p.id = purchase_id));
CREATE POLICY emp_via_header ON purchase_attachments FOR SELECT TO app_employee
  USING (EXISTS (SELECT 1 FROM purchases p WHERE p.id = purchase_id));
CREATE POLICY emp_via_header_ins ON purchase_attachments FOR INSERT TO app_employee
  WITH CHECK (EXISTS (SELECT 1 FROM purchases p WHERE p.id = purchase_id));

-- OUTWARD: same shape.
CREATE POLICY emp_insert ON dispatches FOR INSERT TO app_employee
  WITH CHECK (warehouse_id = (SELECT app.current_warehouse_id()));
CREATE POLICY emp_today ON dispatches FOR SELECT TO app_employee
  USING (warehouse_id = (SELECT app.current_warehouse_id())
         AND created_by = (SELECT app.current_user_id())
         AND created_at >= (SELECT app.today_ist_start()));
CREATE POLICY emp_via_header ON dispatch_items FOR SELECT TO app_employee
  USING (EXISTS (SELECT 1 FROM dispatches d WHERE d.id = dispatch_id));
CREATE POLICY emp_via_header_ins ON dispatch_items FOR INSERT TO app_employee
  WITH CHECK (EXISTS (SELECT 1 FROM dispatches d WHERE d.id = dispatch_id));

-- TRANSFERS: visible to both ends; only the source warehouse can raise one.
CREATE POLICY emp_either_end ON transfer_notes FOR SELECT TO app_employee
  USING ((SELECT app.current_warehouse_id()) IN (from_warehouse_id, to_warehouse_id));
CREATE POLICY emp_insert ON transfer_notes FOR INSERT TO app_employee
  WITH CHECK (from_warehouse_id = (SELECT app.current_warehouse_id()));
CREATE POLICY emp_via_header ON transfer_note_items FOR SELECT TO app_employee
  USING (EXISTS (SELECT 1 FROM transfer_notes n WHERE n.id = transfer_note_id));
CREATE POLICY emp_via_header_ins ON transfer_note_items FOR INSERT TO app_employee
  WITH CHECK (EXISTS (SELECT 1 FROM transfer_notes n WHERE n.id = transfer_note_id
                        AND n.from_warehouse_id = (SELECT app.current_warehouse_id())));

-- No employee policies (=> zero rows, and no GRANT anyway) on:
--   stock_adjustments, invoice_series, notification_outbox, audit_log, fin.*

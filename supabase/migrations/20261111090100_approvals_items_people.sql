-- =============================================================================
-- approvals_items_people
--   1. Purchase approval: staff purchases are PENDING (no stock) until the owner
--      approves; approval posts the stock. Shows who entered / approved.
--   2. Items: owner adds / edits items (code, name, company, HSN, GST, MRP ⇄
--      pre-GST price, packs, reorder level, opening stock).
--   3. Stock history: every stock change with the person who entered it.
--   4. Staff logins: soft "remove", owner-visible passwords (kept encrypted in
--      Supabase Vault, written only by the admin-users Edge Function).
--   5. Attendance (clock in / clock out).
--   6. Market runs (place visited) + customers approached.
--   7. Owner employee reports by month.
-- =============================================================================

-- ---------------------------------------------------------------- 1. APPROVALS
ALTER TABLE purchases
  ADD COLUMN approved_by     uuid REFERENCES users(id),
  ADD COLUMN approved_at     timestamptz,
  ADD COLUMN rejected_reason text;

-- Owner entries are approved at once; everyone else's wait.
CREATE FUNCTION app.purchase_approval() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, extensions, pg_temp AS $$
BEGIN
  IF app.is_owner() THEN
    NEW.status := 'POSTED'; NEW.approved_by := app.current_user_id(); NEW.approved_at := now();
  ELSE
    NEW.status := 'PENDING'; NEW.approved_by := NULL; NEW.approved_at := NULL;
  END IF;
  NEW.rejected_reason := NULL;
  RETURN NEW;
END$$;
-- fires after purchases_defaults (triggers run in name order)
CREATE TRIGGER purchases_zz_approval BEFORE INSERT ON purchases
  FOR EACH ROW EXECUTE FUNCTION app.purchase_approval();

-- Lines of a PENDING purchase do not touch stock.
CREATE OR REPLACE FUNCTION app.post_line_stock() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, extensions, pg_temp AS $$
DECLARE v_wh uuid; v_override uuid; v_status txn_status;
BEGIN
  IF TG_TABLE_NAME = 'purchase_items' THEN
    SELECT warehouse_id, status INTO v_wh, v_status FROM purchases WHERE id = NEW.purchase_id;
    IF v_status <> 'POSTED' THEN RETURN NULL; END IF;
    PERFORM app.apply_movement(v_wh, NEW.product_id, 'PURCHASE_IN', NEW.qty_base,
                               'purchase_items', NEW.id, NEW.purchase_id);
  ELSE
    SELECT warehouse_id, override_id INTO v_wh, v_override FROM dispatches WHERE id = NEW.dispatch_id;
    PERFORM app.apply_movement(v_wh, NEW.product_id, 'DISPATCH_OUT', -NEW.qty_base,
                               'dispatch_items', NEW.id, NEW.dispatch_id, v_override);
  END IF;
  RETURN NULL;
END$$;

-- Discount maths that also works for PENDING purchases (the fin views only cover POSTED).
CREATE FUNCTION fin.purchase_owner_discount(p_id uuid) RETURNS numeric
LANGUAGE sql STABLE SET search_path = public, fin, extensions, pg_temp AS $$
  SELECT coalesce((SELECT CASE d.discount_type
                            WHEN 'PERCENT' THEN round(p.taxable_total * d.discount_value / 100, 2)
                            WHEN 'AMOUNT'  THEN round(d.discount_value, 2) END
                     FROM fin.purchase_discounts d WHERE d.purchase_id = p.id), 0)
       + coalesce((SELECT sum(fin.item_discount_amount(x.discount_type, x.discount_value, pi.line_taxable))
                     FROM purchase_items pi JOIN fin.purchase_item_discounts x ON x.purchase_item_id = pi.id
                    WHERE pi.purchase_id = p.id), 0)
  FROM purchases p WHERE p.id = p_id
$$;
REVOKE EXECUTE ON FUNCTION fin.purchase_owner_discount(uuid) FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION fin.purchase_detail(p_id uuid) RETURNS jsonb
LANGUAGE sql STABLE SET search_path = public, fin, extensions, pg_temp AS $$
  SELECT jsonb_build_object(
    'id', p.id, 'warehouse_id', p.warehouse_id, 'warehouse_code', w.code, 'warehouse_name', w.name,
    'vendor_id', p.vendor_id, 'vendor_name', p.vendor_name, 'vendor_gstin', p.vendor_gstin,
    'vendor_invoice_no', p.vendor_invoice_no, 'vendor_invoice_date', p.vendor_invoice_date,
    'received_on', p.received_on, 'lorry_receipt_no', p.lorry_receipt_no, 'is_interstate', p.is_interstate,
    'freight_amount', p.freight_amount, 'taxable_total', p.taxable_total,
    'tax_total', p.cgst_total + p.sgst_total + p.igst_total, 'grand_total', p.grand_total, 'status', p.status,
    'entered_by', cu.full_name, 'entered_by_login', cu.login_id, 'entered_by_role', cu.role, 'entered_at', p.created_at,
    'approved_by', au.full_name, 'approved_at', p.approved_at, 'rejected_reason', p.rejected_reason,
    'attachments', (SELECT coalesce(jsonb_agg(jsonb_build_object('kind', a.kind, 'path', a.storage_key, 'mime', a.mime_type)), '[]')
                      FROM purchase_attachments a WHERE a.purchase_id = p.id),
    'bill_discount_type', bd.discount_type, 'bill_discount_value', bd.discount_value,
    'bill_discount_reason', bd.reason,
    'bill_discount_amount', coalesce(CASE bd.discount_type
         WHEN 'PERCENT' THEN round(p.taxable_total * bd.discount_value / 100, 2)
         WHEN 'AMOUNT'  THEN round(bd.discount_value, 2) END, 0),
    'total_discount', fin.purchase_owner_discount(p.id),
    'net_taxable', p.taxable_total - fin.purchase_owner_discount(p.id),
    'net_payable', p.grand_total - fin.purchase_owner_discount(p.id),
    'lines', (SELECT coalesce(jsonb_agg(jsonb_build_object(
                'id', pi.id, 'line_no', pi.line_no, 'product_id', pi.product_id, 'sku_code', pr.sku_code,
                'name', pr.name, 'uom', pi.uom_code, 'qty', pi.qty, 'qty_base', pi.qty_base, 'hsn_code', pi.hsn_code,
                'gst_rate', pi.gst_rate, 'unit_base_price', pi.unit_base_price, 'unit_incl_price', pi.unit_incl_price,
                'line_taxable', pi.line_taxable, 'line_total', pi.line_total,
                'item_discount_type', xd.discount_type, 'item_discount_value', xd.discount_value,
                'item_discount_amount', coalesce(fin.item_discount_amount(xd.discount_type, xd.discount_value, pi.line_taxable), 0),
                'effective_unit_cost_base', lc.effective_unit_cost_base) ORDER BY pi.line_no), '[]')
              FROM purchase_items pi
              JOIN products pr ON pr.id = pi.product_id
              LEFT JOIN fin.purchase_item_discounts xd ON xd.purchase_item_id = pi.id
              LEFT JOIN fin.v_purchase_line_cost lc ON lc.purchase_item_id = pi.id
             WHERE pi.purchase_id = p.id))
  FROM purchases p
  JOIN warehouses w ON w.id = p.warehouse_id
  JOIN users cu ON cu.id = p.created_by
  LEFT JOIN users au ON au.id = p.approved_by
  LEFT JOIN fin.purchase_discounts bd ON bd.purchase_id = p.id
  WHERE p.id = p_id
$$;

CREATE OR REPLACE FUNCTION public.owner_update_purchase(p_id uuid, p jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, fin, extensions, pg_temp AS $$
DECLARE v purchases; r record;
BEGIN
  PERFORM app.require_owner();
  SELECT * INTO v FROM purchases WHERE id = p_id FOR UPDATE;
  IF NOT FOUND OR v.status NOT IN ('POSTED', 'PENDING') THEN
    RAISE EXCEPTION 'Purchase not found or already cancelled' USING ERRCODE = 'WH005';
  END IF;

  UPDATE purchases SET
    vendor_invoice_no   = coalesce(nullif(trim(p->>'vendorInvoiceNo'), ''), vendor_invoice_no),
    vendor_invoice_date = coalesce((p->>'vendorInvoiceDate')::date, vendor_invoice_date),
    lorry_receipt_no    = CASE WHEN p ? 'lorryReceiptNo' THEN nullif(trim(p->>'lorryReceiptNo'), '') ELSE lorry_receipt_no END,
    freight_amount      = coalesce((p->>'freightAmount')::numeric, freight_amount)
  WHERE id = p_id;

  IF p ? 'lines' THEN
    IF jsonb_array_length(coalesce(p->'lines', '[]'::jsonb)) = 0 THEN
      RAISE EXCEPTION 'A purchase needs at least one item' USING ERRCODE = 'WH005';
    END IF;
    IF v.status = 'POSTED' THEN       -- pending purchases never added stock, so nothing to take back
      FOR r IN SELECT * FROM purchase_items WHERE purchase_id = p_id ORDER BY line_no LOOP
        PERFORM app.apply_movement(v.warehouse_id, r.product_id, 'REVERSAL', -r.qty_base,
                                   'purchase_items', r.id, p_id, NULL, true);
      END LOOP;
    END IF;
    DELETE FROM purchase_items WHERE purchase_id = p_id;

    PERFORM set_config('app.editing_doc', p_id::text, true);
    INSERT INTO purchase_items(purchase_id, line_no, product_id, uom_code, conversion_factor, qty,
                               hsn_code, gst_rate, unit_base_price, unit_incl_price)
    SELECT p_id, e.ord, (e.j->>'productId')::uuid, e.j->>'uomCode', 1, (e.j->>'qty')::numeric,
           nullif(e.j->>'hsnCode', ''), (e.j->>'gstRate')::numeric, (e.j->>'unitBasePrice')::numeric,
           (e.j->>'unitInclPrice')::numeric
      FROM jsonb_array_elements(p->'lines') WITH ORDINALITY AS e(j, ord);
    PERFORM set_config('app.editing_doc', '', true);

    INSERT INTO fin.purchase_item_discounts(purchase_item_id, discount_type, discount_value, reason, entered_by)
    SELECT pi.id, e.j->>'discountType', (e.j->>'discountValue')::numeric, e.j->>'discountReason', app.current_user_id()
      FROM jsonb_array_elements(p->'lines') WITH ORDINALITY AS e(j, ord)
      JOIN purchase_items pi ON pi.purchase_id = p_id AND pi.line_no = e.ord
     WHERE e.j->>'discountType' IN ('PERCENT', 'AMOUNT') AND coalesce((e.j->>'discountValue')::numeric, 0) > 0;
  END IF;

  PERFORM app.recompute_purchase_totals(p_id);
  INSERT INTO audit_log(table_name, row_id, action, actor_id, old_data, new_data)
  VALUES ('public.purchases', p_id::text, 'EDIT', app.current_user_id(), to_jsonb(v),
          (SELECT to_jsonb(x) FROM purchases x WHERE x.id = p_id));
  RETURN fin.purchase_detail(p_id);
END$$;

CREATE FUNCTION public.owner_approve_purchase(p_id uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, fin, extensions, pg_temp AS $$
DECLARE v purchases; r record;
BEGIN
  PERFORM app.require_owner();
  SELECT * INTO v FROM purchases WHERE id = p_id FOR UPDATE;
  IF NOT FOUND OR v.status <> 'PENDING' THEN
    RAISE EXCEPTION 'This purchase is not waiting for approval' USING ERRCODE = 'WH005';
  END IF;
  UPDATE purchases SET status = 'POSTED', approved_by = app.current_user_id(), approved_at = now() WHERE id = p_id;
  FOR r IN SELECT * FROM purchase_items WHERE purchase_id = p_id ORDER BY line_no LOOP
    PERFORM app.apply_movement(v.warehouse_id, r.product_id, 'PURCHASE_IN', r.qty_base, 'purchase_items', r.id, p_id);
  END LOOP;
  RETURN fin.purchase_detail(p_id);
END$$;

CREATE FUNCTION public.owner_reject_purchase(p_id uuid, p_reason text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, fin, extensions, pg_temp AS $$
BEGIN
  PERFORM app.require_owner();
  IF coalesce(trim(p_reason), '') = '' THEN RAISE EXCEPTION 'Give a reason for rejecting' USING ERRCODE = 'WH005'; END IF;
  UPDATE purchases SET status = 'CANCELLED', rejected_reason = trim(p_reason), cancelled_reason = 'Rejected: ' || trim(p_reason),
                       approved_by = app.current_user_id(), approved_at = now()
   WHERE id = p_id AND status = 'PENDING';
  IF NOT FOUND THEN RAISE EXCEPTION 'This purchase is not waiting for approval' USING ERRCODE = 'WH005'; END IF;
  RETURN fin.purchase_detail(p_id);
END$$;

CREATE FUNCTION public.owner_pending_purchases() RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, fin, extensions, pg_temp AS $$
BEGIN
  PERFORM app.require_owner();
  RETURN (SELECT coalesce(jsonb_agg(fin.purchase_detail(p.id) ORDER BY p.created_at), '[]')
            FROM purchases p WHERE p.status = 'PENDING');
END$$;

CREATE OR REPLACE FUNCTION public.owner_purchases_month(p_month date, p_warehouse uuid DEFAULT NULL) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, fin, extensions, pg_temp AS $$
DECLARE v_from date := date_trunc('month', p_month)::date;
BEGIN
  PERFORM app.require_owner();
  RETURN (SELECT coalesce(jsonb_agg(fin.purchase_detail(p.id) ORDER BY p.vendor_invoice_date, p.vendor_invoice_no), '[]')
            FROM purchases p
           WHERE p.status IN ('POSTED', 'PENDING')
             AND p.vendor_invoice_date >= v_from AND p.vendor_invoice_date < (v_from + interval '1 month')
             AND (p_warehouse IS NULL OR p.warehouse_id = p_warehouse));
END$$;

-- Staff see the status of what they entered today (purchase_json already has 'status').

-- ---------------------------------------------------------------- 2. ITEMS
CREATE FUNCTION public.owner_save_product(p jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, extensions, pg_temp AS $$
DECLARE v_id uuid := nullif(p->>'id', '')::uuid; r record; v_code text := upper(trim(coalesce(p->>'skuCode', '')));
BEGIN
  PERFORM app.require_owner();
  IF coalesce(trim(p->>'name'), '') = '' THEN RAISE EXCEPTION 'Item name is required' USING ERRCODE = 'WH005'; END IF;
  IF v_code !~ '^[A-Z0-9-]{2,24}$' THEN
    RAISE EXCEPTION 'Item code: 2–24 letters, digits or -' USING ERRCODE = 'WH005';
  END IF;
  IF nullif(trim(p->>'hsnCode'), '') !~ '^[0-9]{4}([0-9]{2}){0,2}$' THEN
    RAISE EXCEPTION 'HSN code must be 4, 6 or 8 digits' USING ERRCODE = 'WH005';
  END IF;
  IF v_id IS NULL AND nullif(p->>'gstRate', '') IS NULL THEN RAISE EXCEPTION 'Choose the GST rate' USING ERRCODE = 'WH005'; END IF;
  IF EXISTS (SELECT 1 FROM products WHERE sku_code = v_code AND id IS DISTINCT FROM v_id) THEN
    RAISE EXCEPTION 'Item code % is already used by another item', v_code USING ERRCODE = 'WH005';
  END IF;

  IF v_id IS NULL THEN
    INSERT INTO products(sku_code, name, brand_id, category_id, specification, hsn_code, default_gst_rate,
                         base_uom, mrp, default_selling_price, default_reorder_level)
    VALUES (v_code, trim(p->>'name'), nullif(p->>'brandId', '')::uuid, nullif(p->>'categoryId', '')::uuid,
            nullif(trim(p->>'specification'), ''), nullif(trim(p->>'hsnCode'), ''), (p->>'gstRate')::numeric,
            upper(coalesce(nullif(trim(p->>'baseUom'), ''), 'PCS')),
            nullif(p->>'mrp', '')::numeric, nullif(p->>'sellingPrice', '')::numeric,
            coalesce(nullif(p->>'reorderLevel', '')::numeric, 0))
    RETURNING id INTO v_id;
  ELSE
    UPDATE products SET
      sku_code = v_code, name = trim(p->>'name'),
      brand_id = CASE WHEN p ? 'brandId' THEN nullif(p->>'brandId', '')::uuid ELSE brand_id END,
      category_id = CASE WHEN p ? 'categoryId' THEN nullif(p->>'categoryId', '')::uuid ELSE category_id END,
      specification = CASE WHEN p ? 'specification' THEN nullif(trim(p->>'specification'), '') ELSE specification END,
      hsn_code = nullif(trim(p->>'hsnCode'), ''),
      default_gst_rate = coalesce((p->>'gstRate')::numeric, default_gst_rate),
      mrp = CASE WHEN p ? 'mrp' THEN nullif(p->>'mrp', '')::numeric ELSE mrp END,
      default_selling_price = CASE WHEN p ? 'sellingPrice' THEN nullif(p->>'sellingPrice', '')::numeric ELSE default_selling_price END,
      default_reorder_level = coalesce(nullif(p->>'reorderLevel', '')::numeric, default_reorder_level),
      is_active = coalesce((p->>'isActive')::boolean, is_active),
      updated_at = now()
    WHERE id = v_id;
    IF NOT FOUND THEN RAISE EXCEPTION 'Item not found' USING ERRCODE = 'WH005'; END IF;
  END IF;

  IF p ? 'packs' THEN
    FOR r IN SELECT upper(trim(e->>'code')) AS code, (e->>'factor')::numeric AS factor,
                    coalesce(nullif(trim(e->>'name'), ''), initcap(e->>'code')) AS dname
               FROM jsonb_array_elements(p->'packs') e WHERE coalesce(trim(e->>'code'), '') <> '' LOOP
      IF r.factor IS NULL OR r.factor <= 1 THEN
        RAISE EXCEPTION 'Pack % must hold more than 1 unit', r.code USING ERRCODE = 'WH005';
      END IF;
      INSERT INTO product_uoms(product_id, uom_code, display_name, factor_to_base, is_base, sort_order)
      VALUES (v_id, r.code, r.dname, r.factor, false, 0)
      ON CONFLICT (product_id, uom_code) DO UPDATE
        SET factor_to_base = EXCLUDED.factor_to_base, display_name = EXCLUDED.display_name
        WHERE NOT product_uoms.is_base;
    END LOOP;
    DELETE FROM product_uoms WHERE product_id = v_id AND NOT is_base
       AND uom_code NOT IN (SELECT upper(trim(e->>'code')) FROM jsonb_array_elements(p->'packs') e WHERE e->>'code' IS NOT NULL);
  END IF;

  FOR r IN SELECT (e->>'warehouseId')::uuid AS wh, (e->>'qty')::numeric AS q
             FROM jsonb_array_elements(coalesce(p->'openingStock', '[]'::jsonb)) e LOOP
    IF coalesce(r.q, 0) > 0 THEN
      INSERT INTO stock_adjustments(warehouse_id, product_id, movement, qty_delta_base, notes)
      VALUES (r.wh, v_id, 'OPENING', r.q, 'Opening stock');
    END IF;
  END LOOP;
  RETURN jsonb_build_object('id', v_id);
END$$;

CREATE FUNCTION public.owner_product(p_id uuid) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, extensions, pg_temp AS $$
BEGIN
  PERFORM app.require_owner();
  RETURN (SELECT jsonb_build_object(
      'id', p.id, 'sku_code', p.sku_code, 'name', p.name, 'brand_id', p.brand_id, 'category_id', p.category_id,
      'specification', p.specification, 'hsn_code', p.hsn_code, 'gst_rate', p.default_gst_rate, 'base_uom', p.base_uom,
      'mrp', p.mrp, 'selling_price', p.default_selling_price, 'reorder_level', p.default_reorder_level, 'is_active', p.is_active,
      'packs', (SELECT coalesce(jsonb_agg(jsonb_build_object('code', u.uom_code, 'factor', u.factor_to_base, 'name', u.display_name)
                                          ORDER BY u.factor_to_base DESC), '[]')
                  FROM product_uoms u WHERE u.product_id = p.id AND NOT u.is_base))
    FROM products p WHERE p.id = p_id);
END$$;

-- ---------------------------------------------------------------- 3. STOCK HISTORY
CREATE FUNCTION app.movement_entered_by(p_ref_table text, p_doc uuid, p_mover uuid) RETURNS uuid
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, extensions, pg_temp AS $$
  SELECT coalesce(
    CASE p_ref_table WHEN 'purchase_items' THEN (SELECT created_by FROM purchases WHERE id = p_doc)
                     WHEN 'dispatch_items' THEN (SELECT created_by FROM dispatches WHERE id = p_doc)
                     WHEN 'transfer_note_items' THEN (SELECT created_by FROM transfer_notes WHERE id = p_doc) END,
    p_mover)
$$;

CREATE FUNCTION public.owner_stock_history(p_product uuid, p_warehouse uuid DEFAULT NULL, p_limit int DEFAULT 60) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, extensions, pg_temp AS $$
BEGIN
  PERFORM app.require_owner();
  RETURN (SELECT coalesce(jsonb_agg(row_to_json(h)::jsonb ORDER BY h.at DESC), '[]') FROM (
    SELECT sm.created_at AS at, sm.movement, sm.qty_delta_base AS qty, w.name AS warehouse,
           eu.full_name AS entered_by, eu.role AS entered_by_role, mu.full_name AS posted_by,
           CASE sm.ref_table
             WHEN 'purchase_items' THEN 'Purchase ' || pu.vendor_invoice_no || ' · ' || pu.vendor_name
             WHEN 'dispatch_items' THEN 'Sale ' || d.invoice_no || ' · ' || d.customer_name
             WHEN 'transfer_note_items' THEN 'Transfer ' || tn.note_no
             WHEN 'stock_adjustments' THEN coalesce(sa.notes, '')
             ELSE '' END AS reference
      FROM stock_movements sm
      JOIN warehouses w ON w.id = sm.warehouse_id
      JOIN users mu ON mu.id = sm.created_by
      JOIN users eu ON eu.id = app.movement_entered_by(sm.ref_table, sm.doc_id, sm.created_by)
      LEFT JOIN purchases pu ON sm.ref_table = 'purchase_items' AND pu.id = sm.doc_id
      LEFT JOIN dispatches d ON sm.ref_table = 'dispatch_items' AND d.id = sm.doc_id
      LEFT JOIN transfer_notes tn ON sm.ref_table = 'transfer_note_items' AND tn.id = sm.doc_id
      LEFT JOIN stock_adjustments sa ON sm.ref_table = 'stock_adjustments' AND sa.id = sm.ref_id
     WHERE sm.product_id = p_product AND (p_warehouse IS NULL OR sm.warehouse_id = p_warehouse)
     ORDER BY sm.created_at DESC
     LIMIT least(greatest(p_limit, 1), 500)) h);
END$$;

CREATE OR REPLACE FUNCTION public.owner_stock_list(p_warehouse uuid DEFAULT NULL, p_brand uuid DEFAULT NULL) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, fin, extensions, pg_temp AS $$
BEGIN
  PERFORM app.require_owner();
  RETURN (SELECT coalesce(jsonb_agg(row_to_json(r)::jsonb ORDER BY r.brand NULLS LAST, r.name), '[]') FROM (
    SELECT p.id AS product_id, p.sku_code, p.name, p.brand_id, b.name AS brand, c.path AS category,
           p.hsn_code, p.default_gst_rate AS gst_rate, p.mrp, p.default_selling_price AS selling_price,
           p.search_doc AS search,
           (SELECT coalesce(u.display_name, p.base_uom) FROM product_uoms u WHERE u.product_id = p.id AND u.is_base) AS base_uom_name,
           (SELECT coalesce(jsonb_agg(jsonb_build_object('code', u.uom_code, 'factor', u.factor_to_base, 'displayName', u.display_name)
                                      ORDER BY u.factor_to_base DESC), '[]')
              FROM product_uoms u WHERE u.product_id = p.id) AS uoms,
           pc.avg_effective_cost_base AS avg_cost,
           coalesce(sum(il.qty_on_hand), 0) AS qty,
           coalesce(sum(il.qty_in_transit), 0) AS in_transit,
           round(coalesce(sum(il.qty_on_hand), 0) * coalesce(pc.avg_effective_cost_base, 0), 2) AS value,
           (SELECT coalesce(jsonb_object_agg(w.code, coalesce(l.qty_on_hand, 0)), '{}')
              FROM warehouses w LEFT JOIN inventory_levels l ON l.warehouse_id = w.id AND l.product_id = p.id
             WHERE w.is_active AND (p_warehouse IS NULL OR w.id = p_warehouse)) AS per_warehouse,
           (SELECT jsonb_build_object('by', eu.full_name, 'at', sm.created_at, 'movement', sm.movement, 'qty', sm.qty_delta_base)
              FROM stock_movements sm
              JOIN users eu ON eu.id = app.movement_entered_by(sm.ref_table, sm.doc_id, sm.created_by)
             WHERE sm.product_id = p.id AND (p_warehouse IS NULL OR sm.warehouse_id = p_warehouse)
             ORDER BY sm.created_at DESC LIMIT 1) AS last_entry
      FROM products p
      LEFT JOIN brands b ON b.id = p.brand_id
      LEFT JOIN categories c ON c.id = p.category_id
      LEFT JOIN fin.v_product_cost pc ON pc.product_id = p.id
      LEFT JOIN inventory_levels il ON il.product_id = p.id AND (p_warehouse IS NULL OR il.warehouse_id = p_warehouse)
     WHERE p.is_active AND (p_brand IS NULL OR p.brand_id = p_brand)
     GROUP BY p.id, b.name, c.path, pc.avg_effective_cost_base) r);
END$$;

-- ---------------------------------------------------------------- 4. STAFF LOGINS
ALTER TABLE users ADD COLUMN removed_at timestamptz;

-- Passwords the OWNER sets for staff are kept (encrypted, in Supabase Vault) so
-- the owner can look them up. Only the admin-users Edge Function (service role)
-- writes them; only owners can read them, and each look-up is audit-logged.
CREATE FUNCTION public.svc_store_staff_password(p_user uuid, p_password text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, extensions, pg_temp AS $$
DECLARE v_id uuid; v_name text := 'staff_pw:' || p_user;
BEGIN
  SELECT id INTO v_id FROM vault.secrets WHERE name = v_name;
  IF v_id IS NULL THEN
    PERFORM vault.create_secret(p_password, v_name, 'Staff login password set by the owner');
  ELSE
    PERFORM vault.update_secret(v_id, p_password);
  END IF;
END$$;
REVOKE EXECUTE ON FUNCTION public.svc_store_staff_password(uuid, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.svc_store_staff_password(uuid, text) TO service_role;

CREATE FUNCTION public.owner_staff_password(p_user uuid) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, extensions, pg_temp AS $$
DECLARE v text;
BEGIN
  PERFORM app.require_owner();
  IF (SELECT role FROM users WHERE id = p_user) = 'OWNER' THEN
    RAISE EXCEPTION 'Owner passwords are never stored' USING ERRCODE = 'WH002';
  END IF;
  SELECT decrypted_secret INTO v FROM vault.decrypted_secrets WHERE name = 'staff_pw:' || p_user;
  INSERT INTO audit_log(table_name, row_id, action, actor_id) VALUES ('public.users', p_user::text, 'VIEW_PASSWORD', app.current_user_id());
  RETURN v;
END$$;

CREATE OR REPLACE FUNCTION public.owner_list_users() RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, extensions, pg_temp AS $$
BEGIN
  PERFORM app.require_owner();
  RETURN (SELECT coalesce(jsonb_agg(row_to_json(t)::jsonb ORDER BY t.removed_at NULLS FIRST, t.role, t.full_name), '[]') FROM (
    SELECT u.id, u.login_id, u.full_name, u.phone, u.role, u.is_active, u.removed_at,
           u.primary_warehouse_id AS warehouse_id, w.code AS warehouse_code, w.name AS warehouse_name,
           (SELECT last_sign_in_at FROM auth.users au WHERE au.id = u.id) AS last_sign_in_at,
           EXISTS (SELECT 1 FROM secure.override_pins op WHERE op.user_id = u.id) AS has_override_pin,
           EXISTS (SELECT 1 FROM vault.secrets s WHERE s.name = 'staff_pw:' || u.id) AS has_saved_password,
           (SELECT jsonb_build_object('clock_in_at', a.clock_in_at, 'clock_out_at', a.clock_out_at)
              FROM attendance a WHERE a.user_id = u.id ORDER BY a.clock_in_at DESC LIMIT 1) AS last_shift
      FROM users u LEFT JOIN warehouses w ON w.id = u.primary_warehouse_id) t);
END$$;

-- ---------------------------------------------------------------- 5. ATTENDANCE
CREATE TABLE attendance (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id        uuid NOT NULL REFERENCES users(id),
  warehouse_id   uuid REFERENCES warehouses(id),
  work_date      date NOT NULL DEFAULT app.today_ist(),
  clock_in_at    timestamptz NOT NULL DEFAULT now(),
  clock_out_at   timestamptz,
  clock_in_note  text,
  clock_out_note text,
  edited_by      uuid REFERENCES users(id),
  CONSTRAINT attendance_out_after_in CHECK (clock_out_at IS NULL OR clock_out_at >= clock_in_at)
);
CREATE UNIQUE INDEX attendance_one_open_shift ON attendance(user_id) WHERE clock_out_at IS NULL;
CREATE INDEX attendance_user_date_idx ON attendance(user_id, work_date);
ALTER TABLE attendance ENABLE ROW LEVEL SECURITY;          -- RPC access only
REVOKE ALL ON attendance FROM PUBLIC, anon, authenticated;
CREATE TRIGGER audit_attendance AFTER UPDATE OR DELETE ON attendance FOR EACH ROW EXECUTE FUNCTION app.audit_row();

CREATE FUNCTION app.require_user() RETURNS uuid
LANGUAGE plpgsql STABLE SET search_path = public, extensions, pg_temp AS $$
DECLARE v uuid := app.current_user_id();
BEGIN
  IF v IS NULL THEN RAISE EXCEPTION 'Not signed in or account disabled' USING ERRCODE = 'WH002'; END IF;
  RETURN v;
END$$;

CREATE FUNCTION public.clock_in(p_note text DEFAULT NULL) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, extensions, pg_temp AS $$
DECLARE v_uid uuid := app.require_user(); v attendance;
BEGIN
  SELECT * INTO v FROM attendance WHERE user_id = v_uid AND clock_out_at IS NULL;
  IF FOUND THEN
    RAISE EXCEPTION 'Already clocked in since %', to_char(v.clock_in_at AT TIME ZONE 'Asia/Kolkata', 'DD-Mon HH12:MI AM')
      USING ERRCODE = 'WH005';
  END IF;
  INSERT INTO attendance(user_id, warehouse_id, clock_in_note)
  VALUES (v_uid, app.current_warehouse_id(), nullif(trim(p_note), '')) RETURNING * INTO v;
  RETURN to_jsonb(v);
END$$;

CREATE FUNCTION public.clock_out(p_note text DEFAULT NULL) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, extensions, pg_temp AS $$
DECLARE v_uid uuid := app.require_user(); v attendance;
BEGIN
  UPDATE attendance SET clock_out_at = now(), clock_out_note = nullif(trim(p_note), '')
   WHERE user_id = v_uid AND clock_out_at IS NULL RETURNING * INTO v;
  IF NOT FOUND THEN RAISE EXCEPTION 'You are not clocked in' USING ERRCODE = 'WH005'; END IF;
  RETURN to_jsonb(v);
END$$;

CREATE FUNCTION app.attendance_rows(p_user uuid, p_from date, p_to date) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, extensions, pg_temp AS $$
  SELECT coalesce(jsonb_agg(jsonb_build_object(
           'id', a.id, 'work_date', a.work_date, 'clock_in_at', a.clock_in_at, 'clock_out_at', a.clock_out_at,
           'hours', round(extract(epoch FROM (a.clock_out_at - a.clock_in_at)) / 3600.0, 2),
           'clock_in_note', a.clock_in_note, 'clock_out_note', a.clock_out_note, 'edited', a.edited_by IS NOT NULL)
         ORDER BY a.clock_in_at DESC), '[]')
    FROM attendance a WHERE a.user_id = p_user AND a.work_date BETWEEN p_from AND p_to
$$;

CREATE FUNCTION public.my_attendance(p_month date DEFAULT NULL) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, extensions, pg_temp AS $$
DECLARE v_uid uuid := app.require_user(); v_from date := date_trunc('month', coalesce(p_month, app.today_ist()))::date;
BEGIN
  RETURN jsonb_build_object(
    'open', (SELECT to_jsonb(a) FROM attendance a WHERE a.user_id = v_uid AND a.clock_out_at IS NULL),
    'days', app.attendance_rows(v_uid, v_from, (v_from + interval '1 month - 1 day')::date));
END$$;

-- Owner fixes a forgotten clock-out or a wrong time.
CREATE FUNCTION public.owner_fix_attendance(p_id uuid, p_in timestamptz, p_out timestamptz) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, extensions, pg_temp AS $$
BEGIN
  PERFORM app.require_owner();
  UPDATE attendance SET clock_in_at = coalesce(p_in, clock_in_at), clock_out_at = p_out,
                        work_date = (coalesce(p_in, clock_in_at) AT TIME ZONE 'Asia/Kolkata')::date,
                        edited_by = app.current_user_id()
   WHERE id = p_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Attendance entry not found' USING ERRCODE = 'WH005'; END IF;
END$$;

-- ---------------------------------------------------------------- 6. FIELD WORK
CREATE TABLE market_runs (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       uuid NOT NULL REFERENCES users(id),
  warehouse_id  uuid REFERENCES warehouses(id),
  run_date      date NOT NULL DEFAULT app.today_ist(),
  place         text NOT NULL CHECK (length(trim(place)) BETWEEN 2 AND 80),
  notes         text,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX market_runs_user_date_idx ON market_runs(user_id, run_date);

CREATE TABLE customer_visits (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id         uuid REFERENCES market_runs(id) ON DELETE CASCADE,
  user_id        uuid NOT NULL REFERENCES users(id),
  visit_date     date NOT NULL DEFAULT app.today_ist(),
  customer_name  text NOT NULL CHECK (length(trim(customer_name)) BETWEEN 2 AND 120),
  shop_name      text,
  phone          text,
  place          text,
  outcome        text NOT NULL DEFAULT 'FOLLOW_UP' CHECK (outcome IN ('ORDER', 'INTERESTED', 'FOLLOW_UP', 'NOT_INTERESTED')),
  notes          text,
  created_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX customer_visits_user_date_idx ON customer_visits(user_id, visit_date);
CREATE INDEX customer_visits_run_idx ON customer_visits(run_id);
ALTER TABLE market_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE customer_visits ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON market_runs, customer_visits FROM PUBLIC, anon, authenticated;

CREATE FUNCTION app.visit_json(v customer_visits) RETURNS jsonb
LANGUAGE sql IMMUTABLE SET search_path = public, extensions, pg_temp AS $$
  SELECT jsonb_build_object('id', v.id, 'run_id', v.run_id, 'visit_date', v.visit_date, 'customer_name', v.customer_name,
           'shop_name', v.shop_name, 'phone', v.phone, 'place', v.place, 'outcome', v.outcome, 'notes', v.notes,
           'created_at', v.created_at)
$$;

CREATE FUNCTION app.runs_json(p_user uuid, p_from date, p_to date) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, extensions, pg_temp AS $$
  SELECT coalesce(jsonb_agg(jsonb_build_object(
           'id', r.id, 'run_date', r.run_date, 'place', r.place, 'notes', r.notes, 'created_at', r.created_at,
           'visits', (SELECT coalesce(jsonb_agg(app.visit_json(v) ORDER BY v.created_at), '[]') FROM customer_visits v WHERE v.run_id = r.id))
         ORDER BY r.run_date DESC, r.created_at DESC), '[]')
    FROM market_runs r WHERE r.user_id = p_user AND r.run_date BETWEEN p_from AND p_to
$$;

CREATE FUNCTION app.insert_visits(p_user uuid, p_run uuid, p_date date, p_place text, p_visits jsonb) RETURNS void
LANGUAGE sql SECURITY DEFINER SET search_path = public, extensions, pg_temp AS $$
  INSERT INTO customer_visits(run_id, user_id, visit_date, customer_name, shop_name, phone, place, outcome, notes)
  SELECT p_run, p_user, p_date, trim(e->>'customerName'), nullif(trim(e->>'shopName'), ''),
         nullif(regexp_replace(coalesce(e->>'phone', ''), '\D', '', 'g'), ''),
         coalesce(nullif(trim(e->>'place'), ''), p_place),
         coalesce(nullif(e->>'outcome', ''), 'FOLLOW_UP'), nullif(trim(e->>'notes'), '')
    FROM jsonb_array_elements(coalesce(p_visits, '[]'::jsonb)) e
   WHERE coalesce(trim(e->>'customerName'), '') <> ''
$$;

/* p = { place, notes?, visits: [{ customerName, shopName?, phone?, outcome?, notes? }] } */
CREATE FUNCTION public.log_market_run(p jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, extensions, pg_temp AS $$
DECLARE v_uid uuid := app.require_user(); v market_runs;
BEGIN
  INSERT INTO market_runs(user_id, warehouse_id, place, notes)
  VALUES (v_uid, app.current_warehouse_id(), trim(p->>'place'), nullif(trim(p->>'notes'), '')) RETURNING * INTO v;
  PERFORM app.insert_visits(v_uid, v.id, v.run_date, v.place, p->'visits');
  RETURN app.runs_json(v_uid, v.run_date, v.run_date) -> 0;
END$$;

/* p = { runId?, customerName, shopName?, phone?, place?, outcome?, notes? } — a customer approached (with or without a run) */
CREATE FUNCTION public.add_customer_visit(p jsonb) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, extensions, pg_temp AS $$
DECLARE v_uid uuid := app.require_user(); v_run market_runs;
BEGIN
  IF nullif(p->>'runId', '') IS NOT NULL THEN
    SELECT * INTO v_run FROM market_runs WHERE id = (p->>'runId')::uuid AND user_id = v_uid;
    IF NOT FOUND THEN RAISE EXCEPTION 'Market run not found' USING ERRCODE = 'WH005'; END IF;
  END IF;
  IF coalesce(trim(p->>'customerName'), '') = '' THEN RAISE EXCEPTION 'Customer name is required' USING ERRCODE = 'WH005'; END IF;
  PERFORM app.insert_visits(v_uid, v_run.id, coalesce(v_run.run_date, app.today_ist()), v_run.place, jsonb_build_array(p));
END$$;

-- Staff may delete their own entries made today (typos); older entries are kept.
CREATE FUNCTION public.delete_my_field_entry(p_kind text, p_id uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, extensions, pg_temp AS $$
DECLARE v_uid uuid := app.require_user();
BEGIN
  IF p_kind = 'run' THEN
    DELETE FROM market_runs WHERE id = p_id AND user_id = v_uid AND (created_at >= app.today_ist_start() OR app.is_owner());
  ELSE
    DELETE FROM customer_visits WHERE id = p_id AND user_id = v_uid AND (created_at >= app.today_ist_start() OR app.is_owner());
  END IF;
  IF NOT FOUND THEN RAISE EXCEPTION 'Only today''s own entries can be deleted' USING ERRCODE = 'WH005'; END IF;
END$$;

CREATE FUNCTION public.my_field_month(p_month date DEFAULT NULL) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, extensions, pg_temp AS $$
DECLARE v_uid uuid := app.require_user(); v_from date := date_trunc('month', coalesce(p_month, app.today_ist()))::date;
        v_to date := (date_trunc('month', coalesce(p_month, app.today_ist())) + interval '1 month - 1 day')::date;
BEGIN
  RETURN jsonb_build_object(
    'runs', app.runs_json(v_uid, v_from, v_to),
    'loose_visits', (SELECT coalesce(jsonb_agg(app.visit_json(v) ORDER BY v.created_at DESC), '[]')
                       FROM customer_visits v WHERE v.user_id = v_uid AND v.run_id IS NULL AND v.visit_date BETWEEN v_from AND v_to));
END$$;

-- ---------------------------------------------------------------- 7. OWNER REPORTS
CREATE FUNCTION app.employee_month_stats(p_user uuid, p_from date, p_to date) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, extensions, pg_temp AS $$
  SELECT jsonb_build_object(
    'days_present', (SELECT count(DISTINCT work_date) FROM attendance WHERE user_id = p_user AND work_date BETWEEN p_from AND p_to),
    'hours', (SELECT coalesce(round(sum(extract(epoch FROM (clock_out_at - clock_in_at))) / 3600.0, 1), 0)
                FROM attendance WHERE user_id = p_user AND work_date BETWEEN p_from AND p_to AND clock_out_at IS NOT NULL),
    'missed_clock_outs', (SELECT count(*) FROM attendance WHERE user_id = p_user AND work_date BETWEEN p_from AND p_to
                            AND clock_out_at IS NULL AND work_date < app.today_ist()),
    'invoices', (SELECT count(*) FROM dispatches WHERE created_by = p_user AND status = 'POSTED' AND invoice_date BETWEEN p_from AND p_to),
    'sales', (SELECT coalesce(sum(taxable_total), 0) FROM dispatches WHERE created_by = p_user AND status = 'POSTED' AND invoice_date BETWEEN p_from AND p_to),
    'customers_billed', (SELECT count(DISTINCT customer_id) FROM dispatches WHERE created_by = p_user AND status = 'POSTED' AND invoice_date BETWEEN p_from AND p_to),
    'purchases_entered', (SELECT count(*) FROM purchases WHERE created_by = p_user AND status IN ('POSTED', 'PENDING') AND (created_at AT TIME ZONE 'Asia/Kolkata')::date BETWEEN p_from AND p_to),
    'market_runs', (SELECT count(*) FROM market_runs WHERE user_id = p_user AND run_date BETWEEN p_from AND p_to),
    'places', (SELECT count(DISTINCT lower(trim(place))) FROM market_runs WHERE user_id = p_user AND run_date BETWEEN p_from AND p_to),
    'customers_approached', (SELECT count(*) FROM customer_visits WHERE user_id = p_user AND visit_date BETWEEN p_from AND p_to),
    'orders_from_visits', (SELECT count(*) FROM customer_visits WHERE user_id = p_user AND visit_date BETWEEN p_from AND p_to AND outcome = 'ORDER'))
$$;

CREATE FUNCTION public.owner_employees_month(p_month date) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, extensions, pg_temp AS $$
DECLARE v_from date := date_trunc('month', p_month)::date; v_to date := (date_trunc('month', p_month) + interval '1 month - 1 day')::date;
BEGIN
  PERFORM app.require_owner();
  RETURN (SELECT coalesce(jsonb_agg(jsonb_build_object(
            'id', u.id, 'login_id', u.login_id, 'full_name', u.full_name, 'role', u.role, 'phone', u.phone,
            'is_active', u.is_active, 'removed_at', u.removed_at, 'warehouse_name', w.name,
            'clocked_in_since', (SELECT clock_in_at FROM attendance a WHERE a.user_id = u.id AND a.clock_out_at IS NULL),
            'stats', app.employee_month_stats(u.id, v_from, v_to)) ORDER BY u.removed_at NULLS FIRST, u.full_name), '[]')
            FROM users u LEFT JOIN warehouses w ON w.id = u.primary_warehouse_id
           WHERE u.role <> 'OWNER');
END$$;

CREATE FUNCTION public.owner_employee_month(p_user uuid, p_month date) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, extensions, pg_temp AS $$
DECLARE v_from date := date_trunc('month', p_month)::date; v_to date := (date_trunc('month', p_month) + interval '1 month - 1 day')::date;
BEGIN
  PERFORM app.require_owner();
  RETURN jsonb_build_object(
    'stats', app.employee_month_stats(p_user, v_from, v_to),
    'attendance', app.attendance_rows(p_user, v_from, v_to),
    'places', (SELECT coalesce(jsonb_agg(jsonb_build_object('place', x.place, 'runs', x.n, 'customers', x.c, 'last', x.last) ORDER BY x.n DESC, x.place), '[]')
                 FROM (SELECT min(r.place) AS place, count(DISTINCT r.id) AS n, max(r.run_date) AS last, count(v.id) AS c
                         FROM market_runs r LEFT JOIN customer_visits v ON v.run_id = r.id
                        WHERE r.user_id = p_user AND r.run_date BETWEEN v_from AND v_to
                        GROUP BY lower(trim(r.place))) x),
    'runs', app.runs_json(p_user, v_from, v_to),
    'customers', (SELECT coalesce(jsonb_agg(app.visit_json(v) ORDER BY v.visit_date DESC, v.created_at DESC), '[]')
                    FROM customer_visits v WHERE v.user_id = p_user AND v.visit_date BETWEEN v_from AND v_to),
    'sales', (SELECT coalesce(jsonb_agg(jsonb_build_object('id', d.id, 'invoice_no', d.invoice_no, 'invoice_date', d.invoice_date,
                                                          'customer_name', d.customer_name, 'taxable', d.taxable_total, 'total', d.grand_total)
                                        ORDER BY d.invoice_date DESC, d.invoice_no DESC), '[]')
                FROM dispatches d WHERE d.created_by = p_user AND d.status = 'POSTED' AND d.invoice_date BETWEEN v_from AND v_to),
    'trend', (SELECT coalesce(jsonb_agg(jsonb_build_object('month', m.m, 'stats',
                       app.employee_month_stats(p_user, m.m, (m.m + interval '1 month - 1 day')::date)) ORDER BY m.m), '[]')
                FROM (SELECT (date_trunc('month', p_month) - make_interval(months => g))::date AS m
                        FROM generate_series(0, 5) g) m));
END$$;

-- ---------------------------------------------------------------- grants
REVOKE EXECUTE ON FUNCTION
  public.owner_approve_purchase(uuid), public.owner_reject_purchase(uuid, text), public.owner_pending_purchases(),
  public.owner_save_product(jsonb), public.owner_product(uuid), public.owner_stock_history(uuid, uuid, int),
  public.owner_staff_password(uuid), public.clock_in(text), public.clock_out(text), public.my_attendance(date),
  public.owner_fix_attendance(uuid, timestamptz, timestamptz), public.log_market_run(jsonb), public.add_customer_visit(jsonb),
  public.delete_my_field_entry(text, uuid), public.my_field_month(date),
  public.owner_employees_month(date), public.owner_employee_month(uuid, date)
FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION
  public.owner_approve_purchase(uuid), public.owner_reject_purchase(uuid, text), public.owner_pending_purchases(),
  public.owner_save_product(jsonb), public.owner_product(uuid), public.owner_stock_history(uuid, uuid, int),
  public.owner_staff_password(uuid), public.clock_in(text), public.clock_out(text), public.my_attendance(date),
  public.owner_fix_attendance(uuid, timestamptz, timestamptz), public.log_market_run(jsonb), public.add_customer_visit(jsonb),
  public.delete_my_field_entry(text, uuid), public.my_field_month(date),
  public.owner_employees_month(date), public.owner_employee_month(uuid, date)
TO authenticated;
REVOKE EXECUTE ON FUNCTION app.movement_entered_by(text, uuid, uuid), app.attendance_rows(uuid, date, date),
  app.runs_json(uuid, date, date), app.insert_visits(uuid, uuid, date, text, jsonb), app.employee_month_stats(uuid, date, date),
  app.purchase_approval(), app.require_user(), app.visit_json(customer_visits)
FROM PUBLIC, anon, authenticated;

-- =============================================================================
-- api — the app's backend, as Postgres functions exposed by the Supabase Data
-- API (supabase.rpc('<name>', {...})). Replaces a separate API server.
--
--   Staff + owner RPCs   SECURITY INVOKER → RLS applies exactly as for direct
--                        table access; multi-table writes happen atomically.
--   owner_* RPCs         SECURITY DEFINER → first line is app.require_owner();
--                        the only door into fin.* (not exposed by the Data API).
--   wa_* RPCs            service_role only (WhatsApp Edge Functions).
--
-- Errors keep the SQLSTATEs the app understands: WH001 insufficient stock
-- (details = JSON array of shortfalls), WH002 forbidden, WH003 PIN locked,
-- WH005 validation. supabase-js surfaces them as error.code / .details.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- Internal helpers
-- ---------------------------------------------------------------------------
CREATE FUNCTION app.resolve_warehouse(p_requested uuid) RETURNS uuid
LANGUAGE plpgsql STABLE SET search_path = public, extensions, pg_temp AS $$
DECLARE v uuid;
BEGIN
  IF app.current_user_id() IS NULL THEN
    RAISE EXCEPTION 'Not signed in or account disabled' USING ERRCODE = 'WH002';
  END IF;
  IF app.is_owner() THEN
    IF p_requested IS NULL THEN
      RAISE EXCEPTION 'warehouseId is required for owner entries' USING ERRCODE = 'WH005';
    END IF;
    RETURN p_requested;
  END IF;
  v := app.current_warehouse_id();          -- staff: the body value is ignored
  IF v IS NULL THEN RAISE EXCEPTION 'No warehouse assigned to this user' USING ERRCODE = 'WH002'; END IF;
  RETURN v;
END$$;

-- All shortfalls for a set of lines (so the app can show every problem at once).
CREATE FUNCTION app.dispatch_shortfalls(p_wh uuid, p_lines jsonb) RETURNS jsonb
LANGUAGE sql STABLE SET search_path = public, extensions, pg_temp AS $$
  WITH req AS (
    SELECT (e->>'productId')::uuid AS product_id, sum((e->>'qty')::numeric * u.factor_to_base) AS requested
      FROM jsonb_array_elements(coalesce(p_lines, '[]'::jsonb)) e
      JOIN product_uoms u ON u.product_id = (e->>'productId')::uuid AND u.uom_code = e->>'uomCode'
     GROUP BY 1)
  SELECT coalesce(jsonb_agg(jsonb_build_object(
           'productId', r.product_id, 'productName', p.name,
           'availableBase', coalesce(il.qty_on_hand, 0), 'requestedBase', r.requested)), '[]'::jsonb)
    FROM req r
    JOIN products p ON p.id = r.product_id
    LEFT JOIN inventory_levels il ON il.warehouse_id = p_wh AND il.product_id = r.product_id
   WHERE r.requested > coalesce(il.qty_on_hand, 0)
$$;

CREATE FUNCTION app.dispatch_json(p_id uuid) RETURNS jsonb
LANGUAGE sql STABLE SET search_path = public, extensions, pg_temp AS $$
  SELECT jsonb_build_object(
    'id', d.id, 'invoice_no', d.invoice_no, 'invoice_date', d.invoice_date, 'warehouse_id', d.warehouse_id,
    'customer_name', d.customer_name, 'customer_gstin', d.customer_gstin, 'is_interstate', d.is_interstate,
    'transport_mode', d.transport_mode, 'transporter_name', d.transporter_name, 'vehicle_reg_no', d.vehicle_reg_no,
    'driver_phone', d.driver_phone, 'taxable_total', d.taxable_total, 'discount_total', d.discount_total,
    'cgst_total', d.cgst_total, 'sgst_total', d.sgst_total, 'igst_total', d.igst_total, 'grand_total', d.grand_total,
    'status', d.status, 'used_override', d.override_id IS NOT NULL, 'created_at', d.created_at,
    'lines', (SELECT coalesce(jsonb_agg(jsonb_build_object('line_no', i.line_no, 'name', p.name, 'uom', i.uom_code,
                'qty', i.qty, 'unit_final_price', i.unit_final_price, 'line_total', i.line_total) ORDER BY i.line_no), '[]')
                FROM dispatch_items i JOIN products p ON p.id = i.product_id WHERE i.dispatch_id = d.id))
  FROM dispatches d WHERE d.id = p_id
$$;

CREATE FUNCTION app.purchase_json(p_id uuid) RETURNS jsonb
LANGUAGE sql STABLE SET search_path = public, extensions, pg_temp AS $$
  SELECT jsonb_build_object(
    'id', p.id, 'warehouse_id', p.warehouse_id, 'vendor_name', p.vendor_name, 'vendor_gstin', p.vendor_gstin,
    'vendor_invoice_no', p.vendor_invoice_no, 'vendor_invoice_date', p.vendor_invoice_date, 'received_on', p.received_on,
    'is_interstate', p.is_interstate, 'taxable_total', p.taxable_total, 'cgst_total', p.cgst_total,
    'sgst_total', p.sgst_total, 'igst_total', p.igst_total, 'freight_amount', p.freight_amount,
    'grand_total', p.grand_total, 'status', p.status, 'created_at', p.created_at,
    'lines', (SELECT coalesce(jsonb_agg(jsonb_build_object('line_no', i.line_no, 'name', pr.name, 'uom', i.uom_code,
                'qty', i.qty, 'gst_rate', i.gst_rate, 'unit_base_price', i.unit_base_price, 'line_total', i.line_total)
                ORDER BY i.line_no), '[]')
                FROM purchase_items i JOIN products pr ON pr.id = i.product_id WHERE i.purchase_id = p.id))
  FROM purchases p WHERE p.id = p_id
$$;

-- =============================================================================
-- STAFF + OWNER RPCs (SECURITY INVOKER — RLS is the guard)
-- =============================================================================

CREATE FUNCTION public.me() RETURNS jsonb
LANGUAGE sql STABLE SET search_path = public, extensions, pg_temp AS $$
  SELECT jsonb_build_object('id', u.id, 'login_id', u.login_id, 'full_name', u.full_name, 'role', u.role,
           'warehouse_id', w.id, 'warehouse_code', w.code, 'warehouse_name', w.name, 'warehouse_state', w.state_code)
    FROM users u LEFT JOIN warehouses w ON w.id = u.primary_warehouse_id
   WHERE u.id = app.current_user_id()
$$;

-- Typo-tolerant search over name, brand, category, spec, SKU and vernacular aliases.
-- qty_on_hand = own warehouse for staff, all warehouses for owners.
CREATE FUNCTION public.search_items(q text DEFAULT '', lim int DEFAULT 25, brand_id uuid DEFAULT NULL, category_id uuid DEFAULT NULL)
RETURNS jsonb
LANGUAGE sql STABLE SET search_path = public, extensions, pg_temp AS $$
  SELECT coalesce(jsonb_agg(jsonb_build_object(
      'id', s.id, 'sku_code', s.sku_code, 'name', s.name, 'brand', s.brand, 'category_path', s.category_path,
      'specification', s.specification, 'hsn_code', s.hsn_code, 'default_gst_rate', s.default_gst_rate,
      'default_selling_price', pr.default_selling_price, 'mrp', pr.mrp, 'score', s.score,
      'image_path', (SELECT storage_key FROM product_images i WHERE i.product_id = s.id AND i.is_primary),
      'aliases', (SELECT jsonb_agg(alias) FROM product_aliases a WHERE a.product_id = s.id),
      'uoms', (SELECT jsonb_agg(jsonb_build_object('code', u.uom_code, 'factor', u.factor_to_base, 'displayName', u.display_name)
                               ORDER BY u.factor_to_base DESC) FROM product_uoms u WHERE u.product_id = s.id),
      'qty_on_hand', (SELECT coalesce(sum(il.qty_on_hand), 0) FROM inventory_levels il WHERE il.product_id = s.id))
    ORDER BY s.ord), '[]'::jsonb)
  FROM (SELECT x.*, row_number() OVER () AS ord FROM app.search_products(q, lim, brand_id, category_id) x) s
  JOIN products pr ON pr.id = s.id
$$;

CREATE FUNCTION public.catalog_tree() RETURNS jsonb
LANGUAGE sql STABLE SET search_path = public, extensions, pg_temp AS $$
  SELECT jsonb_build_object(
    'brands', (SELECT coalesce(jsonb_agg(jsonb_build_object('id', id, 'name', name) ORDER BY name), '[]') FROM brands WHERE is_active),
    'categories', (SELECT coalesce(jsonb_agg(jsonb_build_object('id', id, 'parent_id', parent_id, 'name', name, 'path', path)
                     ORDER BY sort_order, name), '[]') FROM categories WHERE is_active))
$$;

-- Physical counts only (no cost/value). Staff: own warehouse (RLS).
CREATE FUNCTION public.stock_list(p_warehouse uuid DEFAULT NULL, p_low_only boolean DEFAULT false) RETURNS jsonb
LANGUAGE sql STABLE SET search_path = public, extensions, pg_temp AS $$
  SELECT coalesce(jsonb_agg(row_to_json(t)::jsonb ORDER BY t.name), '[]'::jsonb) FROM (
    SELECT il.warehouse_id, p.id AS product_id, p.sku_code, p.name, b.name AS brand, c.path AS category_path,
           p.specification, il.qty_on_hand, il.qty_in_transit,
           coalesce(rr.min_qty_base, p.default_reorder_level) AS reorder_level,
           il.qty_on_hand <= coalesce(rr.min_qty_base, p.default_reorder_level) AS is_low,
           (SELECT json_agg(json_build_object('code', u.uom_code, 'factor', u.factor_to_base) ORDER BY u.factor_to_base DESC)
              FROM product_uoms u WHERE u.product_id = p.id) AS uoms
      FROM inventory_levels il
      JOIN products p ON p.id = il.product_id
      LEFT JOIN brands b ON b.id = p.brand_id
      LEFT JOIN categories c ON c.id = p.category_id
      LEFT JOIN reorder_rules rr ON rr.warehouse_id = il.warehouse_id AND rr.product_id = il.product_id
     WHERE (p_warehouse IS NULL OR il.warehouse_id = p_warehouse)
       AND (NOT p_low_only OR il.qty_on_hand <= coalesce(rr.min_qty_base, p.default_reorder_level))) t
$$;

CREATE FUNCTION public.add_product_alias(p_product uuid, p_alias text, p_language text DEFAULT NULL) RETURNS void
LANGUAGE sql SET search_path = public, extensions, pg_temp AS $$
  INSERT INTO product_aliases(product_id, alias, language) VALUES (p_product, trim(p_alias), p_language)
  ON CONFLICT (product_id, lower(alias)) DO NOTHING
$$;

-- ---------------------------------------------------------------- Admin Override PIN
-- Returns {ok:false} instead of raising on a wrong PIN so the attempt row is
-- committed (5 wrong / 15 min ⇒ WH003 lock).
CREATE FUNCTION public.request_stock_override(p_pin text, p_reason text, p_warehouse uuid DEFAULT NULL) RETURNS jsonb
LANGUAGE plpgsql SET search_path = public, extensions, pg_temp AS $$
DECLARE v_id uuid;
BEGIN
  v_id := app.request_stock_override(p_pin, app.resolve_warehouse(p_warehouse), p_reason);
  RETURN CASE WHEN v_id IS NULL THEN jsonb_build_object('ok', false, 'code', 'INVALID_PIN')
              ELSE jsonb_build_object('ok', true, 'overrideId', v_id, 'expiresInSeconds', 600) END;
END$$;

-- ---------------------------------------------------------------- OUTWARD
CREATE FUNCTION public.check_dispatch(p jsonb) RETURNS jsonb
LANGUAGE sql STABLE SET search_path = public, extensions, pg_temp AS $$
  SELECT jsonb_build_object('shortfalls',
           app.dispatch_shortfalls(app.resolve_warehouse((p->>'warehouseId')::uuid), p->'lines'))
$$;

/* p = { clientTxnId, warehouseId?, customerId, salesAgentId?, invoiceDate?, transportMode,
         transporterName?, vehicleRegNo?, driverPhone?, lrNumber?, ewayBillNo?, overrideId?,
         lines: [{ productId, uomCode, qty, unitBasePrice, discountPct?, gstRate? }] } */
CREATE FUNCTION public.create_dispatch(p jsonb) RETURNS jsonb
LANGUAGE plpgsql SET search_path = public, extensions, pg_temp AS $$
DECLARE v_id uuid; v_wh uuid; v_short jsonb;
BEGIN
  SELECT id INTO v_id FROM dispatches WHERE client_txn_id = (p->>'clientTxnId')::uuid;
  IF FOUND THEN RETURN jsonb_build_object('replayed', true, 'dispatch', app.dispatch_json(v_id)); END IF;

  v_wh := app.resolve_warehouse((p->>'warehouseId')::uuid);
  IF jsonb_array_length(coalesce(p->'lines', '[]'::jsonb)) = 0 THEN
    RAISE EXCEPTION 'A dispatch needs at least one item' USING ERRCODE = 'WH005';
  END IF;
  IF p->>'overrideId' IS NULL THEN
    v_short := app.dispatch_shortfalls(v_wh, p->'lines');
    IF jsonb_array_length(v_short) > 0 THEN
      RAISE EXCEPTION 'Quantity exceeds physical stock in this warehouse' USING ERRCODE = 'WH001',
        DETAIL = v_short::text, HINT = 'Provide an Admin Override PIN to dispatch beyond physical stock.';
    END IF;
  END IF;

  INSERT INTO dispatches(client_txn_id, warehouse_id, customer_id, sales_agent_id, invoice_no, invoice_date, fy,
                         place_of_supply, is_interstate, transport_mode, transporter_name, vehicle_reg_no,
                         driver_phone, lr_number, eway_bill_no, override_id)
  VALUES ((p->>'clientTxnId')::uuid, v_wh, (p->>'customerId')::uuid, (p->>'salesAgentId')::uuid,
          NULL, coalesce((p->>'invoiceDate')::date, app.today_ist()), '', NULL, false,       -- set by trigger
          (p->>'transportMode')::transport_mode, p->>'transporterName', p->>'vehicleRegNo', p->>'driverPhone',
          p->>'lrNumber', p->>'ewayBillNo', (p->>'overrideId')::uuid)
  RETURNING id INTO v_id;

  INSERT INTO dispatch_items(dispatch_id, line_no, product_id, uom_code, conversion_factor, qty,
                             unit_base_price, discount_pct, gst_rate)
  SELECT v_id, e.ord, (e.j->>'productId')::uuid, e.j->>'uomCode', 1, (e.j->>'qty')::numeric,
         (e.j->>'unitBasePrice')::numeric, coalesce((e.j->>'discountPct')::numeric, 0), (e.j->>'gstRate')::numeric
    FROM jsonb_array_elements(p->'lines') WITH ORDINALITY AS e(j, ord);

  SET CONSTRAINTS ALL IMMEDIATE;          -- run totals + WhatsApp enqueue now so we can return them
  RETURN jsonb_build_object('replayed', false, 'dispatch', app.dispatch_json(v_id));
END$$;

-- ---------------------------------------------------------------- INWARD
/* p = { clientTxnId, warehouseId?, vendorId, vendorInvoiceNo, vendorInvoiceDate, lorryReceiptNo?,
         freightAmount?, attachments?: [{ kind, storagePath, mimeType }],
         lines: [{ productId, uomCode, qty, gstRate, unitBasePrice, unitInclPrice, hsnCode? }] } */
CREATE FUNCTION public.create_purchase(p jsonb) RETURNS jsonb
LANGUAGE plpgsql SET search_path = public, extensions, pg_temp AS $$
DECLARE v_id uuid; v_wh uuid;
BEGIN
  SELECT id INTO v_id FROM purchases WHERE client_txn_id = (p->>'clientTxnId')::uuid;
  IF FOUND THEN RETURN jsonb_build_object('replayed', true, 'purchase', app.purchase_json(v_id)); END IF;

  v_wh := app.resolve_warehouse((p->>'warehouseId')::uuid);
  IF jsonb_array_length(coalesce(p->'lines', '[]'::jsonb)) = 0 THEN
    RAISE EXCEPTION 'A purchase needs at least one item' USING ERRCODE = 'WH005';
  END IF;

  INSERT INTO purchases(client_txn_id, warehouse_id, vendor_id, vendor_name, vendor_invoice_no,
                        vendor_invoice_date, lorry_receipt_no, freight_amount, is_interstate)
  VALUES ((p->>'clientTxnId')::uuid, v_wh, (p->>'vendorId')::uuid, NULL, p->>'vendorInvoiceNo',
          (p->>'vendorInvoiceDate')::date, p->>'lorryReceiptNo', coalesce((p->>'freightAmount')::numeric, 0), false)
  RETURNING id INTO v_id;

  INSERT INTO purchase_items(purchase_id, line_no, product_id, uom_code, conversion_factor, qty,
                             hsn_code, gst_rate, unit_base_price, unit_incl_price)
  SELECT v_id, e.ord, (e.j->>'productId')::uuid, e.j->>'uomCode', 1, (e.j->>'qty')::numeric, e.j->>'hsnCode',
         (e.j->>'gstRate')::numeric, (e.j->>'unitBasePrice')::numeric, (e.j->>'unitInclPrice')::numeric
    FROM jsonb_array_elements(p->'lines') WITH ORDINALITY AS e(j, ord);

  INSERT INTO purchase_attachments(purchase_id, kind, storage_key, mime_type)
  SELECT v_id, a->>'kind', a->>'storagePath', a->>'mimeType'
    FROM jsonb_array_elements(coalesce(p->'attachments', '[]'::jsonb)) a;

  SET CONSTRAINTS ALL IMMEDIATE;
  RETURN jsonb_build_object('replayed', false, 'purchase', app.purchase_json(v_id));
END$$;

-- ---------------------------------------------------------------- TRANSFERS
/* p = { clientTxnId, fromWarehouseId?, toWarehouseId, vehicleRegNo?, driverPhone?, ewayBillNo?, remarks?,
         dispatchNow? (default true), overrideId?, lines: [{ productId, uomCode, qty }] } */
CREATE FUNCTION public.create_transfer(p jsonb) RETURNS jsonb
LANGUAGE plpgsql SET search_path = public, extensions, pg_temp AS $$
DECLARE v_id uuid;
BEGIN
  SELECT id INTO v_id FROM transfer_notes WHERE client_txn_id = (p->>'clientTxnId')::uuid;
  IF NOT FOUND THEN
    INSERT INTO transfer_notes(client_txn_id, note_no, from_warehouse_id, to_warehouse_id,
                               vehicle_reg_no, driver_phone, eway_bill_no, remarks)
    VALUES ((p->>'clientTxnId')::uuid, NULL, app.resolve_warehouse((p->>'fromWarehouseId')::uuid),
            (p->>'toWarehouseId')::uuid, p->>'vehicleRegNo', p->>'driverPhone', p->>'ewayBillNo', p->>'remarks')
    RETURNING id INTO v_id;
    INSERT INTO transfer_note_items(transfer_note_id, line_no, product_id, uom_code, conversion_factor, qty)
    SELECT v_id, e.ord, (e.j->>'productId')::uuid, e.j->>'uomCode', 1, (e.j->>'qty')::numeric
      FROM jsonb_array_elements(p->'lines') WITH ORDINALITY AS e(j, ord);
    IF coalesce((p->>'dispatchNow')::boolean, true) THEN
      PERFORM app.dispatch_transfer(v_id, (p->>'overrideId')::uuid);
    END IF;
  END IF;
  RETURN (SELECT jsonb_build_object('id', id, 'note_no', note_no, 'status', status) FROM transfer_notes WHERE id = v_id);
END$$;

CREATE FUNCTION public.dispatch_transfer(p_note uuid, p_override uuid DEFAULT NULL) RETURNS void
LANGUAGE sql SET search_path = public, extensions, pg_temp AS $$ SELECT app.dispatch_transfer(p_note, p_override) $$;

-- p_lines: [{ lineNo, qtyReceivedBase }] — omit for "received in full".
CREATE FUNCTION public.receive_transfer(p_note uuid, p_lines jsonb DEFAULT NULL) RETURNS void
LANGUAGE sql SET search_path = public, extensions, pg_temp AS $$
  SELECT app.receive_transfer(p_note, (
    SELECT jsonb_agg(jsonb_build_object('line_no', (e->>'lineNo')::int, 'qty_received_base', (e->>'qtyReceivedBase')::numeric))
      FROM jsonb_array_elements(p_lines) e))
$$;

CREATE FUNCTION public.list_transfers(p_status text DEFAULT NULL) RETURNS jsonb
LANGUAGE sql STABLE SET search_path = public, extensions, pg_temp AS $$
  SELECT coalesce(jsonb_agg(row_to_json(t)::jsonb ORDER BY t.created_at DESC), '[]'::jsonb) FROM (
    SELECT n.id, n.note_no, n.status, n.from_warehouse_id, fw.code AS from_code, n.to_warehouse_id, tw.code AS to_code,
           n.vehicle_reg_no, n.created_at, n.dispatched_at, n.received_at,
           (SELECT json_agg(json_build_object('line_no', i.line_no, 'product_id', i.product_id, 'name', p.name,
                      'uom', i.uom_code, 'qty', i.qty, 'qty_base', i.qty_base, 'qty_received_base', i.qty_received_base)
                      ORDER BY i.line_no)
              FROM transfer_note_items i JOIN products p ON p.id = i.product_id WHERE i.transfer_note_id = n.id) AS lines
      FROM transfer_notes n
      JOIN warehouses fw ON fw.id = n.from_warehouse_id
      JOIN warehouses tw ON tw.id = n.to_warehouse_id
     WHERE p_status IS NULL OR n.status::text = p_status
     ORDER BY n.created_at DESC LIMIT 100) t
$$;

-- "My Day": own entries from today (that is all RLS returns to staff anyway).
CREATE FUNCTION public.my_day() RETURNS jsonb
LANGUAGE sql STABLE SET search_path = public, extensions, pg_temp AS $$
  SELECT jsonb_build_object(
    'dispatches', (SELECT coalesce(jsonb_agg(app.dispatch_json(id) ORDER BY created_at DESC), '[]') FROM dispatches
                    WHERE created_by = app.current_user_id() AND created_at >= app.today_ist_start()),
    'purchases',  (SELECT coalesce(jsonb_agg(app.purchase_json(id) ORDER BY created_at DESC), '[]') FROM purchases
                    WHERE created_by = app.current_user_id() AND created_at >= app.today_ist_start()))
$$;

-- =============================================================================
-- OWNER RPCs (SECURITY DEFINER — each starts with app.require_owner())
-- =============================================================================

CREATE FUNCTION public.owner_stock_overview(p_warehouse uuid DEFAULT NULL) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, fin, extensions, pg_temp AS $$
BEGIN
  PERFORM app.require_owner();
  RETURN jsonb_build_object(
    'warehouses', (SELECT coalesce(jsonb_agg(row_to_json(w)::jsonb ORDER BY w.warehouse_code), '[]') FROM (
        SELECT warehouse_id, warehouse_code, warehouse_name, sum(valuation) AS valuation,
               count(*) FILTER (WHERE qty_on_hand > 0) AS skus_in_stock
          FROM fin.v_stock_overview GROUP BY 1, 2, 3) w),
    'items', (SELECT coalesce(jsonb_agg(row_to_json(i)::jsonb ORDER BY i.name), '[]') FROM (
        SELECT product_id AS "productId", sku_code AS sku, name, brand, category_path AS category,
               max(avg_effective_cost_base) AS "avgCost", sum(qty_on_hand) AS "totalQty", sum(valuation) AS "totalValue",
               jsonb_object_agg(warehouse_code, qty_on_hand) AS "perWarehouse"
          FROM fin.v_stock_overview
         WHERE p_warehouse IS NULL OR warehouse_id = p_warehouse
         GROUP BY product_id, sku_code, name, brand, category_path) i));
END$$;

CREATE FUNCTION public.owner_reorder_alerts() RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, fin, extensions, pg_temp AS $$
BEGIN
  PERFORM app.require_owner();
  RETURN (SELECT coalesce(jsonb_agg(row_to_json(a)::jsonb
            ORDER BY a.qty_on_hand / nullif(a.threshold, 0), a.warehouse_code, a.name), '[]')
            FROM fin.v_reorder_alerts a);
END$$;

CREATE FUNCTION public.owner_create_purchase_orders(p_warehouse uuid, p_products uuid[]) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, fin, extensions, pg_temp AS $$
BEGIN
  PERFORM app.require_owner();
  RETURN jsonb_build_object('purchaseOrderIds',
    (SELECT coalesce(jsonb_agg(id), '[]') FROM fin.create_po_from_reorder(p_warehouse, p_products) AS id));
END$$;

CREATE FUNCTION public.owner_sales_trend(p_from date, p_to date, p_granularity text DEFAULT 'day', p_warehouse uuid DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, fin, extensions, pg_temp AS $$
BEGIN
  PERFORM app.require_owner();
  IF p_granularity NOT IN ('day', 'month') THEN RAISE EXCEPTION 'granularity must be day or month' USING ERRCODE = 'WH005'; END IF;
  RETURN (SELECT coalesce(jsonb_agg(row_to_json(t)::jsonb ORDER BY t.bucket, t.warehouse_code), '[]') FROM (
    SELECT date_trunc(p_granularity, invoice_date)::date AS bucket, warehouse_code,
           sum(invoices) AS invoices, sum(units_base) AS units, sum(revenue_excl_gst) AS revenue_excl_gst,
           sum(revenue_incl_gst) AS revenue_incl_gst, sum(gross_margin) AS gross_margin
      FROM fin.v_sales_daily
     WHERE invoice_date BETWEEN p_from AND p_to AND (p_warehouse IS NULL OR warehouse_id = p_warehouse)
     GROUP BY 1, 2) t);
END$$;

CREATE FUNCTION public.owner_top_items(p_from date, p_to date, p_warehouse uuid DEFAULT NULL, p_limit int DEFAULT 10) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, fin, extensions, pg_temp AS $$
BEGIN
  PERFORM app.require_owner();
  RETURN (SELECT coalesce(jsonb_agg(row_to_json(t)::jsonb), '[]')
            FROM fin.top_selling_items(p_from, p_to, p_warehouse, least(greatest(p_limit, 1), 100)) t);
END$$;

CREATE FUNCTION public.owner_margins(p_from date, p_to date, p_warehouse uuid DEFAULT NULL) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, fin, extensions, pg_temp AS $$
BEGIN
  PERFORM app.require_owner();
  RETURN (SELECT coalesce(jsonb_agg(row_to_json(t)::jsonb), '[]') FROM fin.margin_spread(p_from, p_to, p_warehouse) t);
END$$;

CREATE FUNCTION public.owner_dead_stock(p_days int DEFAULT 45, p_warehouse uuid DEFAULT NULL) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, fin, extensions, pg_temp AS $$
BEGIN
  PERFORM app.require_owner();
  RETURN (SELECT coalesce(jsonb_agg(row_to_json(t)::jsonb), '[]') FROM fin.dead_stock(p_days, p_warehouse) t);
END$$;

CREATE FUNCTION public.owner_staff_performance(p_from date, p_to date) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, fin, extensions, pg_temp AS $$
BEGIN
  PERFORM app.require_owner();
  RETURN jsonb_build_object(
    'staff', (SELECT coalesce(jsonb_agg(row_to_json(t)::jsonb), '[]') FROM fin.employee_performance(p_from, p_to) t),
    'salesAgents', (SELECT coalesce(jsonb_agg(row_to_json(t)::jsonb), '[]') FROM fin.sales_agent_performance(p_from, p_to) t),
    'dailyByUser', (SELECT coalesce(jsonb_agg(row_to_json(t)::jsonb ORDER BY t.invoice_date), '[]') FROM (
        SELECT invoice_date, created_by AS user_id, count(DISTINCT dispatch_id) AS invoices, sum(line_taxable) AS revenue
          FROM fin.v_sales_lines WHERE invoice_date BETWEEN p_from AND p_to GROUP BY 1, 2) t));
END$$;

CREATE FUNCTION public.owner_customer_ledger(p_customer uuid) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, fin, extensions, pg_temp AS $$
BEGIN
  PERFORM app.require_owner();
  RETURN (SELECT coalesce(jsonb_agg(row_to_json(l)::jsonb ORDER BY l.entry_date, l.created_at), '[]')
            FROM fin.v_customer_ledger l WHERE l.customer_id = p_customer);
END$$;

CREATE FUNCTION public.owner_purchases_net(p_from date, p_to date, p_warehouse uuid DEFAULT NULL) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, fin, extensions, pg_temp AS $$
BEGIN
  PERFORM app.require_owner();
  RETURN (SELECT coalesce(jsonb_agg(row_to_json(n)::jsonb ORDER BY n.vendor_invoice_date DESC), '[]')
            FROM fin.v_purchase_net_summary n
           WHERE n.vendor_invoice_date BETWEEN p_from AND p_to AND (p_warehouse IS NULL OR n.warehouse_id = p_warehouse));
END$$;

-- Owner-private extra vendor discount (PERCENT of billed value, or AMOUNT ₹).
CREATE FUNCTION public.owner_set_purchase_discount(p_purchase uuid, p_type text, p_value numeric, p_reason text DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, fin, extensions, pg_temp AS $$
BEGIN
  PERFORM app.require_owner();
  INSERT INTO fin.purchase_discounts(purchase_id, discount_type, discount_value, reason, entered_by)
  VALUES (p_purchase, p_type, p_value, p_reason, app.current_user_id())
  ON CONFLICT (purchase_id) DO UPDATE SET discount_type = EXCLUDED.discount_type, discount_value = EXCLUDED.discount_value,
    reason = EXCLUDED.reason, entered_by = EXCLUDED.entered_by, entered_at = now();
  RETURN (SELECT row_to_json(n)::jsonb FROM fin.v_purchase_net_summary n WHERE n.purchase_id = p_purchase);
END$$;

CREATE FUNCTION public.owner_adjust_stock(p_warehouse uuid, p_product uuid, p_movement text, p_qty_delta_base numeric, p_notes text DEFAULT NULL)
RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, fin, extensions, pg_temp AS $$
DECLARE v_id uuid;
BEGIN
  PERFORM app.require_owner();
  INSERT INTO stock_adjustments(warehouse_id, product_id, movement, qty_delta_base, notes)
  VALUES (p_warehouse, p_product, p_movement::movement_type, p_qty_delta_base, p_notes) RETURNING id INTO v_id;
  RETURN v_id;
END$$;

CREATE FUNCTION public.owner_cancel_dispatch(p_id uuid, p_reason text) RETURNS void
LANGUAGE sql SECURITY DEFINER SET search_path = public, extensions, pg_temp AS $$ SELECT app.cancel_dispatch(p_id, p_reason) $$;

CREATE FUNCTION public.owner_cancel_purchase(p_id uuid, p_reason text) RETURNS void
LANGUAGE sql SECURITY DEFINER SET search_path = public, extensions, pg_temp AS $$ SELECT app.cancel_purchase(p_id, p_reason) $$;

CREATE FUNCTION public.owner_set_override_pin(p_pin text) RETURNS void
LANGUAGE sql SECURITY DEFINER SET search_path = public, extensions, pg_temp AS $$ SELECT app.set_override_pin(p_pin) $$;

CREATE FUNCTION public.owner_list_users() RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, extensions, pg_temp AS $$
BEGIN
  PERFORM app.require_owner();
  RETURN (SELECT coalesce(jsonb_agg(row_to_json(t)::jsonb ORDER BY t.role, t.full_name), '[]') FROM (
    SELECT u.id, u.login_id, u.full_name, u.phone, u.role, u.is_active, w.code AS warehouse_code,
           (SELECT last_sign_in_at FROM auth.users au WHERE au.id = u.id) AS last_sign_in_at,
           EXISTS (SELECT 1 FROM secure.override_pins op WHERE op.user_id = u.id) AS has_override_pin
      FROM users u LEFT JOIN warehouses w ON w.id = u.primary_warehouse_id) t);
END$$;

-- Role / warehouse / active flag. Logins & passwords are created by the admin-users Edge Function.
CREATE FUNCTION public.owner_update_user(p_user uuid, p_is_active boolean DEFAULT NULL, p_warehouse uuid DEFAULT NULL, p_role text DEFAULT NULL)
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, extensions, pg_temp AS $$
BEGIN
  PERFORM app.require_owner();
  IF p_user = app.current_user_id() AND (p_is_active = false OR p_role = 'EMPLOYEE') THEN
    RAISE EXCEPTION 'You cannot deactivate or demote yourself' USING ERRCODE = 'WH005';
  END IF;
  UPDATE users SET is_active = coalesce(p_is_active, is_active),
                   primary_warehouse_id = coalesce(p_warehouse, primary_warehouse_id),
                   role = coalesce(p_role::user_role, role)
   WHERE id = p_user;
END$$;

-- WhatsApp delivery status, for the owner's settings screen.
CREATE FUNCTION public.owner_notifications(p_limit int DEFAULT 50) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, extensions, pg_temp AS $$
BEGIN
  PERFORM app.require_owner();
  RETURN (SELECT coalesce(jsonb_agg(row_to_json(t)::jsonb ORDER BY t.id DESC), '[]') FROM (
    SELECT id, event_type, dedupe_key, status, attempts, last_error, created_at, sent_at, delivered_at
      FROM notification_outbox ORDER BY id DESC LIMIT least(p_limit, 200)) t);
END$$;

-- =============================================================================
-- WhatsApp worker RPCs (service_role only — called by Edge Functions)
-- =============================================================================
CREATE FUNCTION public.wa_claim_outbox(p_batch int DEFAULT 20) RETURNS jsonb
LANGUAGE sql SECURITY DEFINER SET search_path = public, extensions, pg_temp AS $$
  WITH c AS (
    UPDATE notification_outbox SET status = 'SENDING', attempts = attempts + 1, next_attempt_at = now()
     WHERE id IN (SELECT id FROM notification_outbox
                   WHERE (status IN ('PENDING','FAILED') AND next_attempt_at <= now())
                      OR (status = 'SENDING' AND next_attempt_at < now() - interval '10 minutes')   -- crashed run
                   ORDER BY id LIMIT p_batch FOR UPDATE SKIP LOCKED)
    RETURNING id, event_type, aggregate_id, payload, attempts)
  SELECT coalesce(jsonb_agg(row_to_json(c)::jsonb ORDER BY c.id), '[]') FROM c
$$;

CREATE FUNCTION public.wa_mark_sent(p_id bigint, p_message_id text, p_sent_to jsonb) RETURNS void
LANGUAGE sql SECURITY DEFINER SET search_path = public, extensions, pg_temp AS $$
  UPDATE notification_outbox SET status = 'SENT', sent_at = now(), last_error = NULL,
         provider_message_id = coalesce(p_message_id, provider_message_id),
         payload = payload || jsonb_build_object('sent_to', p_sent_to)
   WHERE id = p_id
$$;

CREATE FUNCTION public.wa_mark_failed(p_id bigint, p_error text, p_dead boolean, p_sent_to jsonb) RETURNS void
LANGUAGE sql SECURITY DEFINER SET search_path = public, extensions, pg_temp AS $$
  UPDATE notification_outbox SET status = CASE WHEN p_dead THEN 'DEAD'::outbox_status ELSE 'FAILED'::outbox_status END,
         last_error = left(p_error, 500),
         next_attempt_at = now() + make_interval(mins => least(power(2, attempts)::int, 240)),
         payload = payload || jsonb_build_object('sent_to', p_sent_to)
   WHERE id = p_id
$$;

CREATE FUNCTION public.wa_status_update(p_message_id text, p_status text, p_error text DEFAULT NULL) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, extensions, pg_temp AS $$
BEGIN
  IF p_status IN ('delivered', 'read') THEN
    UPDATE notification_outbox SET status = 'DELIVERED', delivered_at = coalesce(delivered_at, now())
     WHERE provider_message_id = p_message_id;
  ELSIF p_status = 'failed' THEN
    UPDATE notification_outbox SET status = 'FAILED', last_error = p_error, next_attempt_at = now() + interval '5 minutes'
     WHERE provider_message_id = p_message_id AND status <> 'DELIVERED';
  END IF;
END$$;

CREATE FUNCTION public.wa_dispatch_payload(p_dispatch uuid) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, extensions, pg_temp AS $$
  SELECT jsonb_build_object(
    'warehouse_name', w.name, 'customer_name', d.customer_name, 'invoice_no', d.invoice_no,
    'customer_gstin', d.customer_gstin, 'agent_name', a.name, 'taxable_total', d.taxable_total,
    'grand_total', d.grand_total, 'transport_mode', d.transport_mode, 'transporter_name', d.transporter_name,
    'vehicle_reg_no', d.vehicle_reg_no, 'driver_phone', d.driver_phone,
    'items', (SELECT coalesce(jsonb_agg(jsonb_build_object('name', p.name, 'qty', i.qty, 'uom', i.uom_code) ORDER BY i.line_no), '[]')
                FROM dispatch_items i JOIN products p ON p.id = i.product_id WHERE i.dispatch_id = d.id))
  FROM dispatches d JOIN warehouses w ON w.id = d.warehouse_id LEFT JOIN sales_agents a ON a.id = d.sales_agent_id
  WHERE d.id = p_dispatch
$$;

CREATE FUNCTION public.wa_eod_payload(p_date date) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, fin, extensions, pg_temp AS $$ SELECT fin.eod_digest(p_date) $$;

-- Called by pg_cron at 20:30 IST. Exactly one digest per day (dedupe_key).
CREATE FUNCTION app.enqueue_eod_digest() RETURNS void
LANGUAGE sql SECURITY DEFINER SET search_path = public, extensions, pg_temp AS $$
  INSERT INTO notification_outbox(event_type, dedupe_key, payload)
  VALUES ('EOD_DIGEST', 'eod:' || app.today_ist(), jsonb_build_object('date', app.today_ist()))
  ON CONFLICT (dedupe_key) DO NOTHING
$$;

-- =============================================================================
-- Function privileges — explicit allow-list
-- =============================================================================
REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA public FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA app    FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION
  app.today_ist(), app.today_ist_start(), app.fy_label(date), app.gstin_valid(text), app.gstin_state(text),
  app.norm(text), app.current_user_id(), app.current_app_role(), app.is_owner(), app.current_warehouse_id(),
  app.require_owner(), app.require_warehouse(uuid), app.search_products(text, int, uuid, uuid),
  app.resolve_warehouse(uuid), app.dispatch_shortfalls(uuid, jsonb), app.dispatch_json(uuid), app.purchase_json(uuid),
  app.request_stock_override(text, uuid, text), app.dispatch_transfer(uuid, uuid), app.receive_transfer(uuid, jsonb)
TO authenticated;

GRANT EXECUTE ON FUNCTION
  public.me(), public.search_items(text, int, uuid, uuid), public.catalog_tree(), public.stock_list(uuid, boolean),
  public.add_product_alias(uuid, text, text), public.request_stock_override(text, text, uuid),
  public.check_dispatch(jsonb), public.create_dispatch(jsonb), public.create_purchase(jsonb),
  public.create_transfer(jsonb), public.dispatch_transfer(uuid, uuid), public.receive_transfer(uuid, jsonb),
  public.list_transfers(text), public.my_day(),
  public.owner_stock_overview(uuid), public.owner_reorder_alerts(), public.owner_create_purchase_orders(uuid, uuid[]),
  public.owner_sales_trend(date, date, text, uuid), public.owner_top_items(date, date, uuid, int),
  public.owner_margins(date, date, uuid), public.owner_dead_stock(int, uuid), public.owner_staff_performance(date, date),
  public.owner_customer_ledger(uuid), public.owner_purchases_net(date, date, uuid),
  public.owner_set_purchase_discount(uuid, text, numeric, text), public.owner_adjust_stock(uuid, uuid, text, numeric, text),
  public.owner_cancel_dispatch(uuid, text), public.owner_cancel_purchase(uuid, text), public.owner_set_override_pin(text),
  public.owner_list_users(), public.owner_update_user(uuid, boolean, uuid, text), public.owner_notifications(int)
TO authenticated;

GRANT EXECUTE ON FUNCTION
  public.wa_claim_outbox(int), public.wa_mark_sent(bigint, text, jsonb), public.wa_mark_failed(bigint, text, boolean, jsonb),
  public.wa_status_update(text, text, text), public.wa_dispatch_payload(uuid), public.wa_eod_payload(date)
TO service_role;

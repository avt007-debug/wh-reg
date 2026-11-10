-- =============================================================================
-- gst_split_sales
--   * Sales & purchase lines get a ₹ discount amount and the item's MRP.
--     (Line maths are generated columns; PostgreSQL 17 lets us change them in
--     place with SET EXPRESSION — existing rows keep identical values because
--     discount_amount defaults to 0.)
--   * Sales bills: invoice number can be typed (blank = automatic), and a new
--     customer (name + GSTIN) can be entered right on the bill.
--   * Owner sales register by month (lines carry GST % so the app splits
--     GST-billed vs Non-GST-billed), and today's clock-in/out for the dashboard.
-- =============================================================================

-- ---------------------------------------------------------------- sales lines
ALTER TABLE dispatch_items
  ADD COLUMN discount_amount numeric(14,2) NOT NULL DEFAULT 0 CHECK (discount_amount >= 0),
  ADD COLUMN mrp numeric(14,2) CHECK (mrp >= 0);
ALTER TABLE dispatch_items
  ALTER COLUMN unit_final_price SET EXPRESSION AS (
    CASE WHEN discount_amount = 0 THEN round(unit_base_price * (1 - discount_pct / 100), 4)
         ELSE round((round(qty * round(unit_base_price * (1 - discount_pct / 100), 4), 2) - discount_amount) / qty, 4) END),
  ALTER COLUMN line_discount SET EXPRESSION AS (
    round(qty * unit_base_price, 2) - round(qty * round(unit_base_price * (1 - discount_pct / 100), 4), 2) + discount_amount),
  ALTER COLUMN line_taxable SET EXPRESSION AS (
    round(qty * round(unit_base_price * (1 - discount_pct / 100), 4), 2) - discount_amount),
  ALTER COLUMN line_tax SET EXPRESSION AS (
    round((round(qty * round(unit_base_price * (1 - discount_pct / 100), 4), 2) - discount_amount) * gst_rate / 100, 2)),
  ALTER COLUMN line_total SET EXPRESSION AS (
    (round(qty * round(unit_base_price * (1 - discount_pct / 100), 4), 2) - discount_amount)
    + round((round(qty * round(unit_base_price * (1 - discount_pct / 100), 4), 2) - discount_amount) * gst_rate / 100, 2));
ALTER TABLE dispatch_items ADD CONSTRAINT dispatch_discount_within_value
  CHECK (discount_amount <= round(qty * round(unit_base_price * (1 - discount_pct / 100), 4), 2));

-- ---------------------------------------------------------------- purchase lines
ALTER TABLE purchase_items
  ADD COLUMN discount_amount numeric(14,2) NOT NULL DEFAULT 0 CHECK (discount_amount >= 0),
  ADD COLUMN mrp numeric(14,2) CHECK (mrp >= 0);
ALTER TABLE purchase_items
  ALTER COLUMN line_taxable SET EXPRESSION AS (round(qty * unit_base_price, 2) - discount_amount),
  ALTER COLUMN line_tax SET EXPRESSION AS (round((round(qty * unit_base_price, 2) - discount_amount) * gst_rate / 100, 2)),
  ALTER COLUMN line_total SET EXPRESSION AS (
    (round(qty * unit_base_price, 2) - discount_amount) + round((round(qty * unit_base_price, 2) - discount_amount) * gst_rate / 100, 2));
ALTER TABLE purchase_items ADD CONSTRAINT purchase_discount_within_value
  CHECK (discount_amount <= round(qty * unit_base_price, 2));

-- ---------------------------------------------------------------- customer on the bill
/* Existing customer id, or { name, gstin?, phone? } — matched by GSTIN, else by
   exact name (unregistered), else created. */
CREATE FUNCTION app.resolve_customer(p_id uuid, p_new jsonb) RETURNS uuid
LANGUAGE plpgsql SET search_path = public, extensions, pg_temp AS $$
DECLARE v uuid; v_name text := trim(p_new->>'name'); v_gstin text := nullif(upper(trim(p_new->>'gstin')), '');
        v_phone text := nullif(right(regexp_replace(coalesce(p_new->>'phone', ''), '\D', '', 'g'), 10), '');
BEGIN
  IF p_id IS NOT NULL THEN RETURN p_id; END IF;
  IF coalesce(v_name, '') = '' THEN RAISE EXCEPTION 'Customer name is required' USING ERRCODE = 'WH005'; END IF;
  IF v_gstin IS NOT NULL AND NOT app.gstin_valid(v_gstin) THEN
    RAISE EXCEPTION 'Customer GST number % is not valid', v_gstin USING ERRCODE = 'WH005';
  END IF;
  IF v_gstin IS NOT NULL THEN
    SELECT id INTO v FROM customers WHERE gstin = v_gstin;
  ELSE
    SELECT id INTO v FROM customers WHERE gstin IS NULL AND lower(name) = lower(v_name) AND is_active ORDER BY created_at LIMIT 1;
  END IF;
  IF v IS NULL THEN
    INSERT INTO customers(name, gstin, state_code, phone, is_dealer)
    VALUES (v_name, v_gstin, CASE WHEN v_gstin IS NOT NULL THEN left(v_gstin, 2) END, v_phone, v_gstin IS NOT NULL)
    RETURNING id INTO v;
  END IF;
  RETURN v;
END$$;

/* p = { clientTxnId, warehouseId?, invoiceNo?, invoiceDate?, customerId? | newCustomer?: { name, gstin?, phone? },
         salesAgentId?, transportMode, transporterName?, vehicleRegNo?, driverPhone?, lrNumber?, ewayBillNo?, overrideId?,
         lines: [{ productId, uomCode, qty, unitBasePrice, discountPct?, discountAmount?, gstRate?, hsnCode?, mrp? }] } */
CREATE OR REPLACE FUNCTION public.create_dispatch(p jsonb) RETURNS jsonb
LANGUAGE plpgsql SET search_path = public, extensions, pg_temp AS $$
DECLARE v_id uuid; v_wh uuid; v_short jsonb; v_cust uuid;
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
  IF nullif(trim(p->>'invoiceNo'), '') IS NOT NULL AND length(trim(p->>'invoiceNo')) > 16 THEN
    RAISE EXCEPTION 'Invoice number can be at most 16 characters' USING ERRCODE = 'WH005';
  END IF;
  v_cust := app.resolve_customer(nullif(p->>'customerId', '')::uuid, p->'newCustomer');

  INSERT INTO dispatches(client_txn_id, warehouse_id, customer_id, sales_agent_id, invoice_no, invoice_date, fy,
                         place_of_supply, is_interstate, transport_mode, transporter_name, vehicle_reg_no,
                         driver_phone, lr_number, eway_bill_no, override_id)
  VALUES ((p->>'clientTxnId')::uuid, v_wh, v_cust, (p->>'salesAgentId')::uuid,
          nullif(upper(trim(p->>'invoiceNo')), ''), coalesce((p->>'invoiceDate')::date, app.today_ist()), '', NULL, false,
          coalesce(nullif(p->>'transportMode', ''), 'CUSTOMER_PICKUP')::transport_mode, p->>'transporterName', p->>'vehicleRegNo',
          p->>'driverPhone', p->>'lrNumber', p->>'ewayBillNo', (p->>'overrideId')::uuid)
  RETURNING id INTO v_id;

  INSERT INTO dispatch_items(dispatch_id, line_no, product_id, uom_code, conversion_factor, qty,
                             unit_base_price, discount_pct, discount_amount, gst_rate, hsn_code, mrp)
  SELECT v_id, e.ord, (e.j->>'productId')::uuid, e.j->>'uomCode', 1, (e.j->>'qty')::numeric,
         (e.j->>'unitBasePrice')::numeric, coalesce((e.j->>'discountPct')::numeric, 0),
         coalesce(nullif(e.j->>'discountAmount', '')::numeric, 0), nullif(e.j->>'gstRate', '')::numeric,
         nullif(trim(e.j->>'hsnCode'), ''), nullif(e.j->>'mrp', '')::numeric
    FROM jsonb_array_elements(p->'lines') WITH ORDINALITY AS e(j, ord);

  SET CONSTRAINTS ALL IMMEDIATE;
  RETURN jsonb_build_object('replayed', false, 'dispatch', app.dispatch_json(v_id));
END$$;

CREATE OR REPLACE FUNCTION public.create_purchase(p jsonb) RETURNS jsonb
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
                             hsn_code, gst_rate, unit_base_price, unit_incl_price, discount_amount, mrp)
  SELECT v_id, e.ord, (e.j->>'productId')::uuid, e.j->>'uomCode', 1, (e.j->>'qty')::numeric, nullif(trim(e.j->>'hsnCode'), ''),
         (e.j->>'gstRate')::numeric, (e.j->>'unitBasePrice')::numeric, (e.j->>'unitInclPrice')::numeric,
         coalesce(nullif(e.j->>'discountAmount', '')::numeric, 0), nullif(e.j->>'mrp', '')::numeric
    FROM jsonb_array_elements(p->'lines') WITH ORDINALITY AS e(j, ord);

  INSERT INTO purchase_attachments(purchase_id, kind, storage_key, mime_type)
  SELECT v_id, a->>'kind', a->>'storagePath', a->>'mimeType'
    FROM jsonb_array_elements(coalesce(p->'attachments', '[]'::jsonb)) a;

  SET CONSTRAINTS ALL IMMEDIATE;
  RETURN jsonb_build_object('replayed', false, 'purchase', app.purchase_json(v_id));
END$$;

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
    IF v.status = 'POSTED' THEN
      FOR r IN SELECT * FROM purchase_items WHERE purchase_id = p_id ORDER BY line_no LOOP
        PERFORM app.apply_movement(v.warehouse_id, r.product_id, 'REVERSAL', -r.qty_base,
                                   'purchase_items', r.id, p_id, NULL, true);
      END LOOP;
    END IF;
    DELETE FROM purchase_items WHERE purchase_id = p_id;

    PERFORM set_config('app.editing_doc', p_id::text, true);
    INSERT INTO purchase_items(purchase_id, line_no, product_id, uom_code, conversion_factor, qty,
                               hsn_code, gst_rate, unit_base_price, unit_incl_price, discount_amount, mrp)
    SELECT p_id, e.ord, (e.j->>'productId')::uuid, e.j->>'uomCode', 1, (e.j->>'qty')::numeric,
           nullif(e.j->>'hsnCode', ''), (e.j->>'gstRate')::numeric, (e.j->>'unitBasePrice')::numeric,
           (e.j->>'unitInclPrice')::numeric, coalesce(nullif(e.j->>'discountAmount', '')::numeric, 0),
           nullif(e.j->>'mrp', '')::numeric
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

-- purchase detail lines now carry the bill's own discount amount and MRP
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
                'discount_amount', pi.discount_amount, 'mrp', pi.mrp, 'line_tax', pi.line_tax,
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

-- ---------------------------------------------------------------- owner sales register
CREATE FUNCTION fin.sale_detail(p_id uuid) RETURNS jsonb
LANGUAGE sql STABLE SET search_path = public, fin, extensions, pg_temp AS $$
  SELECT jsonb_build_object(
    'id', d.id, 'invoice_no', d.invoice_no, 'invoice_date', d.invoice_date, 'warehouse_id', d.warehouse_id,
    'warehouse_name', w.name, 'customer_id', d.customer_id, 'customer_name', d.customer_name, 'customer_gstin', d.customer_gstin,
    'customer_phone', c.phone, 'is_interstate', d.is_interstate, 'place_of_supply', d.place_of_supply,
    'taxable_total', d.taxable_total, 'discount_total', d.discount_total,
    'cgst_total', d.cgst_total, 'sgst_total', d.sgst_total, 'igst_total', d.igst_total, 'grand_total', d.grand_total,
    'status', d.status, 'cancelled_reason', d.cancelled_reason, 'used_override', d.override_id IS NOT NULL,
    'entered_by', u.full_name, 'entered_by_role', u.role, 'entered_at', d.created_at,
    'lines', (SELECT coalesce(jsonb_agg(jsonb_build_object(
                'id', i.id, 'line_no', i.line_no, 'product_id', i.product_id, 'sku_code', pr.sku_code, 'name', pr.name,
                'hsn_code', i.hsn_code, 'uom', i.uom_code, 'qty', i.qty, 'mrp', i.mrp, 'unit_base_price', i.unit_base_price,
                'discount_pct', i.discount_pct, 'discount_amount', i.discount_amount, 'line_discount', i.line_discount,
                'line_taxable', i.line_taxable, 'gst_rate', i.gst_rate, 'line_tax', i.line_tax, 'line_total', i.line_total)
                ORDER BY i.line_no), '[]')
              FROM dispatch_items i JOIN products pr ON pr.id = i.product_id WHERE i.dispatch_id = d.id))
  FROM dispatches d
  JOIN warehouses w ON w.id = d.warehouse_id
  JOIN users u ON u.id = d.created_by
  LEFT JOIN customers c ON c.id = d.customer_id
  WHERE d.id = p_id
$$;
REVOKE EXECUTE ON FUNCTION fin.sale_detail(uuid) FROM PUBLIC, anon, authenticated;

CREATE FUNCTION public.owner_sales_month(p_month date, p_warehouse uuid DEFAULT NULL) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, fin, extensions, pg_temp AS $$
DECLARE v_from date := date_trunc('month', p_month)::date;
BEGIN
  PERFORM app.require_owner();
  RETURN (SELECT coalesce(jsonb_agg(fin.sale_detail(d.id) ORDER BY d.invoice_date DESC, d.created_at DESC), '[]')
            FROM dispatches d
           WHERE d.invoice_date >= v_from AND d.invoice_date < (v_from + interval '1 month')
             AND (p_warehouse IS NULL OR d.warehouse_id = p_warehouse));
END$$;

-- ---------------------------------------------------------------- dashboard: today's attendance
CREATE FUNCTION public.owner_attendance_today(p_warehouse uuid DEFAULT NULL) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, extensions, pg_temp AS $$
DECLARE v_today date := app.today_ist();
BEGIN
  PERFORM app.require_owner();
  RETURN (SELECT coalesce(jsonb_agg(row_to_json(t)::jsonb ORDER BY t.first_in NULLS LAST, t.full_name), '[]') FROM (
    SELECT u.id, u.full_name, u.login_id, w.name AS warehouse_name,
           min(a.clock_in_at) AS first_in,
           max(a.clock_out_at) AS last_out,
           max(a.clock_in_at) FILTER (WHERE a.clock_out_at IS NULL) AS open_since,
           count(a.id) AS shifts,
           round(coalesce(sum(extract(epoch FROM (coalesce(a.clock_out_at, now()) - a.clock_in_at))), 0) / 3600.0, 2) AS hours
      FROM users u
      LEFT JOIN warehouses w ON w.id = u.primary_warehouse_id
      LEFT JOIN attendance a ON a.user_id = u.id AND (a.work_date = v_today OR a.clock_out_at IS NULL)
     WHERE u.role <> 'OWNER' AND u.removed_at IS NULL AND u.is_active
       AND (p_warehouse IS NULL OR u.primary_warehouse_id = p_warehouse)
     GROUP BY u.id, u.full_name, u.login_id, w.name) t);
END$$;

REVOKE EXECUTE ON FUNCTION public.owner_sales_month(date, uuid), public.owner_attendance_today(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.owner_sales_month(date, uuid), public.owner_attendance_today(uuid) TO authenticated;
REVOKE EXECUTE ON FUNCTION app.resolve_customer(uuid, jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION app.resolve_customer(uuid, jsonb) TO authenticated;   -- invoker function: RLS on customers applies

-- =============================================================================
-- credit_notes_charges
--   * Extra charges on bills: loading / transport / other (added to the bill
--     total, outside the GST lines). Purchases keep freight_amount = transport.
--   * Purchase lines take a discount % (stored; the ₹ amount is derived from it).
--   * New vendor (name + GSTIN) can be entered right on a purchase.
--   * Credit notes (owner only): a credit % per purchase line = credit value
--     earned for future purchases from that vendor. It does not change what is
--     paid now. Credit used later is recorded against the vendor; the "credit
--     available" summary is by vendor and by item.
-- =============================================================================

ALTER TABLE purchase_items
  ADD COLUMN discount_pct numeric(5,2) NOT NULL DEFAULT 0 CHECK (discount_pct BETWEEN 0 AND 100);
ALTER TABLE purchases
  ADD COLUMN loading_charges numeric(14,2) NOT NULL DEFAULT 0 CHECK (loading_charges >= 0),
  ADD COLUMN other_charges   numeric(14,2) NOT NULL DEFAULT 0 CHECK (other_charges >= 0);
ALTER TABLE dispatches
  ADD COLUMN loading_charges   numeric(14,2) NOT NULL DEFAULT 0 CHECK (loading_charges >= 0),
  ADD COLUMN transport_charges numeric(14,2) NOT NULL DEFAULT 0 CHECK (transport_charges >= 0),
  ADD COLUMN other_charges     numeric(14,2) NOT NULL DEFAULT 0 CHECK (other_charges >= 0);

-- ---------------------------------------------------------------- totals include charges
CREATE OR REPLACE FUNCTION app.finalize_document() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, extensions, pg_temp AS $$
DECLARE
  v_taxable numeric; v_tax numeric; v_disc numeric; v_lines int; v_outbox bigint;
BEGIN
  IF TG_TABLE_NAME = 'purchases' THEN
    SELECT count(*), coalesce(sum(line_taxable),0), coalesce(sum(line_tax),0)
      INTO v_lines, v_taxable, v_tax FROM purchase_items WHERE purchase_id = NEW.id;
    IF v_lines = 0 THEN RAISE EXCEPTION 'A purchase needs at least one item' USING ERRCODE = 'WH005'; END IF;
    UPDATE purchases SET
      taxable_total = v_taxable,
      igst_total = CASE WHEN is_interstate THEN v_tax ELSE 0 END,
      cgst_total = CASE WHEN is_interstate THEN 0 ELSE round(v_tax / 2, 2) END,
      sgst_total = CASE WHEN is_interstate THEN 0 ELSE v_tax - round(v_tax / 2, 2) END,
      grand_total = v_taxable + v_tax + freight_amount + loading_charges + other_charges
    WHERE id = NEW.id;

  ELSE -- dispatches
    SELECT count(*), coalesce(sum(line_taxable),0), coalesce(sum(line_tax),0), coalesce(sum(line_discount),0)
      INTO v_lines, v_taxable, v_tax, v_disc FROM dispatch_items WHERE dispatch_id = NEW.id;
    IF v_lines = 0 THEN RAISE EXCEPTION 'A dispatch needs at least one item' USING ERRCODE = 'WH005'; END IF;
    UPDATE dispatches SET
      taxable_total = v_taxable,
      discount_total = v_disc,
      igst_total = CASE WHEN is_interstate THEN v_tax ELSE 0 END,
      cgst_total = CASE WHEN is_interstate THEN 0 ELSE round(v_tax / 2, 2) END,
      sgst_total = CASE WHEN is_interstate THEN 0 ELSE v_tax - round(v_tax / 2, 2) END,
      grand_total = v_taxable + v_tax + loading_charges + transport_charges + other_charges
    WHERE id = NEW.id;

    INSERT INTO notification_outbox(event_type, aggregate_id, dedupe_key)
    VALUES ('DISPATCH_ALERT', NEW.id, 'dispatch:' || NEW.id)
    ON CONFLICT (dedupe_key) DO NOTHING
    RETURNING id INTO v_outbox;
    IF v_outbox IS NOT NULL THEN PERFORM pg_notify('outbox', v_outbox::text); END IF;
  END IF;
  RETURN NULL;
END$$;

CREATE OR REPLACE FUNCTION app.recompute_purchase_totals(p_id uuid) RETURNS void
LANGUAGE sql SECURITY DEFINER SET search_path = public, extensions, pg_temp AS $$
  UPDATE purchases p SET
    taxable_total = s.taxable,
    igst_total = CASE WHEN p.is_interstate THEN s.tax ELSE 0 END,
    cgst_total = CASE WHEN p.is_interstate THEN 0 ELSE round(s.tax / 2, 2) END,
    sgst_total = CASE WHEN p.is_interstate THEN 0 ELSE s.tax - round(s.tax / 2, 2) END,
    grand_total = s.taxable + s.tax + p.freight_amount + p.loading_charges + p.other_charges
  FROM (SELECT coalesce(sum(line_taxable), 0) AS taxable, coalesce(sum(line_tax), 0) AS tax
          FROM purchase_items WHERE purchase_id = p_id) s
  WHERE p.id = p_id
$$;

-- ---------------------------------------------------------------- vendor on the bill
CREATE FUNCTION app.resolve_vendor(p_id uuid, p_new jsonb) RETURNS uuid
LANGUAGE plpgsql SET search_path = public, extensions, pg_temp AS $$
DECLARE v uuid; v_name text := trim(p_new->>'name'); v_gstin text := nullif(upper(trim(p_new->>'gstin')), '');
        v_phone text := nullif(right(regexp_replace(coalesce(p_new->>'phone', ''), '\D', '', 'g'), 10), '');
BEGIN
  IF p_id IS NOT NULL THEN RETURN p_id; END IF;
  IF coalesce(v_name, '') = '' THEN RAISE EXCEPTION 'Seller name is required' USING ERRCODE = 'WH005'; END IF;
  IF v_gstin IS NOT NULL AND NOT app.gstin_valid(v_gstin) THEN
    RAISE EXCEPTION 'Seller GST number % is not valid', v_gstin USING ERRCODE = 'WH005';
  END IF;
  IF v_gstin IS NOT NULL THEN
    SELECT id INTO v FROM vendors WHERE gstin = v_gstin;
  ELSE
    SELECT id INTO v FROM vendors WHERE gstin IS NULL AND lower(name) = lower(v_name) AND is_active ORDER BY created_at LIMIT 1;
  END IF;
  IF v IS NULL THEN
    INSERT INTO vendors(name, gstin, state_code, phone)
    VALUES (v_name, v_gstin, CASE WHEN v_gstin IS NOT NULL THEN left(v_gstin, 2) END, v_phone)
    RETURNING id INTO v;
  END IF;
  RETURN v;
END$$;
REVOKE EXECUTE ON FUNCTION app.resolve_vendor(uuid, jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION app.resolve_vendor(uuid, jsonb) TO authenticated;   -- invoker: RLS on vendors applies

-- line discount in ₹: explicit amount wins, otherwise from the %
CREATE FUNCTION app.pct_discount(p_line jsonb) RETURNS numeric
LANGUAGE sql IMMUTABLE SET search_path = public, extensions, pg_temp AS $$
  SELECT coalesce(nullif(p_line->>'discountAmount', '')::numeric,
                  round(round((p_line->>'qty')::numeric * (p_line->>'unitBasePrice')::numeric, 2)
                        * coalesce(nullif(p_line->>'discountPct', '')::numeric, 0) / 100, 2))
$$;
REVOKE EXECUTE ON FUNCTION app.pct_discount(jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION app.pct_discount(jsonb) TO authenticated;

-- ---------------------------------------------------------------- credit notes (owner only)
CREATE TABLE fin.purchase_credit_notes (
  purchase_item_id uuid PRIMARY KEY REFERENCES purchase_items(id) ON DELETE CASCADE,
  credit_pct       numeric(5,2) NOT NULL CHECK (credit_pct > 0 AND credit_pct <= 100),
  entered_by       uuid NOT NULL REFERENCES users(id),
  entered_at       timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE fin.credit_note_uses (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  vendor_id    uuid NOT NULL REFERENCES vendors(id),
  amount       numeric(14,2) NOT NULL CHECK (amount > 0),
  used_on      date NOT NULL DEFAULT app.today_ist(),
  purchase_id  uuid REFERENCES purchases(id),
  notes        text,
  entered_by   uuid NOT NULL REFERENCES users(id),
  created_at   timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE fin.purchase_credit_notes ENABLE ROW LEVEL SECURITY;
ALTER TABLE fin.credit_note_uses ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON fin.purchase_credit_notes, fin.credit_note_uses FROM PUBLIC, anon, authenticated;
CREATE TRIGGER audit_credit_notes AFTER INSERT OR UPDATE OR DELETE ON fin.purchase_credit_notes FOR EACH ROW EXECUTE FUNCTION app.audit_row();
CREATE TRIGGER audit_credit_uses AFTER INSERT OR UPDATE OR DELETE ON fin.credit_note_uses FOR EACH ROW EXECUTE FUNCTION app.audit_row();

/* p_lines = [{ lineNo, pct }] — pct 0 / null clears. Or p_all_pct sets every line. */
CREATE FUNCTION public.owner_set_purchase_credits(p_purchase uuid, p_lines jsonb DEFAULT NULL, p_all_pct numeric DEFAULT NULL)
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, fin, extensions, pg_temp AS $$
DECLARE r record;
BEGIN
  PERFORM app.require_owner();
  FOR r IN
    SELECT pi.id, CASE WHEN p_all_pct IS NOT NULL THEN p_all_pct
                       ELSE (SELECT nullif(e->>'pct', '')::numeric FROM jsonb_array_elements(coalesce(p_lines, '[]')) e
                              WHERE (e->>'lineNo')::int = pi.line_no LIMIT 1) END AS pct,
           p_all_pct IS NOT NULL OR EXISTS (SELECT 1 FROM jsonb_array_elements(coalesce(p_lines, '[]')) e WHERE (e->>'lineNo')::int = pi.line_no) AS touched
      FROM purchase_items pi WHERE pi.purchase_id = p_purchase
  LOOP
    CONTINUE WHEN NOT r.touched;
    IF coalesce(r.pct, 0) = 0 THEN
      DELETE FROM fin.purchase_credit_notes WHERE purchase_item_id = r.id;
    ELSIF r.pct < 0 OR r.pct > 100 THEN
      RAISE EXCEPTION 'Credit %% must be between 0 and 100' USING ERRCODE = 'WH005';
    ELSE
      INSERT INTO fin.purchase_credit_notes(purchase_item_id, credit_pct, entered_by)
      VALUES (r.id, r.pct, app.current_user_id())
      ON CONFLICT (purchase_item_id) DO UPDATE SET credit_pct = EXCLUDED.credit_pct, entered_by = EXCLUDED.entered_by, entered_at = now();
    END IF;
  END LOOP;
END$$;

-- ---------------------------------------------------------------- entry RPCs
/* adds: newVendor {name,gstin?,phone?}, loadingCharges, otherCharges, lines[].discountPct, lines[].creditPct (owner only) */
CREATE OR REPLACE FUNCTION public.create_purchase(p jsonb) RETURNS jsonb
LANGUAGE plpgsql SET search_path = public, extensions, pg_temp AS $$
DECLARE v_id uuid; v_wh uuid; v_vendor uuid;
BEGIN
  SELECT id INTO v_id FROM purchases WHERE client_txn_id = (p->>'clientTxnId')::uuid;
  IF FOUND THEN RETURN jsonb_build_object('replayed', true, 'purchase', app.purchase_json(v_id)); END IF;

  v_wh := app.resolve_warehouse((p->>'warehouseId')::uuid);
  IF jsonb_array_length(coalesce(p->'lines', '[]'::jsonb)) = 0 THEN
    RAISE EXCEPTION 'A purchase needs at least one item' USING ERRCODE = 'WH005';
  END IF;
  v_vendor := app.resolve_vendor(nullif(p->>'vendorId', '')::uuid, p->'newVendor');

  INSERT INTO purchases(client_txn_id, warehouse_id, vendor_id, vendor_name, vendor_invoice_no,
                        vendor_invoice_date, lorry_receipt_no, freight_amount, loading_charges, other_charges, is_interstate)
  VALUES ((p->>'clientTxnId')::uuid, v_wh, v_vendor, NULL, p->>'vendorInvoiceNo',
          (p->>'vendorInvoiceDate')::date, p->>'lorryReceiptNo', coalesce(nullif(p->>'freightAmount', '')::numeric, 0),
          coalesce(nullif(p->>'loadingCharges', '')::numeric, 0), coalesce(nullif(p->>'otherCharges', '')::numeric, 0), false)
  RETURNING id INTO v_id;

  INSERT INTO purchase_items(purchase_id, line_no, product_id, uom_code, conversion_factor, qty,
                             hsn_code, gst_rate, unit_base_price, unit_incl_price, discount_pct, discount_amount, mrp)
  SELECT v_id, e.ord, (e.j->>'productId')::uuid, e.j->>'uomCode', 1, (e.j->>'qty')::numeric, nullif(trim(e.j->>'hsnCode'), ''),
         (e.j->>'gstRate')::numeric, (e.j->>'unitBasePrice')::numeric,
         coalesce(nullif(e.j->>'unitInclPrice', '')::numeric, round((e.j->>'unitBasePrice')::numeric * (1 + (e.j->>'gstRate')::numeric / 100), 2)),
         coalesce(nullif(e.j->>'discountPct', '')::numeric, 0), app.pct_discount(e.j), nullif(e.j->>'mrp', '')::numeric
    FROM jsonb_array_elements(p->'lines') WITH ORDINALITY AS e(j, ord);

  INSERT INTO purchase_attachments(purchase_id, kind, storage_key, mime_type)
  SELECT v_id, a->>'kind', a->>'storagePath', a->>'mimeType'
    FROM jsonb_array_elements(coalesce(p->'attachments', '[]'::jsonb)) a;

  SET CONSTRAINTS ALL IMMEDIATE;
  IF app.is_owner() THEN
    PERFORM public.owner_set_purchase_credits(v_id,
      (SELECT jsonb_agg(jsonb_build_object('lineNo', e.ord, 'pct', e.j->>'creditPct'))
         FROM jsonb_array_elements(p->'lines') WITH ORDINALITY AS e(j, ord) WHERE coalesce(nullif(e.j->>'creditPct', '')::numeric, 0) > 0));
  END IF;
  RETURN jsonb_build_object('replayed', false, 'purchase', app.purchase_json(v_id));
END$$;

/* adds: loadingCharges, transportCharges, otherCharges */
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
                         driver_phone, lr_number, eway_bill_no, override_id,
                         loading_charges, transport_charges, other_charges)
  VALUES ((p->>'clientTxnId')::uuid, v_wh, v_cust, (p->>'salesAgentId')::uuid,
          nullif(upper(trim(p->>'invoiceNo')), ''), coalesce((p->>'invoiceDate')::date, app.today_ist()), '', NULL, false,
          coalesce(nullif(p->>'transportMode', ''), 'CUSTOMER_PICKUP')::transport_mode, p->>'transporterName', p->>'vehicleRegNo',
          p->>'driverPhone', p->>'lrNumber', p->>'ewayBillNo', (p->>'overrideId')::uuid,
          coalesce(nullif(p->>'loadingCharges', '')::numeric, 0), coalesce(nullif(p->>'transportCharges', '')::numeric, 0),
          coalesce(nullif(p->>'otherCharges', '')::numeric, 0))
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
    freight_amount      = coalesce((p->>'freightAmount')::numeric, freight_amount),
    loading_charges     = coalesce((p->>'loadingCharges')::numeric, loading_charges),
    other_charges       = coalesce((p->>'otherCharges')::numeric, other_charges)
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
                               hsn_code, gst_rate, unit_base_price, unit_incl_price, discount_pct, discount_amount, mrp)
    SELECT p_id, e.ord, (e.j->>'productId')::uuid, e.j->>'uomCode', 1, (e.j->>'qty')::numeric,
           nullif(e.j->>'hsnCode', ''), (e.j->>'gstRate')::numeric, (e.j->>'unitBasePrice')::numeric,
           coalesce(nullif(e.j->>'unitInclPrice', '')::numeric, round((e.j->>'unitBasePrice')::numeric * (1 + (e.j->>'gstRate')::numeric / 100), 2)),
           coalesce(nullif(e.j->>'discountPct', '')::numeric, 0), app.pct_discount(e.j), nullif(e.j->>'mrp', '')::numeric
      FROM jsonb_array_elements(p->'lines') WITH ORDINALITY AS e(j, ord);
    PERFORM set_config('app.editing_doc', '', true);

    INSERT INTO fin.purchase_item_discounts(purchase_item_id, discount_type, discount_value, reason, entered_by)
    SELECT pi.id, e.j->>'discountType', (e.j->>'discountValue')::numeric, e.j->>'discountReason', app.current_user_id()
      FROM jsonb_array_elements(p->'lines') WITH ORDINALITY AS e(j, ord)
      JOIN purchase_items pi ON pi.purchase_id = p_id AND pi.line_no = e.ord
     WHERE e.j->>'discountType' IN ('PERCENT', 'AMOUNT') AND coalesce((e.j->>'discountValue')::numeric, 0) > 0;

    INSERT INTO fin.purchase_credit_notes(purchase_item_id, credit_pct, entered_by)
    SELECT pi.id, (e.j->>'creditPct')::numeric, app.current_user_id()
      FROM jsonb_array_elements(p->'lines') WITH ORDINALITY AS e(j, ord)
      JOIN purchase_items pi ON pi.purchase_id = p_id AND pi.line_no = e.ord
     WHERE coalesce(nullif(e.j->>'creditPct', '')::numeric, 0) > 0;
  END IF;

  PERFORM app.recompute_purchase_totals(p_id);
  INSERT INTO audit_log(table_name, row_id, action, actor_id, old_data, new_data)
  VALUES ('public.purchases', p_id::text, 'EDIT', app.current_user_id(), to_jsonb(v),
          (SELECT to_jsonb(x) FROM purchases x WHERE x.id = p_id));
  RETURN fin.purchase_detail(p_id);
END$$;

-- ---------------------------------------------------------------- detail views
CREATE OR REPLACE FUNCTION fin.purchase_detail(p_id uuid) RETURNS jsonb
LANGUAGE sql STABLE SET search_path = public, fin, extensions, pg_temp AS $$
  SELECT jsonb_build_object(
    'id', p.id, 'warehouse_id', p.warehouse_id, 'warehouse_code', w.code, 'warehouse_name', w.name,
    'vendor_id', p.vendor_id, 'vendor_name', p.vendor_name, 'vendor_gstin', p.vendor_gstin,
    'vendor_invoice_no', p.vendor_invoice_no, 'vendor_invoice_date', p.vendor_invoice_date,
    'received_on', p.received_on, 'lorry_receipt_no', p.lorry_receipt_no, 'is_interstate', p.is_interstate,
    'freight_amount', p.freight_amount, 'loading_charges', p.loading_charges, 'other_charges', p.other_charges,
    'taxable_total', p.taxable_total,
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
    'credit_total', (SELECT coalesce(sum(round(pi.line_taxable * cn.credit_pct / 100, 2)), 0)
                       FROM purchase_items pi JOIN fin.purchase_credit_notes cn ON cn.purchase_item_id = pi.id WHERE pi.purchase_id = p.id),
    'lines', (SELECT coalesce(jsonb_agg(jsonb_build_object(
                'id', pi.id, 'line_no', pi.line_no, 'product_id', pi.product_id, 'sku_code', pr.sku_code,
                'name', pr.name, 'uom', pi.uom_code, 'qty', pi.qty, 'qty_base', pi.qty_base, 'hsn_code', pi.hsn_code,
                'gst_rate', pi.gst_rate, 'unit_base_price', pi.unit_base_price, 'unit_incl_price', pi.unit_incl_price,
                'discount_pct', pi.discount_pct, 'discount_amount', pi.discount_amount, 'mrp', pi.mrp, 'line_tax', pi.line_tax,
                'line_taxable', pi.line_taxable, 'line_total', pi.line_total,
                'credit_pct', cn.credit_pct, 'credit_value', coalesce(round(pi.line_taxable * cn.credit_pct / 100, 2), 0),
                'item_discount_type', xd.discount_type, 'item_discount_value', xd.discount_value,
                'item_discount_amount', coalesce(fin.item_discount_amount(xd.discount_type, xd.discount_value, pi.line_taxable), 0),
                'effective_unit_cost_base', lc.effective_unit_cost_base) ORDER BY pi.line_no), '[]')
              FROM purchase_items pi
              JOIN products pr ON pr.id = pi.product_id
              LEFT JOIN fin.purchase_item_discounts xd ON xd.purchase_item_id = pi.id
              LEFT JOIN fin.purchase_credit_notes cn ON cn.purchase_item_id = pi.id
              LEFT JOIN fin.v_purchase_line_cost lc ON lc.purchase_item_id = pi.id
             WHERE pi.purchase_id = p.id))
  FROM purchases p
  JOIN warehouses w ON w.id = p.warehouse_id
  JOIN users cu ON cu.id = p.created_by
  LEFT JOIN users au ON au.id = p.approved_by
  LEFT JOIN fin.purchase_discounts bd ON bd.purchase_id = p.id
  WHERE p.id = p_id
$$;

CREATE OR REPLACE FUNCTION fin.sale_detail(p_id uuid) RETURNS jsonb
LANGUAGE sql STABLE SET search_path = public, fin, extensions, pg_temp AS $$
  SELECT jsonb_build_object(
    'id', d.id, 'invoice_no', d.invoice_no, 'invoice_date', d.invoice_date, 'warehouse_id', d.warehouse_id,
    'warehouse_name', w.name, 'customer_id', d.customer_id, 'customer_name', d.customer_name, 'customer_gstin', d.customer_gstin,
    'customer_phone', c.phone, 'is_interstate', d.is_interstate, 'place_of_supply', d.place_of_supply,
    'taxable_total', d.taxable_total, 'discount_total', d.discount_total,
    'cgst_total', d.cgst_total, 'sgst_total', d.sgst_total, 'igst_total', d.igst_total, 'grand_total', d.grand_total,
    'loading_charges', d.loading_charges, 'transport_charges', d.transport_charges, 'other_charges', d.other_charges,
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

-- ---------------------------------------------------------------- credit available
CREATE FUNCTION public.owner_credit_summary(p_warehouse uuid DEFAULT NULL) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, fin, extensions, pg_temp AS $$
BEGIN
  PERFORM app.require_owner();
  RETURN (
    WITH earned AS (
      SELECT p.vendor_id, pi.product_id, p.id AS purchase_id,
             round(pi.line_taxable * cn.credit_pct / 100, 2) AS value, pi.qty_base, cn.credit_pct
        FROM purchase_items pi
        JOIN purchases p ON p.id = pi.purchase_id AND p.status = 'POSTED'
        JOIN fin.purchase_credit_notes cn ON cn.purchase_item_id = pi.id
       WHERE p_warehouse IS NULL OR p.warehouse_id = p_warehouse),
    used AS (SELECT vendor_id, sum(amount) AS amount FROM fin.credit_note_uses GROUP BY vendor_id),
    vend AS (SELECT DISTINCT vendor_id FROM earned UNION SELECT vendor_id FROM used)
    SELECT jsonb_build_object(
      'vendors', coalesce((SELECT jsonb_agg(jsonb_build_object(
          'vendor_id', v.id, 'vendor_name', v.name, 'gstin', v.gstin,
          'earned', coalesce((SELECT sum(value) FROM earned e WHERE e.vendor_id = v.id), 0),
          'used', coalesce(u.amount, 0),
          'available', coalesce((SELECT sum(value) FROM earned e WHERE e.vendor_id = v.id), 0) - coalesce(u.amount, 0),
          'purchases', (SELECT count(DISTINCT purchase_id) FROM earned e WHERE e.vendor_id = v.id),
          'items', (SELECT coalesce(jsonb_agg(jsonb_build_object('product_id', x.product_id, 'sku_code', pr.sku_code, 'name', pr.name,
                                    'brand', b.name, 'category', c.path, 'earned', x.value, 'qty_base', x.qty, 'avg_pct', x.pct)
                                    ORDER BY x.value DESC), '[]')
                      FROM (SELECT product_id, sum(value) AS value, sum(qty_base) AS qty, round(avg(credit_pct), 2) AS pct
                              FROM earned e WHERE e.vendor_id = v.id GROUP BY product_id) x
                      JOIN products pr ON pr.id = x.product_id
                      LEFT JOIN brands b ON b.id = pr.brand_id
                      LEFT JOIN categories c ON c.id = pr.category_id))
          ORDER BY v.name)
        FROM vend JOIN vendors v ON v.id = vend.vendor_id LEFT JOIN used u ON u.vendor_id = v.id), '[]'),
      'uses', coalesce((SELECT jsonb_agg(jsonb_build_object('id', cu.id, 'vendor_id', cu.vendor_id, 'vendor_name', v.name,
                          'amount', cu.amount, 'used_on', cu.used_on, 'notes', cu.notes, 'purchase_invoice_no', p.vendor_invoice_no,
                          'entered_at', cu.created_at) ORDER BY cu.used_on DESC, cu.created_at DESC)
                 FROM fin.credit_note_uses cu JOIN vendors v ON v.id = cu.vendor_id LEFT JOIN purchases p ON p.id = cu.purchase_id), '[]')));
END$$;

/* p = { vendorId, amount, usedOn?, purchaseId?, notes? } */
CREATE FUNCTION public.owner_use_credit(p jsonb) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, fin, extensions, pg_temp AS $$
DECLARE v_avail numeric; v_vendor uuid := (p->>'vendorId')::uuid; v_amt numeric := (p->>'amount')::numeric;
BEGIN
  PERFORM app.require_owner();
  SELECT coalesce((SELECT sum(round(pi.line_taxable * cn.credit_pct / 100, 2))
                     FROM purchase_items pi JOIN purchases pu ON pu.id = pi.purchase_id AND pu.status = 'POSTED' AND pu.vendor_id = v_vendor
                     JOIN fin.purchase_credit_notes cn ON cn.purchase_item_id = pi.id), 0)
       - coalesce((SELECT sum(amount) FROM fin.credit_note_uses WHERE vendor_id = v_vendor), 0)
    INTO v_avail;
  IF v_amt IS NULL OR v_amt <= 0 THEN RAISE EXCEPTION 'Enter the credit amount used' USING ERRCODE = 'WH005'; END IF;
  IF v_amt > v_avail THEN
    RAISE EXCEPTION 'Only ₹% credit is available from this seller', v_avail USING ERRCODE = 'WH005';
  END IF;
  INSERT INTO fin.credit_note_uses(vendor_id, amount, used_on, purchase_id, notes, entered_by)
  VALUES (v_vendor, v_amt, coalesce(nullif(p->>'usedOn', '')::date, app.today_ist()), nullif(p->>'purchaseId', '')::uuid,
          nullif(trim(p->>'notes'), ''), app.current_user_id());
END$$;

CREATE FUNCTION public.owner_delete_credit_use(p_id uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, fin, extensions, pg_temp AS $$
BEGIN
  PERFORM app.require_owner();
  DELETE FROM fin.credit_note_uses WHERE id = p_id;
END$$;

REVOKE EXECUTE ON FUNCTION public.owner_set_purchase_credits(uuid, jsonb, numeric), public.owner_credit_summary(uuid),
  public.owner_use_credit(jsonb), public.owner_delete_credit_use(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.owner_set_purchase_credits(uuid, jsonb, numeric), public.owner_credit_summary(uuid),
  public.owner_use_credit(jsonb), public.owner_delete_credit_use(uuid) TO authenticated;

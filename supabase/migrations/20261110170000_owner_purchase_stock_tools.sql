-- =============================================================================
-- owner_purchase_stock_tools — owner-only:
--   1. extra discount per purchase ITEM (in addition to the per-bill discount)
--   2. editing a saved purchase (header + lines; stock is re-posted, history kept)
--   3. setting a stock count directly (posted as an audit adjustment)
--   4. month-by-month purchase register with the items in each invoice
-- Everything lives behind owner_* RPCs (SECURITY DEFINER + app.require_owner()).
-- =============================================================================

-- ---------------------------------------------------------------------------
-- 1. Per-item owner discount (owner-only schema fin)
-- ---------------------------------------------------------------------------
CREATE TABLE fin.purchase_item_discounts (
  purchase_item_id uuid PRIMARY KEY REFERENCES purchase_items(id) ON DELETE CASCADE,
  discount_type    text NOT NULL CHECK (discount_type IN ('PERCENT','AMOUNT')),
  discount_value   numeric(14,4) NOT NULL CHECK (discount_value >= 0),
  reason           text,
  entered_by       uuid NOT NULL REFERENCES users(id),
  entered_at       timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT item_pct_bounds CHECK (discount_type <> 'PERCENT' OR discount_value <= 100)
);
ALTER TABLE fin.purchase_item_discounts ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON fin.purchase_item_discounts FROM PUBLIC, anon, authenticated;

-- ₹ value of an item discount (never more than the line itself).
CREATE FUNCTION fin.item_discount_amount(p_type text, p_value numeric, p_line_taxable numeric) RETURNS numeric
LANGUAGE sql IMMUTABLE SET search_path = public, extensions, pg_temp AS $$
  SELECT CASE p_type
           WHEN 'PERCENT' THEN round(p_line_taxable * p_value / 100, 2)
           WHEN 'AMOUNT'  THEN least(round(p_value, 2), p_line_taxable)
           ELSE 0 END
$$;
REVOKE EXECUTE ON FUNCTION fin.item_discount_amount(text, numeric, numeric) FROM PUBLIC, anon, authenticated;

-- Audit trigger learns the new key column.
CREATE OR REPLACE FUNCTION app.audit_row() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, extensions, pg_temp AS $$
DECLARE v_id text;
BEGIN
  v_id := coalesce(to_jsonb(NEW)->>'id', to_jsonb(OLD)->>'id',
                   to_jsonb(NEW)->>'purchase_id', to_jsonb(OLD)->>'purchase_id',
                   to_jsonb(NEW)->>'purchase_item_id', to_jsonb(OLD)->>'purchase_item_id',
                   to_jsonb(NEW)->>'user_id', to_jsonb(OLD)->>'user_id');
  INSERT INTO audit_log(table_name, row_id, action, actor_id, old_data, new_data)
  VALUES (TG_TABLE_SCHEMA || '.' || TG_TABLE_NAME, v_id, TG_OP, app.current_user_id(),
          CASE WHEN TG_OP <> 'INSERT' THEN to_jsonb(OLD) END,
          CASE WHEN TG_OP <> 'DELETE' THEN to_jsonb(NEW) END);
  RETURN NULL;
END$$;
CREATE TRIGGER audit_item_discounts AFTER INSERT OR UPDATE OR DELETE ON fin.purchase_item_discounts
  FOR EACH ROW EXECUTE FUNCTION app.audit_row();

-- ---------------------------------------------------------------------------
-- Cost views now include item discounts (same columns, so dependants keep working).
--   owner_discount (per purchase) = bill discount + all item discounts
--   effective line cost = line − its item discount − bill-discount share + freight share
-- ---------------------------------------------------------------------------
CREATE OR REPLACE VIEW fin.v_purchase_net WITH (security_invoker = true) AS
SELECT p.id AS purchase_id, p.warehouse_id, p.vendor_id, p.vendor_name, p.vendor_invoice_no,
       p.vendor_invoice_date, p.taxable_total AS billed_taxable,
       (p.cgst_total + p.sgst_total + p.igst_total) AS billed_tax,
       p.freight_amount, p.grand_total AS billed_total,
       coalesce(CASE d.discount_type
                  WHEN 'PERCENT' THEN round(p.taxable_total * d.discount_value / 100, 2)
                  WHEN 'AMOUNT'  THEN round(d.discount_value, 2) END, 0)
       + coalesce((SELECT sum(fin.item_discount_amount(x.discount_type, x.discount_value, pi.line_taxable))
                     FROM purchase_items pi JOIN fin.purchase_item_discounts x ON x.purchase_item_id = pi.id
                    WHERE pi.purchase_id = p.id), 0) AS owner_discount,
       d.discount_type, d.discount_value, d.reason AS discount_reason
FROM purchases p
LEFT JOIN fin.purchase_discounts d ON d.purchase_id = p.id
WHERE p.status = 'POSTED';

CREATE OR REPLACE VIEW fin.v_purchase_line_cost WITH (security_invoker = true) AS
SELECT pi.id AS purchase_item_id, pi.purchase_id, n.warehouse_id, n.vendor_id, n.vendor_name,
       n.vendor_invoice_date, pi.product_id, pi.qty_base, pi.line_taxable, pi.line_total,
       pi.gst_rate,
       round(pi.line_taxable / nullif(pi.qty_base, 0), 4) AS billed_unit_cost_base,
       CASE WHEN n.billed_taxable > 0
            THEN round((pi.line_taxable
                        - coalesce(fin.item_discount_amount(xd.discount_type, xd.discount_value, pi.line_taxable), 0)
                        - coalesce(CASE bd.discount_type
                                     WHEN 'PERCENT' THEN round(n.billed_taxable * bd.discount_value / 100, 2)
                                     WHEN 'AMOUNT'  THEN round(bd.discount_value, 2) END, 0)
                          * pi.line_taxable / n.billed_taxable
                        + n.freight_amount * pi.line_taxable / n.billed_taxable) / nullif(pi.qty_base, 0), 4)
            ELSE 0 END AS effective_unit_cost_base
FROM purchase_items pi
JOIN fin.v_purchase_net n ON n.purchase_id = pi.purchase_id
LEFT JOIN fin.purchase_discounts bd ON bd.purchase_id = pi.purchase_id
LEFT JOIN fin.purchase_item_discounts xd ON xd.purchase_item_id = pi.id;

-- ---------------------------------------------------------------------------
-- 2. Purchase editing
-- ---------------------------------------------------------------------------
-- Lines may only be added in the transaction that created the document — except
-- when an OWNER edit RPC has flagged this exact document for re-writing.
CREATE OR REPLACE FUNCTION app.line_snapshot() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, extensions, pg_temp AS $$
DECLARE
  v_factor numeric;
  v_hsn    text;
  v_gst    numeric;
  v_created timestamptz;
  v_status  text;
  v_doc     uuid;
BEGIN
  SELECT factor_to_base INTO v_factor FROM product_uoms
   WHERE product_id = NEW.product_id AND uom_code = NEW.uom_code;
  IF v_factor IS NULL THEN
    RAISE EXCEPTION 'Unit % is not defined for this product', NEW.uom_code USING ERRCODE = 'WH005';
  END IF;
  NEW.conversion_factor := v_factor;

  IF TG_TABLE_NAME = 'purchase_items' THEN
    v_doc := NEW.purchase_id;
    SELECT created_at, status::text INTO v_created, v_status FROM purchases WHERE id = NEW.purchase_id;
  ELSIF TG_TABLE_NAME = 'dispatch_items' THEN
    v_doc := NEW.dispatch_id;
    SELECT created_at, status::text INTO v_created, v_status FROM dispatches WHERE id = NEW.dispatch_id;
  ELSE
    SELECT created_at, status::text INTO v_created, v_status FROM transfer_notes WHERE id = NEW.transfer_note_id;
    IF v_status <> 'DRAFT' THEN
      RAISE EXCEPTION 'Transfer note is no longer editable' USING ERRCODE = 'WH005';
    END IF;
    RETURN NEW;
  END IF;

  IF v_created IS DISTINCT FROM now()
     AND NOT (TG_TABLE_NAME = 'purchase_items'
              AND current_setting('app.editing_doc', true) = v_doc::text
              AND app.is_owner()) THEN
    RAISE EXCEPTION 'Lines can only be added in the transaction that creates the document' USING ERRCODE = 'WH005';
  END IF;

  SELECT hsn_code, default_gst_rate INTO v_hsn, v_gst FROM products WHERE id = NEW.product_id;
  NEW.hsn_code := coalesce(NEW.hsn_code, v_hsn);
  NEW.gst_rate := coalesce(NEW.gst_rate, v_gst);
  RETURN NEW;
END$$;

CREATE FUNCTION app.recompute_purchase_totals(p_id uuid) RETURNS void
LANGUAGE sql SECURITY DEFINER SET search_path = public, extensions, pg_temp AS $$
  UPDATE purchases p SET
    taxable_total = s.taxable,
    igst_total = CASE WHEN p.is_interstate THEN s.tax ELSE 0 END,
    cgst_total = CASE WHEN p.is_interstate THEN 0 ELSE round(s.tax / 2, 2) END,
    sgst_total = CASE WHEN p.is_interstate THEN 0 ELSE s.tax - round(s.tax / 2, 2) END,
    grand_total = s.taxable + s.tax + p.freight_amount
  FROM (SELECT coalesce(sum(line_taxable), 0) AS taxable, coalesce(sum(line_tax), 0) AS tax
          FROM purchase_items WHERE purchase_id = p_id) s
  WHERE p.id = p_id
$$;

-- Full owner view of one purchase: lines, per-item + per-bill discounts, net cost.
CREATE FUNCTION fin.purchase_detail(p_id uuid) RETURNS jsonb
LANGUAGE sql STABLE SET search_path = public, fin, extensions, pg_temp AS $$
  SELECT jsonb_build_object(
    'id', p.id, 'warehouse_id', p.warehouse_id, 'warehouse_code', w.code, 'warehouse_name', w.name,
    'vendor_id', p.vendor_id, 'vendor_name', p.vendor_name, 'vendor_gstin', p.vendor_gstin,
    'vendor_invoice_no', p.vendor_invoice_no, 'vendor_invoice_date', p.vendor_invoice_date,
    'received_on', p.received_on, 'lorry_receipt_no', p.lorry_receipt_no, 'is_interstate', p.is_interstate,
    'freight_amount', p.freight_amount, 'taxable_total', p.taxable_total,
    'tax_total', p.cgst_total + p.sgst_total + p.igst_total, 'grand_total', p.grand_total, 'status', p.status,
    'bill_discount_type', bd.discount_type, 'bill_discount_value', bd.discount_value,
    'bill_discount_reason', bd.reason,
    'bill_discount_amount', coalesce(CASE bd.discount_type
         WHEN 'PERCENT' THEN round(p.taxable_total * bd.discount_value / 100, 2)
         WHEN 'AMOUNT'  THEN round(bd.discount_value, 2) END, 0),
    'total_discount', n.owner_discount,
    'net_taxable', n.net_taxable, 'net_payable', n.net_payable,
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
  LEFT JOIN fin.purchase_discounts bd ON bd.purchase_id = p.id
  LEFT JOIN fin.v_purchase_net_summary n ON n.purchase_id = p.id
  WHERE p.id = p_id
$$;
REVOKE EXECUTE ON FUNCTION fin.purchase_detail(uuid) FROM PUBLIC, anon, authenticated;

/* Edit a saved purchase. p = { vendorInvoiceNo?, vendorInvoiceDate?, lorryReceiptNo?, freightAmount?,
     lines?: [{ productId, uomCode, qty, gstRate, unitBasePrice, unitInclPrice, hsnCode?,
               discountType?, discountValue?, discountReason? }] }
   When `lines` is given the old lines' stock is reversed and the new lines are posted
   (the movement ledger keeps both, and the edit is written to audit_log). */
CREATE FUNCTION public.owner_update_purchase(p_id uuid, p jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, fin, extensions, pg_temp AS $$
DECLARE v purchases; r record;
BEGIN
  PERFORM app.require_owner();
  SELECT * INTO v FROM purchases WHERE id = p_id FOR UPDATE;
  IF NOT FOUND OR v.status <> 'POSTED' THEN
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
    FOR r IN SELECT * FROM purchase_items WHERE purchase_id = p_id ORDER BY line_no LOOP
      PERFORM app.apply_movement(v.warehouse_id, r.product_id, 'REVERSAL', -r.qty_base,
                                 'purchase_items', r.id, p_id, NULL, true);
    END LOOP;
    DELETE FROM purchase_items WHERE purchase_id = p_id;          -- item discounts cascade

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

-- Set / clear the extra discount on one purchase item (value 0 or NULL clears it).
CREATE FUNCTION public.owner_set_item_discount(p_item uuid, p_type text, p_value numeric, p_reason text DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, fin, extensions, pg_temp AS $$
DECLARE v_purchase uuid;
BEGIN
  PERFORM app.require_owner();
  SELECT purchase_id INTO v_purchase FROM purchase_items WHERE id = p_item;
  IF v_purchase IS NULL THEN RAISE EXCEPTION 'Purchase item not found' USING ERRCODE = 'WH005'; END IF;
  IF coalesce(p_value, 0) = 0 THEN
    DELETE FROM fin.purchase_item_discounts WHERE purchase_item_id = p_item;
  ELSE
    INSERT INTO fin.purchase_item_discounts(purchase_item_id, discount_type, discount_value, reason, entered_by)
    VALUES (p_item, p_type, p_value, p_reason, app.current_user_id())
    ON CONFLICT (purchase_item_id) DO UPDATE SET discount_type = EXCLUDED.discount_type,
      discount_value = EXCLUDED.discount_value, reason = EXCLUDED.reason,
      entered_by = EXCLUDED.entered_by, entered_at = now();
  END IF;
  RETURN fin.purchase_detail(v_purchase);
END$$;

-- Bill-level discount: value 0 now clears it.
CREATE OR REPLACE FUNCTION public.owner_set_purchase_discount(p_purchase uuid, p_type text, p_value numeric, p_reason text DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, fin, extensions, pg_temp AS $$
BEGIN
  PERFORM app.require_owner();
  IF coalesce(p_value, 0) = 0 THEN
    DELETE FROM fin.purchase_discounts WHERE purchase_id = p_purchase;
  ELSE
    INSERT INTO fin.purchase_discounts(purchase_id, discount_type, discount_value, reason, entered_by)
    VALUES (p_purchase, p_type, p_value, p_reason, app.current_user_id())
    ON CONFLICT (purchase_id) DO UPDATE SET discount_type = EXCLUDED.discount_type, discount_value = EXCLUDED.discount_value,
      reason = EXCLUDED.reason, entered_by = EXCLUDED.entered_by, entered_at = now();
  END IF;
  RETURN (SELECT row_to_json(n)::jsonb FROM fin.v_purchase_net_summary n WHERE n.purchase_id = p_purchase);
END$$;

-- ---------------------------------------------------------------------------
-- 4. Purchase register for one month (by vendor invoice date), with items.
-- ---------------------------------------------------------------------------
CREATE FUNCTION public.owner_purchases_month(p_month date, p_warehouse uuid DEFAULT NULL) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, fin, extensions, pg_temp AS $$
DECLARE v_from date := date_trunc('month', p_month)::date;
BEGIN
  PERFORM app.require_owner();
  RETURN (SELECT coalesce(jsonb_agg(fin.purchase_detail(p.id) ORDER BY p.vendor_invoice_date, p.vendor_invoice_no), '[]')
            FROM purchases p
           WHERE p.status = 'POSTED'
             AND p.vendor_invoice_date >= v_from AND p.vendor_invoice_date < (v_from + interval '1 month')
             AND (p_warehouse IS NULL OR p.warehouse_id = p_warehouse));
END$$;

CREATE FUNCTION public.owner_purchase_detail(p_id uuid) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, fin, extensions, pg_temp AS $$
BEGIN
  PERFORM app.require_owner();
  RETURN fin.purchase_detail(p_id);
END$$;

-- ---------------------------------------------------------------------------
-- 3. Set a stock count directly (owner). Posts the difference as an adjustment.
-- ---------------------------------------------------------------------------
CREATE FUNCTION public.owner_set_stock(p_warehouse uuid, p_product uuid, p_new_qty_base numeric,
                                       p_reason text DEFAULT 'ADJUST_AUDIT', p_notes text DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, extensions, pg_temp AS $$
DECLARE v_old numeric; v_delta numeric;
BEGIN
  PERFORM app.require_owner();
  IF p_reason NOT IN ('ADJUST_AUDIT', 'ADJUST_DAMAGE', 'ADJUST_LOSS', 'ADJUST_FOUND', 'OPENING') THEN
    RAISE EXCEPTION 'Unknown adjustment reason %', p_reason USING ERRCODE = 'WH005';
  END IF;
  IF p_new_qty_base IS NULL OR p_new_qty_base < 0 THEN
    RAISE EXCEPTION 'Quantity must be 0 or more' USING ERRCODE = 'WH005';
  END IF;
  SELECT qty_on_hand INTO v_old FROM inventory_levels
   WHERE warehouse_id = p_warehouse AND product_id = p_product FOR UPDATE;
  v_old := coalesce(v_old, 0);
  v_delta := p_new_qty_base - v_old;
  IF v_delta <> 0 THEN
    INSERT INTO stock_adjustments(warehouse_id, product_id, movement, qty_delta_base, notes)
    VALUES (p_warehouse, p_product, p_reason::movement_type, v_delta, p_notes);
  END IF;
  RETURN jsonb_build_object('old_qty', v_old, 'new_qty', p_new_qty_base, 'delta', v_delta);
END$$;

-- ---------------------------------------------------------------------------
-- Privileges
-- ---------------------------------------------------------------------------
REVOKE EXECUTE ON FUNCTION
  app.recompute_purchase_totals(uuid),
  public.owner_update_purchase(uuid, jsonb), public.owner_set_item_discount(uuid, text, numeric, text),
  public.owner_purchases_month(date, uuid), public.owner_purchase_detail(uuid),
  public.owner_set_stock(uuid, uuid, numeric, text, text)
FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION
  public.owner_update_purchase(uuid, jsonb), public.owner_set_item_discount(uuid, text, numeric, text),
  public.owner_purchases_month(date, uuid), public.owner_purchase_detail(uuid),
  public.owner_set_stock(uuid, uuid, numeric, text, text),
  public.owner_set_purchase_discount(uuid, text, numeric, text)
TO authenticated;

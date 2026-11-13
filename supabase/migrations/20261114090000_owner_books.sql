-- Owner add-ins (B):
--   Manager role (limited owner) · business profile for printed invoices · suppliers page + supplier payments
--   (money owed) · customers page (edit, merge, credit limit, due days) · expenses, cash book, profit & loss ·
--   edit a sales bill (revision history kept) · sales returns (credit notes) and purchase returns (debit notes) ·
--   GST reports (GSTR-1 / 3B / HSN / documents) · bulk price change · bulk reorder levels · owner transfers
--   (cancel) · stock count mode · activity log · hide / merge items, item photos · export everything.

ALTER TYPE movement_type ADD VALUE IF NOT EXISTS 'SALES_RETURN';
ALTER TYPE movement_type ADD VALUE IF NOT EXISTS 'PURCHASE_RETURN';

-- ===========================================================================
-- Manager (role ADMIN, shown as "Manager"): runs the business day to day but cannot touch logins, passwords,
-- security, WhatsApp settings, money settings, prices, targets, profit & loss, or cancel / edit bills.
-- ===========================================================================
CREATE FUNCTION app.require_full_owner() RETURNS void
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, extensions, pg_temp AS $$
BEGIN
  IF coalesce(app.current_app_role()::text, '') <> 'OWNER' THEN
    RAISE EXCEPTION 'Only the owner can do this (not available to managers)' USING ERRCODE = 'WH002';
  END IF;
END$$;

DO $$
DECLARE f text; def text;
BEGIN
  FOREACH f IN ARRAY ARRAY[
    'public.owner_save_security_settings(jsonb)', 'public.owner_logout_everywhere(uuid)',
    'public.owner_set_device(uuid,text,text)', 'public.owner_save_notification_settings(jsonb)', 'app.set_override_pin(text)',
    'public.owner_staff_password(uuid)', 'public.owner_update_user(uuid,boolean,uuid,text)', 'public.owner_set_sales_target(uuid,date,numeric,text)',
    'public.owner_delete_payment(uuid)', 'public.owner_import_catalog(text,text,jsonb)', 'public.owner_set_purchase_discount(uuid,text,numeric,text)',
    'public.owner_set_purchase_credits(uuid,jsonb,numeric)', 'public.owner_set_item_discount(uuid,text,numeric,text)',
    'public.owner_use_credit(jsonb)', 'public.owner_delete_credit_use(uuid)', 'app.cancel_dispatch(uuid,text)',
    'app.cancel_purchase(uuid,text)', 'public.owner_fix_attendance(uuid,timestamptz,timestamptz)']
  LOOP
    def := pg_get_functiondef(f::regprocedure);
    IF position('PERFORM app.require_owner();' IN def) = 0 THEN
      RAISE EXCEPTION 'manager patch: % has no require_owner call', f;
    END IF;
    EXECUTE replace(def, 'PERFORM app.require_owner();', 'PERFORM app.require_full_owner();');
  END LOOP;
END$$;

-- ===========================================================================
-- Business profile (printed on invoices) — one settings row
-- ===========================================================================
INSERT INTO app_settings(key, value) VALUES ('business', jsonb_build_object(
  'name', '', 'address', '', 'phone', '', 'email', '',
  'bank_name', '', 'bank_account', '', 'bank_ifsc', '', 'upi_id', '',
  'terms', 'Goods once sold will be taken back only as per our return terms. Subject to local jurisdiction. E. & O.E.',
  'opening_cash', 0, 'opening_bank', 0, 'opening_date', NULL
)) ON CONFLICT (key) DO NOTHING;

CREATE FUNCTION public.business_profile() RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, extensions, pg_temp AS $$
BEGIN
  PERFORM app.require_user();
  RETURN coalesce(app.setting('business'), '{}') - 'opening_cash' - 'opening_bank' - 'opening_date' || jsonb_build_object(
    'warehouses', (SELECT coalesce(jsonb_agg(jsonb_build_object('id', id, 'code', code, 'name', name, 'address', address,
                                     'state_code', state_code, 'gstin', gstin) ORDER BY code), '[]') FROM warehouses WHERE is_active));
END$$;

CREATE FUNCTION public.owner_business_settings() RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, extensions, pg_temp AS $$
BEGIN PERFORM app.require_full_owner(); RETURN app.setting('business'); END$$;

CREATE FUNCTION public.owner_save_business(p jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, extensions, pg_temp AS $$
DECLARE v jsonb := '{}'; k text;
BEGIN
  PERFORM app.require_full_owner();
  FOREACH k IN ARRAY ARRAY['name', 'address', 'phone', 'email', 'bank_name', 'bank_account', 'bank_ifsc', 'upi_id', 'terms'] LOOP
    IF length(coalesce(p->>k, '')) > 600 THEN RAISE EXCEPTION '% is too long', k USING ERRCODE = 'WH005'; END IF;
    v := v || jsonb_build_object(k, btrim(coalesce(p->>k, '')));
  END LOOP;
  v := v || jsonb_build_object('bank_ifsc', upper(v->>'bank_ifsc'));
  IF v->>'bank_ifsc' <> '' AND v->>'bank_ifsc' !~ '^[A-Z]{4}0[A-Z0-9]{6}$' THEN
    RAISE EXCEPTION 'IFSC should look like SBIN0001234' USING ERRCODE = 'WH005';
  END IF;
  v := v || jsonb_build_object(
    'opening_cash', round(coalesce(nullif(p->>'opening_cash', '')::numeric, 0), 2),
    'opening_bank', round(coalesce(nullif(p->>'opening_bank', '')::numeric, 0), 2),
    'opening_date', nullif(p->>'opening_date', '')::date);
  INSERT INTO app_settings(key, value, updated_by, updated_at) VALUES ('business', v, app.current_user_id(), now())
  ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_by = EXCLUDED.updated_by, updated_at = now();
  RETURN v;
END$$;

-- ===========================================================================
-- Returns (credit notes for customers, debit notes to suppliers)
-- ===========================================================================
CREATE SEQUENCE return_note_seq;

ALTER TABLE vendors
  ADD COLUMN default_discount_pct numeric(5,2) NOT NULL DEFAULT 0 CHECK (default_discount_pct BETWEEN 0 AND 100),
  ADD COLUMN credit_days int NOT NULL DEFAULT 30 CHECK (credit_days BETWEEN 0 AND 365),
  ADD COLUMN notes text;
ALTER TABLE customers ADD COLUMN notes text;

CREATE TABLE fin.vendor_payments (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  vendor_id    uuid NOT NULL REFERENCES vendors(id),
  amount       numeric(14,2) NOT NULL CHECK (amount > 0),
  paid_on      date NOT NULL DEFAULT app.today_ist(),
  mode         text NOT NULL CHECK (mode IN ('CASH','UPI','NEFT','RTGS','IMPS','CHEQUE','CARD','DEBIT_NOTE','OTHER')),
  reference    text,
  notes        text,
  purchase_id  uuid REFERENCES purchases(id),
  entered_by   uuid NOT NULL REFERENCES users(id),
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX vendor_payments_vendor_idx ON fin.vendor_payments(vendor_id, paid_on);

CREATE TABLE sales_returns (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  return_no        text NOT NULL UNIQUE,
  dispatch_id      uuid NOT NULL REFERENCES dispatches(id),
  warehouse_id     uuid NOT NULL REFERENCES warehouses(id),
  customer_id      uuid NOT NULL REFERENCES customers(id),
  return_date      date NOT NULL DEFAULT app.today_ist(),
  reason           text NOT NULL,
  taxable          numeric(14,2) NOT NULL DEFAULT 0,
  tax              numeric(14,2) NOT NULL DEFAULT 0,
  total            numeric(14,2) NOT NULL DEFAULT 0,
  status           text NOT NULL DEFAULT 'POSTED' CHECK (status IN ('POSTED', 'CANCELLED')),
  payment_id       uuid,            -- the CREDIT_NOTE row in fin.customer_payments that lowers the balance
  cancelled_reason text,
  created_by       uuid NOT NULL REFERENCES users(id),
  created_at       timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE sales_return_items (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  return_id         uuid NOT NULL REFERENCES sales_returns(id) ON DELETE CASCADE,
  dispatch_item_id  uuid REFERENCES dispatch_items(id) ON DELETE SET NULL,   -- kept while the return is active (edits are blocked)
  product_id        uuid NOT NULL REFERENCES products(id),
  qty_base          numeric(14,3) NOT NULL CHECK (qty_base > 0),
  gst_rate          numeric(5,2) NOT NULL,
  taxable           numeric(14,2) NOT NULL,
  tax               numeric(14,2) NOT NULL,
  total             numeric(14,2) NOT NULL
);
CREATE INDEX sales_returns_dispatch_idx ON sales_returns(dispatch_id);
CREATE INDEX sales_return_items_line_idx ON sales_return_items(dispatch_item_id);

CREATE TABLE purchase_returns (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  return_no        text NOT NULL UNIQUE,
  purchase_id      uuid NOT NULL REFERENCES purchases(id),
  warehouse_id     uuid NOT NULL REFERENCES warehouses(id),
  vendor_id        uuid NOT NULL REFERENCES vendors(id),
  return_date      date NOT NULL DEFAULT app.today_ist(),
  reason           text NOT NULL,
  taxable          numeric(14,2) NOT NULL DEFAULT 0,
  tax              numeric(14,2) NOT NULL DEFAULT 0,
  total            numeric(14,2) NOT NULL DEFAULT 0,
  status           text NOT NULL DEFAULT 'POSTED' CHECK (status IN ('POSTED', 'CANCELLED')),
  payment_id       uuid,            -- the DEBIT_NOTE row in fin.vendor_payments that lowers what we owe
  cancelled_reason text,
  created_by       uuid NOT NULL REFERENCES users(id),
  created_at       timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE purchase_return_items (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  return_id         uuid NOT NULL REFERENCES purchase_returns(id) ON DELETE CASCADE,
  purchase_item_id  uuid REFERENCES purchase_items(id) ON DELETE SET NULL,
  product_id        uuid NOT NULL REFERENCES products(id),
  qty_base          numeric(14,3) NOT NULL CHECK (qty_base > 0),
  gst_rate          numeric(5,2) NOT NULL,
  taxable           numeric(14,2) NOT NULL,
  tax               numeric(14,2) NOT NULL,
  total             numeric(14,2) NOT NULL
);
CREATE INDEX purchase_returns_purchase_idx ON purchase_returns(purchase_id);

CREATE TABLE fin.expenses (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  spent_on     date NOT NULL DEFAULT app.today_ist(),
  warehouse_id uuid REFERENCES warehouses(id),
  category     text NOT NULL CHECK (length(btrim(category)) BETWEEN 2 AND 40),
  amount       numeric(14,2) NOT NULL CHECK (amount > 0),
  mode         text NOT NULL DEFAULT 'CASH' CHECK (mode IN ('CASH','UPI','NEFT','RTGS','IMPS','CHEQUE','CARD','OTHER')),
  paid_to      text,
  notes        text,
  created_by   uuid NOT NULL REFERENCES users(id),
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX expenses_date_idx ON fin.expenses(spent_on);

CREATE TABLE dispatch_revisions (
  id           bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  dispatch_id  uuid NOT NULL REFERENCES dispatches(id) ON DELETE CASCADE,
  revision     int NOT NULL,
  snapshot     jsonb NOT NULL,
  reason       text,
  edited_by    uuid NOT NULL REFERENCES users(id),
  edited_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (dispatch_id, revision)
);

CREATE TABLE stock_counts (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  warehouse_id uuid NOT NULL REFERENCES warehouses(id),
  brand_id     uuid REFERENCES brands(id),
  note         text,
  status       text NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN', 'APPLIED', 'DISCARDED')),
  started_by   uuid NOT NULL REFERENCES users(id),
  started_at   timestamptz NOT NULL DEFAULT now(),
  finished_by  uuid REFERENCES users(id),
  finished_at  timestamptz,
  result       jsonb
);
CREATE UNIQUE INDEX stock_counts_one_open ON stock_counts(warehouse_id) WHERE status = 'OPEN';
CREATE TABLE stock_count_lines (
  count_id     uuid NOT NULL REFERENCES stock_counts(id) ON DELETE CASCADE,
  product_id   uuid NOT NULL REFERENCES products(id),
  counted_qty  numeric(14,3) NOT NULL CHECK (counted_qty >= 0),
  counted_by   uuid NOT NULL REFERENCES users(id),
  counted_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (count_id, product_id)
);

ALTER TABLE fin.vendor_payments ENABLE ROW LEVEL SECURITY;
ALTER TABLE fin.expenses ENABLE ROW LEVEL SECURITY;
ALTER TABLE sales_returns ENABLE ROW LEVEL SECURITY;
ALTER TABLE sales_return_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE purchase_returns ENABLE ROW LEVEL SECURITY;
ALTER TABLE purchase_return_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE dispatch_revisions ENABLE ROW LEVEL SECURITY;
ALTER TABLE stock_counts ENABLE ROW LEVEL SECURITY;
ALTER TABLE stock_count_lines ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON fin.vendor_payments, fin.expenses FROM PUBLIC, anon, authenticated;
REVOKE ALL ON sales_returns, sales_return_items, purchase_returns, purchase_return_items, dispatch_revisions,
  stock_counts, stock_count_lines FROM PUBLIC, anon, authenticated;
REVOKE ALL ON SEQUENCE return_note_seq FROM PUBLIC, anon, authenticated;

-- A credit / debit note row cannot be deleted while its return is active (cancel the return instead).
CREATE FUNCTION app.guard_note_payment() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, extensions, pg_temp AS $$
BEGIN
  IF TG_TABLE_NAME = 'customer_payments' AND EXISTS (SELECT 1 FROM sales_returns WHERE payment_id = OLD.id AND status = 'POSTED') THEN
    RAISE EXCEPTION 'This is a credit note from a goods return — cancel the return instead' USING ERRCODE = 'WH005';
  END IF;
  IF TG_TABLE_NAME = 'vendor_payments' AND EXISTS (SELECT 1 FROM purchase_returns WHERE payment_id = OLD.id AND status = 'POSTED') THEN
    RAISE EXCEPTION 'This is a debit note from a purchase return — cancel the return instead' USING ERRCODE = 'WH005';
  END IF;
  RETURN OLD;
END$$;
CREATE TRIGGER customer_payments_note_guard BEFORE DELETE ON fin.customer_payments FOR EACH ROW EXECUTE FUNCTION app.guard_note_payment();
CREATE TRIGGER vendor_payments_note_guard BEFORE DELETE ON fin.vendor_payments FOR EACH ROW EXECUTE FUNCTION app.guard_note_payment();

-- "Payments received" in the daily report = money in, not credit notes.
DO $$
DECLARE def text := pg_get_functiondef('app.daily_report(date)'::regprocedure);
BEGIN
  IF position('FROM fin.customer_payments WHERE paid_on = p_date)' IN def) = 0 THEN RAISE EXCEPTION 'daily_report patch target missing'; END IF;
  EXECUTE replace(def, 'FROM fin.customer_payments WHERE paid_on = p_date)', 'FROM fin.customer_payments WHERE paid_on = p_date AND mode <> ''CREDIT_NOTE'')');
END$$;

CREATE FUNCTION app.next_note_no(p_prefix text, p_wh uuid, p_date date) RETURNS text
LANGUAGE sql SECURITY DEFINER SET search_path = public, extensions, pg_temp AS $$
  SELECT p_prefix || '/' || (SELECT code FROM warehouses WHERE id = p_wh) || '/' || app.fy_label(p_date) || '/'
         || lpad(nextval('return_note_seq')::text, 5, '0')
$$;

CREATE FUNCTION app.sales_return_json(p_id uuid) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, extensions, pg_temp AS $$
  SELECT jsonb_build_object('id', r.id, 'return_no', r.return_no, 'return_date', r.return_date, 'reason', r.reason,
    'dispatch_id', r.dispatch_id, 'invoice_no', d.invoice_no, 'invoice_date', d.invoice_date, 'customer_id', r.customer_id,
    'customer_name', c.name, 'customer_gstin', c.gstin, 'warehouse_id', r.warehouse_id, 'warehouse_code', w.code,
    'taxable', r.taxable, 'tax', r.tax, 'total', r.total, 'status', r.status, 'cancelled_reason', r.cancelled_reason,
    'is_interstate', d.is_interstate, 'place_of_supply', d.place_of_supply,
    'entered_by', u.full_name, 'created_at', r.created_at,
    'lines', (SELECT coalesce(jsonb_agg(jsonb_build_object('product_id', i.product_id, 'sku_code', p.sku_code, 'name', p.name,
                'hsn_code', coalesce(di.hsn_code, p.hsn_code), 'qty_base', i.qty_base, 'gst_rate', i.gst_rate, 'taxable', i.taxable, 'tax', i.tax, 'total', i.total)
                ORDER BY di.line_no), '[]')
                FROM sales_return_items i LEFT JOIN dispatch_items di ON di.id = i.dispatch_item_id JOIN products p ON p.id = i.product_id
               WHERE i.return_id = r.id))
    FROM sales_returns r JOIN dispatches d ON d.id = r.dispatch_id JOIN customers c ON c.id = r.customer_id
    JOIN warehouses w ON w.id = r.warehouse_id JOIN users u ON u.id = r.created_by
   WHERE r.id = p_id
$$;

CREATE FUNCTION app.purchase_return_json(p_id uuid) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, extensions, pg_temp AS $$
  SELECT jsonb_build_object('id', r.id, 'return_no', r.return_no, 'return_date', r.return_date, 'reason', r.reason,
    'purchase_id', r.purchase_id, 'vendor_invoice_no', pu.vendor_invoice_no, 'vendor_invoice_date', pu.vendor_invoice_date,
    'vendor_id', r.vendor_id, 'vendor_name', v.name, 'vendor_gstin', v.gstin, 'warehouse_id', r.warehouse_id, 'warehouse_code', w.code,
    'taxable', r.taxable, 'tax', r.tax, 'total', r.total, 'status', r.status, 'cancelled_reason', r.cancelled_reason,
    'is_interstate', pu.is_interstate, 'entered_by', u.full_name, 'created_at', r.created_at,
    'lines', (SELECT coalesce(jsonb_agg(jsonb_build_object('product_id', i.product_id, 'sku_code', p.sku_code, 'name', p.name,
                'hsn_code', coalesce(pi.hsn_code, p.hsn_code), 'qty_base', i.qty_base, 'gst_rate', i.gst_rate, 'taxable', i.taxable, 'tax', i.tax, 'total', i.total)
                ORDER BY pi.line_no), '[]')
                FROM purchase_return_items i LEFT JOIN purchase_items pi ON pi.id = i.purchase_item_id JOIN products p ON p.id = i.product_id
               WHERE i.return_id = r.id))
    FROM purchase_returns r JOIN purchases pu ON pu.id = r.purchase_id JOIN vendors v ON v.id = r.vendor_id
    JOIN warehouses w ON w.id = r.warehouse_id JOIN users u ON u.id = r.created_by
   WHERE r.id = p_id
$$;

-- What can still be returned from a bill (sold − already returned), per line.
CREATE FUNCTION public.returnable_lines(p_kind text, p_doc uuid) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, extensions, pg_temp AS $$
BEGIN
  PERFORM app.require_owner();
  IF p_kind = 'sale' THEN
    RETURN (SELECT coalesce(jsonb_agg(jsonb_build_object('line_id', di.id, 'line_no', di.line_no, 'product_id', di.product_id,
              'sku_code', p.sku_code, 'name', p.name, 'uom', di.uom_code, 'factor', di.conversion_factor, 'qty', di.qty,
              'qty_base', di.qty_base, 'gst_rate', di.gst_rate, 'line_taxable', di.line_taxable, 'line_total', di.line_total,
              'returned_base', coalesce(rt.q, 0), 'returnable_base', di.qty_base - coalesce(rt.q, 0)) ORDER BY di.line_no), '[]')
              FROM dispatch_items di JOIN products p ON p.id = di.product_id
              LEFT JOIN LATERAL (SELECT sum(i.qty_base) q FROM sales_return_items i JOIN sales_returns r ON r.id = i.return_id
                                  WHERE i.dispatch_item_id = di.id AND r.status = 'POSTED') rt ON true
             WHERE di.dispatch_id = p_doc);
  END IF;
  RETURN (SELECT coalesce(jsonb_agg(jsonb_build_object('line_id', pi.id, 'line_no', pi.line_no, 'product_id', pi.product_id,
            'sku_code', p.sku_code, 'name', p.name, 'uom', pi.uom_code, 'factor', pi.conversion_factor, 'qty', pi.qty,
            'qty_base', pi.qty_base, 'gst_rate', pi.gst_rate, 'line_taxable', pi.line_taxable, 'line_total', pi.line_total,
            'returned_base', coalesce(rt.q, 0), 'returnable_base', pi.qty_base - coalesce(rt.q, 0)) ORDER BY pi.line_no), '[]')
            FROM purchase_items pi JOIN products p ON p.id = pi.product_id
            LEFT JOIN LATERAL (SELECT sum(i.qty_base) q FROM purchase_return_items i JOIN purchase_returns r ON r.id = i.return_id
                                WHERE i.purchase_item_id = pi.id AND r.status = 'POSTED') rt ON true
           WHERE pi.purchase_id = p_doc);
END$$;

-- p = { dispatchId, returnDate?, reason, lines: [{ lineId, qtyBase }] }
CREATE FUNCTION public.create_sales_return(p jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, fin, extensions, pg_temp AS $$
DECLARE d dispatches; v_id uuid; v_date date; e jsonb; di dispatch_items; v_left numeric; v_q numeric; v_tx numeric; v_tax numeric;
        v_item uuid; v_pay uuid; v_no text; v_any boolean := false;
BEGIN
  PERFORM app.require_owner();
  SELECT * INTO d FROM dispatches WHERE id = (p->>'dispatchId')::uuid FOR UPDATE;
  IF NOT FOUND OR d.status <> 'POSTED' THEN RAISE EXCEPTION 'Bill not found or cancelled' USING ERRCODE = 'WH005'; END IF;
  IF length(btrim(coalesce(p->>'reason', ''))) < 3 THEN RAISE EXCEPTION 'Please give a reason for the return' USING ERRCODE = 'WH005'; END IF;
  v_date := coalesce(nullif(p->>'returnDate', '')::date, app.today_ist());
  IF v_date < d.invoice_date OR v_date > app.today_ist() THEN
    RAISE EXCEPTION 'Return date must be between the bill date and today' USING ERRCODE = 'WH005';
  END IF;
  v_no := app.next_note_no('CN', d.warehouse_id, v_date);
  INSERT INTO sales_returns(return_no, dispatch_id, warehouse_id, customer_id, return_date, reason, created_by)
  VALUES (v_no, d.id, d.warehouse_id, d.customer_id, v_date, btrim(p->>'reason'), app.current_user_id()) RETURNING id INTO v_id;

  FOR e IN SELECT * FROM jsonb_array_elements(coalesce(p->'lines', '[]')) LOOP
    v_q := round(coalesce(nullif(e->>'qtyBase', '')::numeric, 0), 3);
    CONTINUE WHEN v_q = 0;
    SELECT * INTO di FROM dispatch_items WHERE id = (e->>'lineId')::uuid AND dispatch_id = d.id;
    IF NOT FOUND THEN RAISE EXCEPTION 'Line is not on this bill' USING ERRCODE = 'WH005'; END IF;
    SELECT di.qty_base - coalesce(sum(i.qty_base), 0) INTO v_left FROM sales_return_items i JOIN sales_returns r ON r.id = i.return_id
     WHERE i.dispatch_item_id = di.id AND r.status = 'POSTED' AND r.id <> v_id;
    IF v_q < 0 OR v_q > v_left THEN
      RAISE EXCEPTION 'Line %: you can return at most % (base units)', di.line_no, v_left USING ERRCODE = 'WH005';
    END IF;
    v_tx := round(di.line_taxable * v_q / di.qty_base, 2);
    v_tax := round(v_tx * di.gst_rate / 100, 2);
    INSERT INTO sales_return_items(return_id, dispatch_item_id, product_id, qty_base, gst_rate, taxable, tax, total)
    VALUES (v_id, di.id, di.product_id, v_q, di.gst_rate, v_tx, v_tax, v_tx + v_tax) RETURNING id INTO v_item;
    PERFORM app.apply_movement(d.warehouse_id, di.product_id, 'SALES_RETURN', v_q, 'sales_return_items', v_item, v_id);
    v_any := true;
  END LOOP;
  IF NOT v_any THEN RAISE EXCEPTION 'Enter the quantity returned for at least one item' USING ERRCODE = 'WH005'; END IF;

  UPDATE sales_returns r SET taxable = x.tx, tax = x.tax, total = x.tot
    FROM (SELECT sum(taxable) tx, sum(tax) tax, sum(total) tot FROM sales_return_items WHERE return_id = v_id) x
   WHERE r.id = v_id;
  INSERT INTO fin.customer_payments(customer_id, amount, paid_on, mode, reference, notes, entered_by, warehouse_id)
  SELECT d.customer_id, total, v_date, 'CREDIT_NOTE', v_no, 'Goods returned from ' || d.invoice_no || ': ' || reason, app.current_user_id(), d.warehouse_id
    FROM sales_returns WHERE id = v_id RETURNING id INTO v_pay;
  UPDATE sales_returns SET payment_id = v_pay WHERE id = v_id;
  RETURN app.sales_return_json(v_id);
END$$;

CREATE FUNCTION public.owner_cancel_sales_return(p_id uuid, p_reason text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, fin, extensions, pg_temp AS $$
DECLARE r sales_returns; i record;
BEGIN
  PERFORM app.require_full_owner();
  SELECT * INTO r FROM sales_returns WHERE id = p_id FOR UPDATE;
  IF NOT FOUND OR r.status <> 'POSTED' THEN RAISE EXCEPTION 'Return not found or already cancelled' USING ERRCODE = 'WH005'; END IF;
  FOR i IN SELECT * FROM sales_return_items WHERE return_id = p_id LOOP
    PERFORM app.apply_movement(r.warehouse_id, i.product_id, 'REVERSAL', -i.qty_base, 'sales_return_items', i.id, p_id, NULL, true);
  END LOOP;
  UPDATE sales_returns SET status = 'CANCELLED', cancelled_reason = nullif(btrim(p_reason), '') WHERE id = p_id;
  DELETE FROM fin.customer_payments WHERE id = r.payment_id;
END$$;

-- p = { purchaseId, returnDate?, reason, lines: [{ lineId, qtyBase }] }
CREATE FUNCTION public.create_purchase_return(p jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, fin, extensions, pg_temp AS $$
DECLARE pu purchases; v_id uuid; v_date date; e jsonb; pi purchase_items; v_left numeric; v_q numeric; v_tx numeric; v_tax numeric;
        v_item uuid; v_pay uuid; v_no text; v_any boolean := false;
BEGIN
  PERFORM app.require_owner();
  SELECT * INTO pu FROM purchases WHERE id = (p->>'purchaseId')::uuid FOR UPDATE;
  IF NOT FOUND OR pu.status <> 'POSTED' THEN RAISE EXCEPTION 'Purchase not found, waiting for approval, or cancelled' USING ERRCODE = 'WH005'; END IF;
  IF length(btrim(coalesce(p->>'reason', ''))) < 3 THEN RAISE EXCEPTION 'Please give a reason for the return' USING ERRCODE = 'WH005'; END IF;
  v_date := coalesce(nullif(p->>'returnDate', '')::date, app.today_ist());
  IF v_date > app.today_ist() THEN RAISE EXCEPTION 'Return date cannot be in the future' USING ERRCODE = 'WH005'; END IF;
  v_no := app.next_note_no('DN', pu.warehouse_id, v_date);
  INSERT INTO purchase_returns(return_no, purchase_id, warehouse_id, vendor_id, return_date, reason, created_by)
  VALUES (v_no, pu.id, pu.warehouse_id, pu.vendor_id, v_date, btrim(p->>'reason'), app.current_user_id()) RETURNING id INTO v_id;

  FOR e IN SELECT * FROM jsonb_array_elements(coalesce(p->'lines', '[]')) LOOP
    v_q := round(coalesce(nullif(e->>'qtyBase', '')::numeric, 0), 3);
    CONTINUE WHEN v_q = 0;
    SELECT * INTO pi FROM purchase_items WHERE id = (e->>'lineId')::uuid AND purchase_id = pu.id;
    IF NOT FOUND THEN RAISE EXCEPTION 'Line is not on this purchase' USING ERRCODE = 'WH005'; END IF;
    SELECT pi.qty_base - coalesce(sum(i.qty_base), 0) INTO v_left FROM purchase_return_items i JOIN purchase_returns r ON r.id = i.return_id
     WHERE i.purchase_item_id = pi.id AND r.status = 'POSTED' AND r.id <> v_id;
    IF v_q < 0 OR v_q > v_left THEN
      RAISE EXCEPTION 'Line %: you can return at most % (base units)', pi.line_no, v_left USING ERRCODE = 'WH005';
    END IF;
    v_tx := round(pi.line_taxable * v_q / pi.qty_base, 2);
    v_tax := round(v_tx * pi.gst_rate / 100, 2);
    INSERT INTO purchase_return_items(return_id, purchase_item_id, product_id, qty_base, gst_rate, taxable, tax, total)
    VALUES (v_id, pi.id, pi.product_id, v_q, pi.gst_rate, v_tx, v_tax, v_tx + v_tax) RETURNING id INTO v_item;
    PERFORM app.apply_movement(pu.warehouse_id, pi.product_id, 'PURCHASE_RETURN', -v_q, 'purchase_return_items', v_item, v_id);
    v_any := true;
  END LOOP;
  IF NOT v_any THEN RAISE EXCEPTION 'Enter the quantity returned for at least one item' USING ERRCODE = 'WH005'; END IF;

  UPDATE purchase_returns r SET taxable = x.tx, tax = x.tax, total = x.tot
    FROM (SELECT sum(taxable) tx, sum(tax) tax, sum(total) tot FROM purchase_return_items WHERE return_id = v_id) x
   WHERE r.id = v_id;
  INSERT INTO fin.vendor_payments(vendor_id, amount, paid_on, mode, reference, notes, purchase_id, entered_by)
  SELECT pu.vendor_id, total, v_date, 'DEBIT_NOTE', v_no, 'Goods returned against ' || coalesce(pu.vendor_invoice_no, 'bill') || ': ' || reason,
         pu.id, app.current_user_id()
    FROM purchase_returns WHERE id = v_id RETURNING id INTO v_pay;
  UPDATE purchase_returns SET payment_id = v_pay WHERE id = v_id;
  RETURN app.purchase_return_json(v_id);
END$$;

CREATE FUNCTION public.owner_cancel_purchase_return(p_id uuid, p_reason text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, fin, extensions, pg_temp AS $$
DECLARE r purchase_returns; i record;
BEGIN
  PERFORM app.require_full_owner();
  SELECT * INTO r FROM purchase_returns WHERE id = p_id FOR UPDATE;
  IF NOT FOUND OR r.status <> 'POSTED' THEN RAISE EXCEPTION 'Return not found or already cancelled' USING ERRCODE = 'WH005'; END IF;
  FOR i IN SELECT * FROM purchase_return_items WHERE return_id = p_id LOOP
    PERFORM app.apply_movement(r.warehouse_id, i.product_id, 'REVERSAL', i.qty_base, 'purchase_return_items', i.id, p_id, NULL, true);
  END LOOP;
  UPDATE purchase_returns SET status = 'CANCELLED', cancelled_reason = nullif(btrim(p_reason), '') WHERE id = p_id;
  DELETE FROM fin.vendor_payments WHERE id = r.payment_id;
END$$;

CREATE FUNCTION public.owner_returns(p_from date, p_to date) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, extensions, pg_temp AS $$
BEGIN
  PERFORM app.require_owner();
  RETURN jsonb_build_object(
    'sales', (SELECT coalesce(jsonb_agg(app.sales_return_json(id) ORDER BY return_date DESC, created_at DESC), '[]')
                FROM sales_returns WHERE return_date BETWEEN p_from AND p_to),
    'purchases', (SELECT coalesce(jsonb_agg(app.purchase_return_json(id) ORDER BY return_date DESC, created_at DESC), '[]')
                    FROM purchase_returns WHERE return_date BETWEEN p_from AND p_to));
END$$;

-- A purchase with goods returned cannot have its lines rewritten.
DO $$
DECLARE def text := pg_get_functiondef('public.owner_update_purchase(uuid,jsonb)'::regprocedure);
BEGIN
  IF position('IF p ? ''lines'' THEN' IN def) = 0 THEN RAISE EXCEPTION 'owner_update_purchase patch target missing'; END IF;
  EXECUTE replace(def, 'IF p ? ''lines'' THEN', 'IF p ? ''lines'' AND EXISTS (SELECT 1 FROM purchase_returns WHERE purchase_id = p_id AND status = ''POSTED'') THEN
    RAISE EXCEPTION ''Goods from this purchase were returned — cancel the return before changing its items'' USING ERRCODE = ''WH005'';
  END IF;
  IF p ? ''lines'' THEN');
END$$;

-- ===========================================================================
-- Edit a sales bill (owner): same bill number, stock re-posted, old version kept in dispatch_revisions
-- ===========================================================================
DO $$
DECLARE def text := pg_get_functiondef('app.line_snapshot()'::regprocedure);
BEGIN
  IF position('AND NOT (TG_TABLE_NAME = ''purchase_items''' IN def) = 0 THEN RAISE EXCEPTION 'line_snapshot patch target missing'; END IF;
  EXECUTE replace(def, 'AND NOT (TG_TABLE_NAME = ''purchase_items''', 'AND NOT (TG_TABLE_NAME IN (''purchase_items'', ''dispatch_items'')');
END$$;

CREATE FUNCTION app.recompute_dispatch_totals(p_id uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, extensions, pg_temp AS $$
DECLARE v_taxable numeric; v_tax numeric; v_disc numeric; v_lines int;
BEGIN
  SELECT count(*), coalesce(sum(line_taxable), 0), coalesce(sum(line_tax), 0), coalesce(sum(line_discount), 0)
    INTO v_lines, v_taxable, v_tax, v_disc FROM dispatch_items WHERE dispatch_id = p_id;
  IF v_lines = 0 THEN RAISE EXCEPTION 'A bill needs at least one item' USING ERRCODE = 'WH005'; END IF;
  UPDATE dispatches SET
    taxable_total = v_taxable, discount_total = v_disc,
    igst_total = CASE WHEN is_interstate THEN v_tax ELSE 0 END,
    cgst_total = CASE WHEN is_interstate THEN 0 ELSE round(v_tax / 2, 2) END,
    sgst_total = CASE WHEN is_interstate THEN 0 ELSE v_tax - round(v_tax / 2, 2) END,
    grand_total = v_taxable + v_tax + loading_charges + transport_charges + other_charges
  WHERE id = p_id;
END$$;

-- p = same shape as create_dispatch (customerId / newCustomer, invoiceDate, transport…, charges, overrideId, lines) + reason
CREATE FUNCTION public.owner_edit_dispatch(p_id uuid, p jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, extensions, pg_temp AS $$
DECLARE d dispatches; r record; v_short jsonb; v_cust uuid; v_date date; v_rev int; c customers; v_wh_state char(2); v_pos char(2);
BEGIN
  PERFORM app.require_full_owner();
  SELECT * INTO d FROM dispatches WHERE id = p_id FOR UPDATE;
  IF NOT FOUND OR d.status <> 'POSTED' THEN RAISE EXCEPTION 'Bill not found or cancelled' USING ERRCODE = 'WH005'; END IF;
  IF EXISTS (SELECT 1 FROM sales_returns WHERE dispatch_id = p_id AND status = 'POSTED') THEN
    RAISE EXCEPTION 'Goods from this bill were returned — cancel the return before editing the bill' USING ERRCODE = 'WH005';
  END IF;
  IF jsonb_array_length(coalesce(p->'lines', '[]')) = 0 THEN RAISE EXCEPTION 'A bill needs at least one item' USING ERRCODE = 'WH005'; END IF;
  v_date := coalesce(nullif(p->>'invoiceDate', '')::date, d.invoice_date);
  IF app.fy_label(v_date) <> d.fy THEN
    RAISE EXCEPTION 'The bill date must stay in financial year %', d.fy USING ERRCODE = 'WH005';
  END IF;

  SELECT coalesce(max(revision), 0) + 1 INTO v_rev FROM dispatch_revisions WHERE dispatch_id = p_id;
  INSERT INTO dispatch_revisions(dispatch_id, revision, snapshot, reason, edited_by)
  VALUES (p_id, v_rev, app.dispatch_json(p_id), nullif(btrim(p->>'reason'), ''), app.current_user_id());

  FOR r IN SELECT * FROM dispatch_items WHERE dispatch_id = p_id ORDER BY line_no LOOP
    PERFORM app.apply_movement(d.warehouse_id, r.product_id, 'REVERSAL', r.qty_base, 'dispatch_items', r.id, p_id, NULL, true);
  END LOOP;
  DELETE FROM dispatch_items WHERE dispatch_id = p_id;

  IF p->>'overrideId' IS NULL THEN
    v_short := app.dispatch_shortfalls(d.warehouse_id, p->'lines');
    IF jsonb_array_length(v_short) > 0 THEN
      RAISE EXCEPTION 'Quantity exceeds physical stock in this warehouse' USING ERRCODE = 'WH001',
        DETAIL = v_short::text, HINT = 'Provide an Admin Override PIN to dispatch beyond physical stock.';
    END IF;
  END IF;

  v_cust := CASE WHEN nullif(p->>'customerId', '') IS NULL AND coalesce(jsonb_typeof(p->'newCustomer'), 'null') = 'null' THEN d.customer_id
                 ELSE app.resolve_customer(nullif(p->>'customerId', '')::uuid, p->'newCustomer') END;
  SELECT * INTO c FROM customers WHERE id = v_cust;
  SELECT state_code INTO v_wh_state FROM warehouses WHERE id = d.warehouse_id;
  v_pos := coalesce(app.gstin_state(c.gstin), c.state_code, v_wh_state);
  UPDATE dispatches SET
    customer_id = v_cust, customer_name = c.name, customer_gstin = c.gstin, place_of_supply = v_pos, is_interstate = v_pos <> v_wh_state,
    invoice_date = v_date,
    transport_mode = coalesce(nullif(p->>'transportMode', '')::transport_mode, transport_mode),
    transporter_name = CASE WHEN p ? 'transporterName' THEN nullif(btrim(p->>'transporterName'), '') ELSE transporter_name END,
    vehicle_reg_no = CASE WHEN p ? 'vehicleRegNo' THEN nullif(upper(regexp_replace(coalesce(p->>'vehicleRegNo', ''), '[^A-Za-z0-9]', '', 'g')), '') ELSE vehicle_reg_no END,
    lr_number = CASE WHEN p ? 'lrNumber' THEN nullif(btrim(p->>'lrNumber'), '') ELSE lr_number END,
    eway_bill_no = CASE WHEN p ? 'ewayBillNo' THEN nullif(btrim(p->>'ewayBillNo'), '') ELSE eway_bill_no END,
    loading_charges = coalesce(nullif(p->>'loadingCharges', '')::numeric, 0),
    transport_charges = coalesce(nullif(p->>'transportCharges', '')::numeric, 0),
    other_charges = coalesce(nullif(p->>'otherCharges', '')::numeric, 0),
    override_id = coalesce((p->>'overrideId')::uuid, override_id)
  WHERE id = p_id;

  PERFORM set_config('app.editing_doc', p_id::text, true);
  INSERT INTO dispatch_items(dispatch_id, line_no, product_id, uom_code, conversion_factor, qty,
                             unit_base_price, discount_pct, discount_amount, gst_rate, hsn_code, mrp)
  SELECT p_id, e.ord, (e.j->>'productId')::uuid, e.j->>'uomCode', 1, (e.j->>'qty')::numeric,
         (e.j->>'unitBasePrice')::numeric, coalesce((e.j->>'discountPct')::numeric, 0),
         coalesce(nullif(e.j->>'discountAmount', '')::numeric, 0), nullif(e.j->>'gstRate', '')::numeric,
         nullif(trim(e.j->>'hsnCode'), ''), nullif(e.j->>'mrp', '')::numeric
    FROM jsonb_array_elements(p->'lines') WITH ORDINALITY AS e(j, ord);
  PERFORM set_config('app.editing_doc', '', true);

  PERFORM app.recompute_dispatch_totals(p_id);
  INSERT INTO audit_log(table_name, row_id, action, actor_id, old_data, new_data)
  VALUES ('public.dispatches', p_id::text, 'EDIT', app.current_user_id(), to_jsonb(d), (SELECT to_jsonb(x) FROM dispatches x WHERE x.id = p_id));
  RETURN jsonb_build_object('dispatch', app.dispatch_json(p_id), 'revision', v_rev);
END$$;

CREATE FUNCTION public.owner_dispatch_revisions(p_id uuid) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, extensions, pg_temp AS $$
BEGIN
  PERFORM app.require_owner();
  RETURN (SELECT coalesce(jsonb_agg(jsonb_build_object('revision', r.revision, 'edited_at', r.edited_at, 'edited_by', u.full_name,
            'reason', r.reason, 'snapshot', r.snapshot) ORDER BY r.revision DESC), '[]')
            FROM dispatch_revisions r JOIN users u ON u.id = r.edited_by WHERE r.dispatch_id = p_id);
END$$;

-- Everything needed to print / share one invoice (owner, or staff of that warehouse / who made it).
CREATE FUNCTION public.invoice_data(p_dispatch uuid) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, extensions, pg_temp AS $$
DECLARE d dispatches; v_uid uuid := app.require_user();
BEGIN
  SELECT * INTO d FROM dispatches WHERE id = p_dispatch;
  IF NOT FOUND THEN RAISE EXCEPTION 'Bill not found' USING ERRCODE = 'WH005'; END IF;
  IF NOT app.is_owner() AND d.created_by <> v_uid AND d.warehouse_id IS DISTINCT FROM app.current_warehouse_id() THEN
    RAISE EXCEPTION 'Not your bill' USING ERRCODE = 'WH002';
  END IF;
  RETURN jsonb_build_object(
    'bill', fin.sale_detail(p_dispatch),
    'business', coalesce(app.setting('business'), '{}') - 'opening_cash' - 'opening_bank' - 'opening_date',
    'seller', (SELECT jsonb_build_object('code', code, 'name', name, 'address', address, 'state_code', state_code, 'gstin', gstin)
                 FROM warehouses WHERE id = d.warehouse_id),
    'buyer', (SELECT jsonb_build_object('name', c.name, 'gstin', c.gstin, 'phone', c.phone, 'address', c.address, 'state_code', c.state_code)
                FROM customers c WHERE c.id = d.customer_id),
    'balance', (SELECT balance FROM fin.customer_balances() WHERE customer_id = d.customer_id),
    'transport', jsonb_build_object('mode', d.transport_mode, 'transporter', d.transporter_name, 'vehicle', d.vehicle_reg_no,
                                    'lr', d.lr_number, 'eway', d.eway_bill_no, 'place_of_supply', d.place_of_supply),
    'returns', (SELECT coalesce(jsonb_agg(jsonb_build_object('return_no', return_no, 'return_date', return_date, 'total', total)), '[]')
                  FROM sales_returns WHERE dispatch_id = p_dispatch AND status = 'POSTED'));
END$$;

-- ===========================================================================
-- Suppliers: money owed (purchases − owner discounts − payments − debit notes − credits used)
-- ===========================================================================
CREATE FUNCTION fin.vendor_bills() RETURNS TABLE(purchase_id uuid, vendor_id uuid, bill_date date, bill_no text, payable numeric,
                                                 outstanding numeric, days_old int, credit_days int)
LANGUAGE sql STABLE SET search_path = public, fin, extensions, pg_temp AS $$
  WITH b AS (
    SELECT p.id, p.vendor_id, coalesce(p.vendor_invoice_date, p.received_on, (p.created_at AT TIME ZONE 'Asia/Kolkata')::date) AS dt,
           p.vendor_invoice_no, greatest(0, p.grand_total - fin.purchase_owner_discount(p.id)) AS payable, p.created_at
      FROM purchases p WHERE p.status = 'POSTED'),
  c AS (SELECT b.*, sum(b.payable) OVER (PARTITION BY b.vendor_id ORDER BY b.dt, b.created_at, b.id ROWS UNBOUNDED PRECEDING) AS cum FROM b),
  paid AS (SELECT x.vendor_id, sum(x.amt) AS amt FROM (
             SELECT vp.vendor_id, vp.amount AS amt FROM fin.vendor_payments vp
             UNION ALL SELECT cu.vendor_id, cu.amount FROM fin.credit_note_uses cu) x GROUP BY 1)
  SELECT c.id, c.vendor_id, c.dt, c.vendor_invoice_no, c.payable,
         greatest(0, least(c.payable, c.cum - coalesce(paid.amt, 0))), (app.today_ist() - c.dt)::int, v.credit_days
    FROM c JOIN vendors v ON v.id = c.vendor_id LEFT JOIN paid ON paid.vendor_id = c.vendor_id
$$;

CREATE FUNCTION public.owner_suppliers() RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, fin, extensions, pg_temp AS $$
BEGIN
  PERFORM app.require_owner();
  RETURN (SELECT coalesce(jsonb_agg(x ORDER BY (x->>'balance')::numeric DESC, x->>'name'), '[]') FROM (
    SELECT jsonb_build_object('id', v.id, 'name', v.name, 'gstin', v.gstin, 'phone', v.phone, 'address', v.address,
      'state_code', v.state_code, 'is_active', v.is_active, 'default_discount_pct', v.default_discount_pct,
      'credit_days', v.credit_days, 'notes', v.notes,
      'purchases', coalesce(b.n, 0), 'purchased', coalesce(b.payable, 0), 'outstanding', coalesce(b.outstanding, 0),
      'overdue', coalesce(b.overdue, 0), 'oldest_overdue_days', b.oldest,
      'paid', coalesce(pm.paid, 0), 'debit_notes', coalesce(pm.dn, 0), 'credits_used', coalesce(cu.amt, 0),
      'balance', coalesce(b.payable, 0) - coalesce(pm.paid, 0) - coalesce(pm.dn, 0) - coalesce(cu.amt, 0),
      'last_purchase', b.last_dt, 'last_payment', pm.last_pay) AS x
      FROM vendors v
      LEFT JOIN (SELECT vendor_id, count(*) n, sum(payable) payable, sum(outstanding) outstanding, max(bill_date) last_dt,
                        sum(outstanding) FILTER (WHERE days_old > credit_days) overdue,
                        max(days_old) FILTER (WHERE outstanding > 0 AND days_old > credit_days) oldest
                   FROM fin.vendor_bills() GROUP BY 1) b ON b.vendor_id = v.id
      LEFT JOIN (SELECT vendor_id, sum(amount) FILTER (WHERE mode <> 'DEBIT_NOTE') paid, sum(amount) FILTER (WHERE mode = 'DEBIT_NOTE') dn,
                        max(paid_on) FILTER (WHERE mode <> 'DEBIT_NOTE') last_pay
                   FROM fin.vendor_payments GROUP BY 1) pm ON pm.vendor_id = v.id
      LEFT JOIN (SELECT vendor_id, sum(amount) amt FROM fin.credit_note_uses GROUP BY 1) cu ON cu.vendor_id = v.id) s);
END$$;

CREATE FUNCTION public.owner_supplier_statement(p_vendor uuid) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, fin, extensions, pg_temp AS $$
BEGIN
  PERFORM app.require_owner();
  RETURN jsonb_build_object(
    'supplier', (SELECT x FROM jsonb_array_elements(public.owner_suppliers()) x WHERE x->>'id' = p_vendor::text),
    'entries', (SELECT coalesce(jsonb_agg(e ORDER BY e->>'date', e->>'at'), '[]') FROM (
       SELECT jsonb_build_object('kind', 'BILL', 'id', b.purchase_id, 'date', b.bill_date, 'at', p.created_at,
                                 'ref', coalesce(b.bill_no, 'bill'), 'debit', 0, 'credit', b.payable, 'outstanding', b.outstanding,
                                 'days_old', b.days_old, 'warehouse', w.code) AS e
         FROM fin.vendor_bills() b JOIN purchases p ON p.id = b.purchase_id JOIN warehouses w ON w.id = p.warehouse_id
        WHERE b.vendor_id = p_vendor
       UNION ALL
       SELECT jsonb_build_object('kind', CASE WHEN vp.mode = 'DEBIT_NOTE' THEN 'DEBIT_NOTE' ELSE 'PAYMENT' END, 'id', vp.id,
                                 'date', vp.paid_on, 'at', vp.created_at, 'ref', vp.mode || coalesce(' · ' || vp.reference, ''),
                                 'debit', vp.amount, 'credit', 0, 'notes', vp.notes, 'by', u.full_name)
         FROM fin.vendor_payments vp JOIN users u ON u.id = vp.entered_by WHERE vp.vendor_id = p_vendor
       UNION ALL
       SELECT jsonb_build_object('kind', 'CREDIT_USED', 'id', cu.id, 'date', cu.used_on, 'at', cu.created_at, 'ref', 'Credit note used',
                                 'debit', cu.amount, 'credit', 0, 'notes', cu.notes)
         FROM fin.credit_note_uses cu WHERE cu.vendor_id = p_vendor) s));
END$$;

-- p = { vendorId, amount, paidOn?, mode, reference?, notes?, purchaseId? }
CREATE FUNCTION public.owner_record_vendor_payment(p jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, fin, extensions, pg_temp AS $$
DECLARE v_id uuid;
BEGIN
  PERFORM app.require_full_owner();
  IF coalesce(nullif(p->>'amount', '')::numeric, 0) <= 0 THEN RAISE EXCEPTION 'Amount must be more than 0' USING ERRCODE = 'WH005'; END IF;
  IF coalesce(p->>'mode', '') NOT IN ('CASH','UPI','NEFT','RTGS','IMPS','CHEQUE','CARD','OTHER') THEN
    RAISE EXCEPTION 'Choose how it was paid' USING ERRCODE = 'WH005';
  END IF;
  IF nullif(p->>'paidOn', '')::date > app.today_ist() THEN RAISE EXCEPTION 'Payment date cannot be in the future' USING ERRCODE = 'WH005'; END IF;
  INSERT INTO fin.vendor_payments(vendor_id, amount, paid_on, mode, reference, notes, purchase_id, entered_by)
  VALUES ((p->>'vendorId')::uuid, round((p->>'amount')::numeric, 2), coalesce(nullif(p->>'paidOn', '')::date, app.today_ist()),
          p->>'mode', nullif(btrim(p->>'reference'), ''), nullif(btrim(p->>'notes'), ''), nullif(p->>'purchaseId', '')::uuid,
          app.current_user_id())
  RETURNING id INTO v_id;
  RETURN jsonb_build_object('id', v_id);
END$$;

CREATE FUNCTION public.owner_delete_vendor_payment(p_id uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, fin, extensions, pg_temp AS $$
BEGIN
  PERFORM app.require_full_owner();
  DELETE FROM fin.vendor_payments WHERE id = p_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Payment not found' USING ERRCODE = 'WH005'; END IF;
END$$;

CREATE FUNCTION app.clean_party(p jsonb) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, extensions, pg_temp AS $$
DECLARE v_gstin text := nullif(upper(btrim(coalesce(p->>'gstin', ''))), ''); v_phone text;
BEGIN
  IF length(btrim(coalesce(p->>'name', ''))) < 2 THEN RAISE EXCEPTION 'Name is required' USING ERRCODE = 'WH005'; END IF;
  IF v_gstin IS NOT NULL AND NOT app.gstin_valid(v_gstin) THEN RAISE EXCEPTION 'This GST number is not valid' USING ERRCODE = 'WH005'; END IF;
  v_phone := nullif(right(regexp_replace(coalesce(p->>'phone', ''), '\D', '', 'g'), 10), '');
  IF v_phone IS NOT NULL AND v_phone !~ '^[6-9][0-9]{9}$' THEN RAISE EXCEPTION 'Phone should be a 10-digit mobile number' USING ERRCODE = 'WH005'; END IF;
  RETURN jsonb_build_object('name', regexp_replace(btrim(p->>'name'), '\s+', ' ', 'g'), 'gstin', v_gstin, 'phone', v_phone,
    'address', nullif(btrim(coalesce(p->>'address', '')), ''),
    'state_code', coalesce(left(v_gstin, 2), nullif(btrim(coalesce(p->>'stateCode', '')), '')),
    'notes', nullif(btrim(coalesce(p->>'notes', '')), ''));
END$$;

-- p = { id?, name, gstin?, phone?, address?, stateCode?, defaultDiscountPct?, creditDays?, notes?, isActive? }
CREATE FUNCTION public.owner_save_vendor(p jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, extensions, pg_temp AS $$
DECLARE c jsonb; v_id uuid := nullif(p->>'id', '')::uuid;
BEGIN
  PERFORM app.require_owner();
  c := app.clean_party(p);
  IF c->>'gstin' IS NOT NULL AND EXISTS (SELECT 1 FROM vendors WHERE gstin = c->>'gstin' AND id IS DISTINCT FROM v_id) THEN
    RAISE EXCEPTION 'Another supplier already has GSTIN % — merge them instead', c->>'gstin' USING ERRCODE = 'WH005';
  END IF;
  IF v_id IS NULL THEN
    INSERT INTO vendors(name, gstin, phone, address, state_code, default_discount_pct, credit_days, notes)
    VALUES (c->>'name', c->>'gstin', c->>'phone', c->>'address', c->>'state_code',
            coalesce(nullif(p->>'defaultDiscountPct', '')::numeric, 0), coalesce(nullif(p->>'creditDays', '')::int, 30), c->>'notes')
    RETURNING id INTO v_id;
  ELSE
    UPDATE vendors SET name = c->>'name', gstin = c->>'gstin', phone = c->>'phone', address = c->>'address', state_code = c->>'state_code',
           default_discount_pct = coalesce(nullif(p->>'defaultDiscountPct', '')::numeric, default_discount_pct),
           credit_days = coalesce(nullif(p->>'creditDays', '')::int, credit_days), notes = c->>'notes',
           is_active = coalesce((p->>'isActive')::boolean, is_active)
     WHERE id = v_id;
    IF NOT FOUND THEN RAISE EXCEPTION 'Supplier not found' USING ERRCODE = 'WH005'; END IF;
  END IF;
  RETURN jsonb_build_object('id', v_id);
END$$;

CREATE FUNCTION public.owner_merge_vendors(p_keep uuid, p_drop uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, fin, extensions, pg_temp AS $$
DECLARE n int;
BEGIN
  PERFORM app.require_full_owner();
  IF p_keep = p_drop THEN RAISE EXCEPTION 'Pick two different suppliers' USING ERRCODE = 'WH005'; END IF;
  PERFORM 1 FROM vendors WHERE id IN (p_keep, p_drop) FOR UPDATE;
  UPDATE purchases SET vendor_id = p_keep WHERE vendor_id = p_drop; GET DIAGNOSTICS n = ROW_COUNT;
  UPDATE fin.vendor_payments SET vendor_id = p_keep WHERE vendor_id = p_drop;
  UPDATE fin.credit_note_uses SET vendor_id = p_keep WHERE vendor_id = p_drop;
  UPDATE fin.purchase_orders SET vendor_id = p_keep WHERE vendor_id = p_drop;
  UPDATE purchase_returns SET vendor_id = p_keep WHERE vendor_id = p_drop;
  UPDATE vendors k SET phone = coalesce(k.phone, x.phone), address = coalesce(k.address, x.address)
    FROM (SELECT phone, address FROM vendors WHERE id = p_drop) x WHERE k.id = p_keep;
  DELETE FROM vendors WHERE id = p_drop;
  INSERT INTO audit_log(table_name, row_id, action, actor_id, old_data, new_data)
  VALUES ('public.vendors', p_drop::text, 'MERGE', app.current_user_id(), NULL, jsonb_build_object('into', p_keep, 'purchases_moved', n));
  RETURN jsonb_build_object('purchases_moved', n);
END$$;

-- ===========================================================================
-- Customers page
-- ===========================================================================
CREATE FUNCTION public.owner_customers() RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, fin, extensions, pg_temp AS $$
BEGIN
  PERFORM app.require_owner();
  RETURN (SELECT coalesce(jsonb_agg(x ORDER BY (x->>'balance')::numeric DESC, x->>'name'), '[]') FROM (
    SELECT jsonb_build_object('id', c.id, 'name', c.name, 'gstin', c.gstin, 'phone', c.phone, 'address', c.address,
      'state_code', c.state_code, 'is_dealer', c.is_dealer, 'is_active', c.is_active, 'notes', c.notes,
      'credit_limit', cc.credit_limit, 'credit_days', coalesce(cc.credit_days, 30),
      'billed', coalesce(b.billed, 0), 'paid', coalesce(b.paid, 0), 'balance', coalesce(b.balance, 0), 'overdue', coalesce(b.overdue, 0),
      'oldest_overdue_days', b.oldest_overdue_days, 'last_bill_date', b.last_bill_date, 'last_payment_date', b.last_payment_date,
      'bills', (SELECT count(*) FROM dispatches d WHERE d.customer_id = c.id AND d.status = 'POSTED'),
      'over_limit', cc.credit_limit IS NOT NULL AND coalesce(b.balance, 0) > cc.credit_limit) AS x
      FROM customers c LEFT JOIN fin.customer_balances() b ON b.customer_id = c.id
      LEFT JOIN fin.customer_credit cc ON cc.customer_id = c.id) s);
END$$;

-- p = { id?, name, gstin?, phone?, address?, stateCode?, isDealer?, isActive?, creditLimit? (blank = no limit), creditDays?, notes? }
CREATE FUNCTION public.owner_save_customer(p jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, fin, extensions, pg_temp AS $$
DECLARE c jsonb; v_id uuid := nullif(p->>'id', '')::uuid; v_limit numeric := nullif(p->>'creditLimit', '')::numeric;
BEGIN
  PERFORM app.require_owner();
  c := app.clean_party(p);
  IF c->>'gstin' IS NOT NULL AND EXISTS (SELECT 1 FROM customers WHERE gstin = c->>'gstin' AND id IS DISTINCT FROM v_id) THEN
    RAISE EXCEPTION 'Another customer already has GSTIN % — merge them instead', c->>'gstin' USING ERRCODE = 'WH005';
  END IF;
  IF v_limit < 0 THEN RAISE EXCEPTION 'Credit limit cannot be negative' USING ERRCODE = 'WH005'; END IF;
  IF v_id IS NULL THEN
    INSERT INTO customers(name, gstin, phone, address, state_code, is_dealer, notes)
    VALUES (c->>'name', c->>'gstin', c->>'phone', c->>'address', c->>'state_code', coalesce((p->>'isDealer')::boolean, false), c->>'notes')
    RETURNING id INTO v_id;
  ELSE
    UPDATE customers SET name = c->>'name', gstin = c->>'gstin', phone = c->>'phone', address = c->>'address', state_code = c->>'state_code',
           is_dealer = coalesce((p->>'isDealer')::boolean, is_dealer), is_active = coalesce((p->>'isActive')::boolean, is_active), notes = c->>'notes'
     WHERE id = v_id;
    IF NOT FOUND THEN RAISE EXCEPTION 'Customer not found' USING ERRCODE = 'WH005'; END IF;
  END IF;
  IF p ? 'creditLimit' OR p ? 'creditDays' THEN
    IF v_limit IS NULL THEN
      DELETE FROM fin.customer_credit WHERE customer_id = v_id;
      IF coalesce(nullif(p->>'creditDays', '')::int, 30) <> 30 THEN
        RAISE EXCEPTION 'Set a credit limit to use a due period other than 30 days' USING ERRCODE = 'WH005';
      END IF;
    ELSE
      INSERT INTO fin.customer_credit(customer_id, credit_limit, credit_days)
      VALUES (v_id, v_limit, coalesce(nullif(p->>'creditDays', '')::int, 30))
      ON CONFLICT (customer_id) DO UPDATE SET credit_limit = EXCLUDED.credit_limit, credit_days = EXCLUDED.credit_days;
    END IF;
  END IF;
  RETURN jsonb_build_object('id', v_id);
END$$;

CREATE FUNCTION public.owner_merge_customers(p_keep uuid, p_drop uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, fin, extensions, pg_temp AS $$
DECLARE n int;
BEGIN
  PERFORM app.require_full_owner();
  IF p_keep = p_drop THEN RAISE EXCEPTION 'Pick two different customers' USING ERRCODE = 'WH005'; END IF;
  PERFORM 1 FROM customers WHERE id IN (p_keep, p_drop) FOR UPDATE;
  UPDATE dispatches SET customer_id = p_keep WHERE customer_id = p_drop; GET DIAGNOSTICS n = ROW_COUNT;
  UPDATE fin.customer_payments SET customer_id = p_keep WHERE customer_id = p_drop;
  UPDATE sales_returns SET customer_id = p_keep WHERE customer_id = p_drop;
  DELETE FROM fin.customer_credit WHERE customer_id = p_drop;
  UPDATE customers k SET phone = coalesce(k.phone, x.phone), address = coalesce(k.address, x.address)
    FROM (SELECT phone, address FROM customers WHERE id = p_drop) x WHERE k.id = p_keep;
  DELETE FROM customers WHERE id = p_drop;
  INSERT INTO audit_log(table_name, row_id, action, actor_id, old_data, new_data)
  VALUES ('public.customers', p_drop::text, 'MERGE', app.current_user_id(), NULL, jsonb_build_object('into', p_keep, 'bills_moved', n));
  RETURN jsonb_build_object('bills_moved', n);
END$$;

-- ===========================================================================
-- Expenses, cash book, profit & loss
-- ===========================================================================
-- p = { spentOn?, warehouseId?, category, amount, mode, paidTo?, notes? }
CREATE FUNCTION public.owner_add_expense(p jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, fin, extensions, pg_temp AS $$
DECLARE v_id uuid;
BEGIN
  PERFORM app.require_owner();
  IF coalesce(nullif(p->>'amount', '')::numeric, 0) <= 0 THEN RAISE EXCEPTION 'Amount must be more than 0' USING ERRCODE = 'WH005'; END IF;
  IF nullif(p->>'spentOn', '')::date > app.today_ist() THEN RAISE EXCEPTION 'Date cannot be in the future' USING ERRCODE = 'WH005'; END IF;
  INSERT INTO fin.expenses(spent_on, warehouse_id, category, amount, mode, paid_to, notes, created_by)
  VALUES (coalesce(nullif(p->>'spentOn', '')::date, app.today_ist()), nullif(p->>'warehouseId', '')::uuid, btrim(p->>'category'),
          round((p->>'amount')::numeric, 2), coalesce(nullif(p->>'mode', ''), 'CASH'), nullif(btrim(p->>'paidTo'), ''),
          nullif(btrim(p->>'notes'), ''), app.current_user_id())
  RETURNING id INTO v_id;
  RETURN jsonb_build_object('id', v_id);
END$$;

CREATE FUNCTION public.owner_delete_expense(p_id uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, fin, extensions, pg_temp AS $$
BEGIN
  PERFORM app.require_owner();
  DELETE FROM fin.expenses WHERE id = p_id AND (app.current_app_role() = 'OWNER' OR created_by = app.current_user_id());
  IF NOT FOUND THEN RAISE EXCEPTION 'Expense not found (managers can delete only their own entries)' USING ERRCODE = 'WH005'; END IF;
END$$;

CREATE FUNCTION public.owner_expenses(p_from date, p_to date) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, fin, extensions, pg_temp AS $$
BEGIN
  PERFORM app.require_owner();
  RETURN jsonb_build_object(
    'items', (SELECT coalesce(jsonb_agg(jsonb_build_object('id', e.id, 'spent_on', e.spent_on, 'category', e.category, 'amount', e.amount,
                'mode', e.mode, 'paid_to', e.paid_to, 'notes', e.notes, 'warehouse', w.code, 'by', u.full_name, 'created_at', e.created_at)
                ORDER BY e.spent_on DESC, e.created_at DESC), '[]')
                FROM fin.expenses e JOIN users u ON u.id = e.created_by LEFT JOIN warehouses w ON w.id = e.warehouse_id
               WHERE e.spent_on BETWEEN p_from AND p_to),
    'by_category', (SELECT coalesce(jsonb_agg(jsonb_build_object('category', category, 'amount', amt) ORDER BY amt DESC), '[]')
                      FROM (SELECT category, sum(amount) amt FROM fin.expenses WHERE spent_on BETWEEN p_from AND p_to GROUP BY 1) s),
    'categories', (SELECT coalesce(jsonb_agg(DISTINCT category), '[]') FROM fin.expenses));
END$$;

-- Money in / out by day. CASH = cash in hand; everything else = bank / UPI.
CREATE FUNCTION public.owner_cash_book(p_from date, p_to date) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, fin, extensions, pg_temp AS $$
DECLARE s jsonb := coalesce(app.setting('business'), '{}'); v_open_date date; v_cash numeric; v_bank numeric;
BEGIN
  PERFORM app.require_full_owner();
  v_open_date := coalesce(nullif(s->>'opening_date', '')::date, '1900-01-01'::date);
  CREATE TEMP TABLE IF NOT EXISTS _flows(d date, at timestamptz, kind text, party text, ref text, mode text, amt numeric) ON COMMIT DROP;
  TRUNCATE _flows;
  INSERT INTO _flows
    SELECT cp.paid_on, cp.created_at, 'RECEIVED', c.name, cp.reference, cp.mode, cp.amount
      FROM fin.customer_payments cp JOIN customers c ON c.id = cp.customer_id WHERE cp.mode <> 'CREDIT_NOTE' AND cp.paid_on >= v_open_date
    UNION ALL
    SELECT vp.paid_on, vp.created_at, 'PAID_SUPPLIER', v.name, vp.reference, vp.mode, -vp.amount
      FROM fin.vendor_payments vp JOIN vendors v ON v.id = vp.vendor_id WHERE vp.mode <> 'DEBIT_NOTE' AND vp.paid_on >= v_open_date
    UNION ALL
    SELECT e.spent_on, e.created_at, 'EXPENSE', coalesce(e.paid_to, e.category), e.category, e.mode, -e.amount
      FROM fin.expenses e WHERE e.spent_on >= v_open_date;
  v_cash := coalesce((s->>'opening_cash')::numeric, 0) + coalesce((SELECT sum(amt) FROM _flows WHERE d < p_from AND mode = 'CASH'), 0);
  v_bank := coalesce((s->>'opening_bank')::numeric, 0) + coalesce((SELECT sum(amt) FROM _flows WHERE d < p_from AND mode <> 'CASH'), 0);
  RETURN jsonb_build_object(
    'opening', jsonb_build_object('cash', v_cash, 'bank', v_bank),
    'in', jsonb_build_object('cash', coalesce((SELECT sum(amt) FROM _flows WHERE d BETWEEN p_from AND p_to AND amt > 0 AND mode = 'CASH'), 0),
                             'bank', coalesce((SELECT sum(amt) FROM _flows WHERE d BETWEEN p_from AND p_to AND amt > 0 AND mode <> 'CASH'), 0)),
    'out', jsonb_build_object('cash', coalesce((SELECT -sum(amt) FROM _flows WHERE d BETWEEN p_from AND p_to AND amt < 0 AND mode = 'CASH'), 0),
                              'bank', coalesce((SELECT -sum(amt) FROM _flows WHERE d BETWEEN p_from AND p_to AND amt < 0 AND mode <> 'CASH'), 0)),
    'closing', jsonb_build_object('cash', v_cash + coalesce((SELECT sum(amt) FROM _flows WHERE d BETWEEN p_from AND p_to AND mode = 'CASH'), 0),
                                  'bank', v_bank + coalesce((SELECT sum(amt) FROM _flows WHERE d BETWEEN p_from AND p_to AND mode <> 'CASH'), 0)),
    'entries', (SELECT coalesce(jsonb_agg(jsonb_build_object('date', d, 'kind', kind, 'party', party, 'ref', ref, 'mode', mode, 'amount', amt)
                  ORDER BY d, at), '[]') FROM _flows WHERE d BETWEEN p_from AND p_to),
    'opening_set', s ? 'opening_date' AND s->>'opening_date' IS NOT NULL);
END$$;

CREATE FUNCTION public.owner_pnl(p_from date, p_to date) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, fin, extensions, pg_temp AS $$
DECLARE v_rev numeric; v_cogs numeric; v_nocost int; v_charges numeric; v_ret numeric; v_ret_cogs numeric; v_exp numeric; v_disc numeric;
BEGIN
  PERFORM app.require_full_owner();
  SELECT coalesce(sum(line_taxable), 0), coalesce(sum(line_cogs), 0), count(DISTINCT product_id) FILTER (WHERE avg_effective_cost_base IS NULL)
    INTO v_rev, v_cogs, v_nocost FROM fin.v_sales_lines WHERE invoice_date BETWEEN p_from AND p_to;
  SELECT coalesce(sum(loading_charges + transport_charges + other_charges), 0) INTO v_charges
    FROM dispatches WHERE status = 'POSTED' AND invoice_date BETWEEN p_from AND p_to;
  SELECT coalesce(sum(i.taxable), 0), coalesce(sum(round(i.qty_base * coalesce(pc.avg_effective_cost_base, 0), 2)), 0)
    INTO v_ret, v_ret_cogs
    FROM sales_returns r JOIN sales_return_items i ON i.return_id = r.id LEFT JOIN fin.v_product_cost pc ON pc.product_id = i.product_id
   WHERE r.status = 'POSTED' AND r.return_date BETWEEN p_from AND p_to;
  SELECT coalesce(sum(amount), 0) INTO v_exp FROM fin.expenses WHERE spent_on BETWEEN p_from AND p_to;
  SELECT coalesce(sum(cu.amount), 0) INTO v_disc FROM fin.credit_note_uses cu WHERE cu.used_on BETWEEN p_from AND p_to;
  RETURN jsonb_build_object(
    'sales', v_rev, 'returns', v_ret, 'net_sales', v_rev - v_ret,
    'cogs', v_cogs - v_ret_cogs, 'gross_profit', v_rev - v_ret - (v_cogs - v_ret_cogs),
    'gross_margin_pct', CASE WHEN v_rev - v_ret > 0 THEN round(100 * (v_rev - v_ret - (v_cogs - v_ret_cogs)) / (v_rev - v_ret), 1) END,
    'charges_billed', v_charges, 'supplier_credits_used', v_disc,
    'expenses', v_exp,
    'expenses_by_category', (SELECT coalesce(jsonb_agg(jsonb_build_object('category', category, 'amount', amt) ORDER BY amt DESC), '[]')
                               FROM (SELECT category, sum(amount) amt FROM fin.expenses WHERE spent_on BETWEEN p_from AND p_to GROUP BY 1) s),
    'net_profit', v_rev - v_ret - (v_cogs - v_ret_cogs) + v_charges + v_disc - v_exp,
    'items_without_cost', v_nocost);
END$$;

-- ===========================================================================
-- GST reports for a month (all warehouses, or one GSTIN's warehouses)
-- ===========================================================================
CREATE FUNCTION public.owner_gst_report(p_month date, p_warehouse uuid DEFAULT NULL) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, fin, extensions, pg_temp AS $$
DECLARE v_from date := date_trunc('month', p_month)::date; v_to date := (date_trunc('month', p_month) + interval '1 month - 1 day')::date;
BEGIN
  PERFORM app.require_owner();
  CREATE TEMP TABLE IF NOT EXISTS _gl(dispatch_id uuid, invoice_no text, invoice_date date, warehouse_id uuid, customer_name text, gstin text,
     pos char(2), inter boolean, invoice_value numeric, hsn text, item text, qty numeric, rate numeric, taxable numeric, tax numeric, sign int,
     note_no text, note_date date) ON COMMIT DROP;
  TRUNCATE _gl;
  INSERT INTO _gl
    SELECT d.id, d.invoice_no, d.invoice_date, d.warehouse_id, d.customer_name, d.customer_gstin, d.place_of_supply, d.is_interstate,
           d.grand_total, coalesce(di.hsn_code, '0000'), p.name, di.qty_base, di.gst_rate, di.line_taxable, di.line_tax, 1, NULL, NULL
      FROM dispatches d JOIN dispatch_items di ON di.dispatch_id = d.id JOIN products p ON p.id = di.product_id
     WHERE d.status = 'POSTED' AND d.invoice_date BETWEEN v_from AND v_to AND (p_warehouse IS NULL OR d.warehouse_id = p_warehouse)
    UNION ALL
    SELECT d.id, d.invoice_no, d.invoice_date, r.warehouse_id, c.name, c.gstin, d.place_of_supply, d.is_interstate,
           r.total, coalesce(di.hsn_code, p.hsn_code, '0000'), p.name, i.qty_base, i.gst_rate, i.taxable, i.tax, -1, r.return_no, r.return_date
      FROM sales_returns r JOIN sales_return_items i ON i.return_id = r.id LEFT JOIN dispatch_items di ON di.id = i.dispatch_item_id
      JOIN dispatches d ON d.id = r.dispatch_id JOIN customers c ON c.id = r.customer_id JOIN products p ON p.id = i.product_id
     WHERE r.status = 'POSTED' AND r.return_date BETWEEN v_from AND v_to AND (p_warehouse IS NULL OR r.warehouse_id = p_warehouse);

  RETURN jsonb_build_object(
    'period', jsonb_build_object('from', v_from, 'to', v_to, 'fp', to_char(v_from, 'MMYYYY')),
    'gstins', (SELECT coalesce(jsonb_agg(DISTINCT jsonb_build_object('gstin', gstin, 'warehouse', code, 'state_code', state_code)), '[]')
                 FROM warehouses WHERE p_warehouse IS NULL OR id = p_warehouse),
    'b2b', (SELECT coalesce(jsonb_agg(x ORDER BY x->>'invoice_date', x->>'invoice_no'), '[]') FROM (
              SELECT jsonb_build_object('gstin', gstin, 'customer', customer_name, 'invoice_no', invoice_no, 'invoice_date', invoice_date,
                       'value', max(invoice_value), 'pos', pos, 'inter', inter,
                       'rates', jsonb_agg(jsonb_build_object('rate', rate, 'taxable', tx, 'tax', tax) ORDER BY rate)) AS x
                FROM (SELECT gstin, customer_name, invoice_no, invoice_date, invoice_value, pos, inter, rate, sum(taxable) tx, sum(tax) tax
                        FROM _gl WHERE sign = 1 AND gstin IS NOT NULL AND rate > 0 GROUP BY 1,2,3,4,5,6,7,8) g
               GROUP BY gstin, customer_name, invoice_no, invoice_date, pos, inter) s),
    'b2cl', (SELECT coalesce(jsonb_agg(x ORDER BY x->>'invoice_date'), '[]') FROM (
              SELECT jsonb_build_object('invoice_no', invoice_no, 'invoice_date', invoice_date, 'value', max(invoice_value), 'pos', pos,
                       'rates', jsonb_agg(jsonb_build_object('rate', rate, 'taxable', tx, 'tax', tax) ORDER BY rate)) AS x
                FROM (SELECT invoice_no, invoice_date, invoice_value, pos, rate, sum(taxable) tx, sum(tax) tax
                        FROM _gl WHERE sign = 1 AND gstin IS NULL AND inter AND invoice_value > 100000 AND rate > 0 GROUP BY 1,2,3,4,5) g
               GROUP BY invoice_no, invoice_date, pos) s),
    'b2cs', (SELECT coalesce(jsonb_agg(jsonb_build_object('pos', pos, 'inter', inter, 'rate', rate, 'taxable', tx, 'tax', tax) ORDER BY pos, rate), '[]')
               FROM (SELECT pos, inter, rate, sum(sign * taxable) tx, sum(sign * tax) tax FROM _gl
                      WHERE gstin IS NULL AND rate > 0 AND NOT (sign = 1 AND inter AND invoice_value > 100000)
                      GROUP BY 1,2,3 HAVING sum(sign * taxable) <> 0) s),
    'cdnr', (SELECT coalesce(jsonb_agg(x ORDER BY x->>'note_date'), '[]') FROM (
              SELECT jsonb_build_object('gstin', gstin, 'customer', customer_name, 'note_no', note_no, 'note_date', note_date,
                       'invoice_no', invoice_no, 'invoice_date', invoice_date, 'value', max(invoice_value), 'pos', pos, 'inter', inter,
                       'rates', jsonb_agg(jsonb_build_object('rate', rate, 'taxable', tx, 'tax', tax) ORDER BY rate)) AS x
                FROM (SELECT gstin, customer_name, note_no, note_date, invoice_no, invoice_date, invoice_value, pos, inter, rate, sum(taxable) tx, sum(tax) tax
                        FROM _gl WHERE sign = -1 AND gstin IS NOT NULL GROUP BY 1,2,3,4,5,6,7,8,9,10) g
               GROUP BY gstin, customer_name, note_no, note_date, invoice_no, invoice_date, pos, inter) s),
    'nil', (SELECT jsonb_build_object(
               'intra_b2b', coalesce(sum(sign * taxable) FILTER (WHERE NOT inter AND gstin IS NOT NULL), 0),
               'intra_b2c', coalesce(sum(sign * taxable) FILTER (WHERE NOT inter AND gstin IS NULL), 0),
               'inter_b2b', coalesce(sum(sign * taxable) FILTER (WHERE inter AND gstin IS NOT NULL), 0),
               'inter_b2c', coalesce(sum(sign * taxable) FILTER (WHERE inter AND gstin IS NULL), 0)) FROM _gl WHERE rate = 0),
    'hsn', (SELECT coalesce(jsonb_agg(jsonb_build_object('b2b', b2b, 'hsn', hsn, 'description', item, 'rate', rate, 'qty', qty, 'value', tx + tax,
                       'taxable', tx, 'igst', CASE WHEN inter THEN tax ELSE 0 END,
                       'cgst', CASE WHEN inter THEN 0 ELSE round(tax / 2, 2) END,
                       'sgst', CASE WHEN inter THEN 0 ELSE tax - round(tax / 2, 2) END) ORDER BY b2b DESC, hsn, rate), '[]')
              FROM (SELECT gstin IS NOT NULL AS b2b, hsn, min(item) item, rate, inter, sum(sign * qty) qty, sum(sign * taxable) tx, sum(sign * tax) tax
                      FROM _gl GROUP BY 1, 2, 4, 5) h),
    'docs', jsonb_build_object(
       'invoices', (SELECT coalesce(jsonb_agg(jsonb_build_object('warehouse', w.code, 'from', x.mn, 'to', x.mx, 'total', x.n, 'cancelled', x.c)), '[]')
                      FROM (SELECT warehouse_id, min(invoice_no) mn, max(invoice_no) mx, count(*) n, count(*) FILTER (WHERE status = 'CANCELLED') c
                              FROM dispatches WHERE invoice_date BETWEEN v_from AND v_to AND (p_warehouse IS NULL OR warehouse_id = p_warehouse)
                             GROUP BY 1) x JOIN warehouses w ON w.id = x.warehouse_id),
       'credit_notes', (SELECT jsonb_build_object('from', min(return_no), 'to', max(return_no), 'total', count(*),
                                                  'cancelled', count(*) FILTER (WHERE status = 'CANCELLED'))
                          FROM sales_returns WHERE return_date BETWEEN v_from AND v_to AND (p_warehouse IS NULL OR warehouse_id = p_warehouse))),
    'gstr3b', jsonb_build_object(
       'outward', (SELECT jsonb_build_object('taxable', coalesce(sum(sign * taxable), 0),
                     'igst', coalesce(sum(sign * tax) FILTER (WHERE inter), 0),
                     'cgst', coalesce(sum(round(sign * tax / 2, 2)) FILTER (WHERE NOT inter), 0),
                     'sgst', coalesce(sum(sign * tax - round(sign * tax / 2, 2)) FILTER (WHERE NOT inter), 0)) FROM _gl WHERE rate > 0),
       'nil_exempt', (SELECT coalesce(sum(sign * taxable), 0) FROM _gl WHERE rate = 0),
       'inter_unregistered', (SELECT coalesce(jsonb_agg(jsonb_build_object('pos', pos, 'taxable', tx, 'igst', tax) ORDER BY pos), '[]')
                                FROM (SELECT pos, sum(sign * taxable) tx, sum(sign * tax) tax FROM _gl WHERE inter AND gstin IS NULL AND rate > 0 GROUP BY 1) s),
       'itc', (SELECT jsonb_build_object(
                 'igst', coalesce(sum(igst), 0), 'cgst', coalesce(sum(cgst), 0), 'sgst', coalesce(sum(sgst), 0), 'bills', count(*))
                 FROM (SELECT p.igst_total igst, p.cgst_total cgst, p.sgst_total sgst FROM purchases p
                        WHERE p.status = 'POSTED' AND p.vendor_gstin IS NOT NULL
                          AND coalesce(p.vendor_invoice_date, p.received_on) BETWEEN v_from AND v_to
                          AND (p_warehouse IS NULL OR p.warehouse_id = p_warehouse)
                       UNION ALL
                       SELECT CASE WHEN pu.is_interstate THEN -r.tax ELSE 0 END, CASE WHEN pu.is_interstate THEN 0 ELSE -round(r.tax / 2, 2) END,
                              CASE WHEN pu.is_interstate THEN 0 ELSE -(r.tax - round(r.tax / 2, 2)) END
                         FROM purchase_returns r JOIN purchases pu ON pu.id = r.purchase_id
                        WHERE r.status = 'POSTED' AND pu.vendor_gstin IS NOT NULL AND r.return_date BETWEEN v_from AND v_to
                          AND (p_warehouse IS NULL OR r.warehouse_id = p_warehouse)) i)),
    'purchases', (SELECT coalesce(jsonb_agg(jsonb_build_object('gstin', p.vendor_gstin, 'vendor', p.vendor_name, 'invoice_no', p.vendor_invoice_no,
                    'invoice_date', coalesce(p.vendor_invoice_date, p.received_on), 'taxable', p.taxable_total, 'igst', p.igst_total,
                    'cgst', p.cgst_total, 'sgst', p.sgst_total, 'total', p.grand_total) ORDER BY coalesce(p.vendor_invoice_date, p.received_on)), '[]')
                    FROM purchases p WHERE p.status = 'POSTED' AND coalesce(p.vendor_invoice_date, p.received_on) BETWEEN v_from AND v_to
                     AND (p_warehouse IS NULL OR p.warehouse_id = p_warehouse)));
END$$;

-- ===========================================================================
-- Prices and reorder levels in bulk
-- ===========================================================================
-- p = { brandId?, categoryId?, pct (e.g. 5 or -3), roundTo? (0.01 / 1 / 5 / 10), preview? }
CREATE FUNCTION public.owner_bulk_price(p jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, extensions, pg_temp AS $$
DECLARE v_pct numeric := nullif(p->>'pct', '')::numeric; v_round numeric := coalesce(nullif(p->>'roundTo', '')::numeric, 1); n int; v_sample jsonb;
BEGIN
  PERFORM app.require_full_owner();
  IF v_pct IS NULL OR v_pct = 0 OR v_pct < -90 OR v_pct > 300 THEN RAISE EXCEPTION 'Change must be between -90%% and +300%%' USING ERRCODE = 'WH005'; END IF;
  IF v_round NOT IN (0.01, 1, 5, 10) THEN RAISE EXCEPTION 'Round to 0.01, 1, 5 or 10' USING ERRCODE = 'WH005'; END IF;
  CREATE TEMP TABLE IF NOT EXISTS _bp(id uuid, old numeric, new numeric) ON COMMIT DROP;
  TRUNCATE _bp;
  INSERT INTO _bp
    SELECT pr.id, pr.default_selling_price, greatest(0, round(pr.default_selling_price * (1 + v_pct / 100) / v_round) * v_round)
      FROM products pr
     WHERE pr.is_active AND pr.default_selling_price IS NOT NULL
       AND (nullif(p->>'brandId', '') IS NULL OR pr.brand_id = (p->>'brandId')::uuid)
       AND (nullif(p->>'categoryId', '') IS NULL OR pr.category_id IN (
             WITH RECURSIVE t AS (SELECT id FROM categories WHERE id = (p->>'categoryId')::uuid
                                  UNION ALL SELECT c.id FROM categories c JOIN t ON c.parent_id = t.id) SELECT id FROM t));
  SELECT count(*) INTO n FROM _bp;
  SELECT coalesce(jsonb_agg(jsonb_build_object('sku_code', pr.sku_code, 'name', pr.name, 'old', b.old, 'new', b.new)), '[]') INTO v_sample
    FROM (SELECT * FROM _bp LIMIT 5) b JOIN products pr ON pr.id = b.id;
  IF NOT coalesce((p->>'preview')::boolean, false) THEN
    UPDATE products pr SET default_selling_price = b.new, updated_at = now() FROM _bp b WHERE pr.id = b.id;
    INSERT INTO audit_log(table_name, row_id, action, actor_id, old_data, new_data)
    VALUES ('public.products', 'bulk', 'BULK_PRICE', app.current_user_id(), NULL, p || jsonb_build_object('items', n));
  END IF;
  RETURN jsonb_build_object('items', n, 'sample', v_sample, 'applied', NOT coalesce((p->>'preview')::boolean, false));
END$$;

-- p = { warehouseId? (all), brandId?, categoryId?, mode: 'FIXED' | 'SALES', minQty, reorderQty, days (history, 90), coverDays (30) }
CREATE FUNCTION public.owner_bulk_reorder(p jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, fin, extensions, pg_temp AS $$
DECLARE v_mode text := coalesce(p->>'mode', 'FIXED'); v_days int := coalesce(nullif(p->>'days', '')::int, 90);
        v_cover int := coalesce(nullif(p->>'coverDays', '')::int, 30); n int;
BEGIN
  PERFORM app.require_owner();
  IF v_mode NOT IN ('FIXED', 'SALES') THEN RAISE EXCEPTION 'Unknown mode' USING ERRCODE = 'WH005'; END IF;
  IF v_mode = 'FIXED' AND (coalesce(nullif(p->>'minQty', '')::numeric, -1) < 0 OR coalesce(nullif(p->>'reorderQty', '')::numeric, -1) < 0) THEN
    RAISE EXCEPTION 'Enter the reorder level and quantity' USING ERRCODE = 'WH005';
  END IF;
  IF v_days NOT BETWEEN 7 AND 365 OR v_cover NOT BETWEEN 1 AND 180 THEN RAISE EXCEPTION 'Days out of range' USING ERRCODE = 'WH005'; END IF;
  WITH w AS (SELECT id FROM warehouses WHERE is_active AND (nullif(p->>'warehouseId', '') IS NULL OR id = (p->>'warehouseId')::uuid)),
  pr AS (SELECT id FROM products WHERE is_active
           AND (nullif(p->>'brandId', '') IS NULL OR brand_id = (p->>'brandId')::uuid)
           AND (nullif(p->>'categoryId', '') IS NULL OR category_id = (p->>'categoryId')::uuid)),
  sold AS (SELECT warehouse_id, product_id, sum(qty_base) / v_days::numeric AS per_day FROM fin.v_sales_lines
            WHERE invoice_date > app.today_ist() - v_days GROUP BY 1, 2),
  target AS (
    SELECT w.id wh, pr.id prod,
           CASE WHEN v_mode = 'FIXED' THEN (p->>'minQty')::numeric ELSE ceil(s.per_day * v_cover) END AS mn,
           CASE WHEN v_mode = 'FIXED' THEN (p->>'reorderQty')::numeric ELSE ceil(s.per_day * v_cover * 2) END AS rq
      FROM w CROSS JOIN pr LEFT JOIN sold s ON s.warehouse_id = w.id AND s.product_id = pr.id
     WHERE v_mode = 'FIXED' OR coalesce(s.per_day, 0) > 0),
  up AS (INSERT INTO reorder_rules(warehouse_id, product_id, min_qty_base, reorder_qty_base)
         SELECT wh, prod, mn, greatest(rq, mn) FROM target
         ON CONFLICT (warehouse_id, product_id) DO UPDATE SET min_qty_base = EXCLUDED.min_qty_base, reorder_qty_base = EXCLUDED.reorder_qty_base
         RETURNING 1)
  SELECT count(*) INTO n FROM up;
  RETURN jsonb_build_object('rules', n);
END$$;

-- ===========================================================================
-- Owner transfers: cancel (stock goes back if it had left)
-- ===========================================================================
CREATE FUNCTION public.owner_cancel_transfer(p_note uuid, p_reason text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, extensions, pg_temp AS $$
DECLARE n transfer_notes; r record;
BEGIN
  PERFORM app.require_owner();
  SELECT * INTO n FROM transfer_notes WHERE id = p_note FOR UPDATE;
  IF NOT FOUND OR n.status NOT IN ('DRAFT', 'IN_TRANSIT') THEN RAISE EXCEPTION 'Only a transfer not yet received can be cancelled' USING ERRCODE = 'WH005'; END IF;
  IF n.status = 'IN_TRANSIT' THEN
    FOR r IN SELECT * FROM transfer_note_items WHERE transfer_note_id = p_note LOOP
      PERFORM app.apply_movement(n.from_warehouse_id, r.product_id, 'REVERSAL', r.qty_base, 'transfer_note_items', r.id, p_note, NULL, true);
      UPDATE inventory_levels SET qty_in_transit = greatest(0, qty_in_transit - r.qty_base)
       WHERE warehouse_id = n.to_warehouse_id AND product_id = r.product_id;
    END LOOP;
  END IF;
  UPDATE transfer_notes SET status = 'CANCELLED', remarks = concat_ws(' · ', remarks, 'Cancelled: ' || nullif(btrim(p_reason), '')) WHERE id = p_note;
END$$;

-- ===========================================================================
-- Stock count: anyone counts (staff only in their warehouse); the owner applies the differences
-- ===========================================================================
CREATE FUNCTION app.require_count_access(p_wh uuid) RETURNS void
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, extensions, pg_temp AS $$
BEGIN
  PERFORM app.require_user();
  IF NOT app.is_owner() AND p_wh IS DISTINCT FROM app.current_warehouse_id() THEN
    RAISE EXCEPTION 'You can count only your own warehouse' USING ERRCODE = 'WH002';
  END IF;
END$$;

CREATE FUNCTION public.start_stock_count(p_warehouse uuid, p_note text DEFAULT NULL, p_brand uuid DEFAULT NULL) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, extensions, pg_temp AS $$
DECLARE v_id uuid; v_wh uuid := coalesce(p_warehouse, app.current_warehouse_id());
BEGIN
  PERFORM app.require_count_access(v_wh);
  SELECT id INTO v_id FROM stock_counts WHERE warehouse_id = v_wh AND status = 'OPEN';
  IF v_id IS NULL THEN
    INSERT INTO stock_counts(warehouse_id, brand_id, note, started_by) VALUES (v_wh, p_brand, nullif(btrim(p_note), ''), app.current_user_id())
    RETURNING id INTO v_id;
    PERFORM app.notify_owners('STOCK_COUNT', 'Stock count started',
      (SELECT full_name FROM users WHERE id = app.current_user_id()) || ' started counting ' || (SELECT name FROM warehouses WHERE id = v_wh),
      jsonb_build_object('count_id', v_id));
  END IF;
  RETURN jsonb_build_object('id', v_id);
END$$;

CREATE FUNCTION public.stock_counts_list(p_warehouse uuid DEFAULT NULL) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, extensions, pg_temp AS $$
BEGIN
  PERFORM app.require_user();
  RETURN (SELECT coalesce(jsonb_agg(jsonb_build_object('id', c.id, 'warehouse_id', c.warehouse_id, 'warehouse', w.name, 'warehouse_code', w.code,
            'brand', b.name, 'note', c.note, 'status', c.status, 'started_by', su.full_name, 'started_at', c.started_at,
            'finished_by', fu.full_name, 'finished_at', c.finished_at, 'result', c.result,
            'counted', (SELECT count(*) FROM stock_count_lines l WHERE l.count_id = c.id)) ORDER BY c.started_at DESC), '[]')
            FROM stock_counts c JOIN warehouses w ON w.id = c.warehouse_id JOIN users su ON su.id = c.started_by
            LEFT JOIN users fu ON fu.id = c.finished_by LEFT JOIN brands b ON b.id = c.brand_id
           WHERE (app.is_owner() OR c.warehouse_id = app.current_warehouse_id())
             AND (p_warehouse IS NULL OR c.warehouse_id = p_warehouse)
             AND c.started_at > now() - interval '180 days');
END$$;

CREATE FUNCTION public.stock_count_sheet(p_count uuid) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, extensions, pg_temp AS $$
DECLARE c stock_counts;
BEGIN
  SELECT * INTO c FROM stock_counts WHERE id = p_count;
  IF NOT FOUND THEN RAISE EXCEPTION 'Count not found' USING ERRCODE = 'WH005'; END IF;
  PERFORM app.require_count_access(c.warehouse_id);
  RETURN jsonb_build_object('id', c.id, 'status', c.status, 'warehouse_id', c.warehouse_id, 'note', c.note, 'result', c.result,
    'items', (SELECT coalesce(jsonb_agg(jsonb_build_object('product_id', p.id, 'sku_code', p.sku_code, 'name', p.name, 'brand', b.name,
                'unit', p.base_uom, 'system_qty', coalesce(il.qty_on_hand, 0), 'counted_qty', l.counted_qty, 'counted_by', u.full_name)
                ORDER BY (l.counted_qty IS NULL), b.name, p.name), '[]')
                FROM products p LEFT JOIN brands b ON b.id = p.brand_id
                LEFT JOIN inventory_levels il ON il.product_id = p.id AND il.warehouse_id = c.warehouse_id
                LEFT JOIN stock_count_lines l ON l.count_id = c.id AND l.product_id = p.id
                LEFT JOIN users u ON u.id = l.counted_by
               WHERE (p.is_active AND (c.brand_id IS NULL OR p.brand_id = c.brand_id)
                      AND (coalesce(il.qty_on_hand, 0) <> 0 OR c.brand_id IS NOT NULL))
                  OR l.product_id IS NOT NULL));
END$$;

CREATE FUNCTION public.save_count_line(p_count uuid, p_product uuid, p_qty numeric) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, extensions, pg_temp AS $$
DECLARE c stock_counts;
BEGIN
  SELECT * INTO c FROM stock_counts WHERE id = p_count FOR SHARE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Count not found' USING ERRCODE = 'WH005'; END IF;
  PERFORM app.require_count_access(c.warehouse_id);
  IF c.status <> 'OPEN' THEN RAISE EXCEPTION 'This count is already finished' USING ERRCODE = 'WH005'; END IF;
  IF p_qty IS NULL THEN DELETE FROM stock_count_lines WHERE count_id = p_count AND product_id = p_product; RETURN; END IF;
  IF p_qty < 0 THEN RAISE EXCEPTION 'Count cannot be negative' USING ERRCODE = 'WH005'; END IF;
  INSERT INTO stock_count_lines(count_id, product_id, counted_qty, counted_by) VALUES (p_count, p_product, p_qty, app.current_user_id())
  ON CONFLICT (count_id, product_id) DO UPDATE SET counted_qty = EXCLUDED.counted_qty, counted_by = EXCLUDED.counted_by, counted_at = now();
END$$;

-- p_apply = true: stock becomes what was counted (only counted items); false: discard.
CREATE FUNCTION public.owner_finish_stock_count(p_count uuid, p_apply boolean) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, extensions, pg_temp AS $$
DECLARE c stock_counts; r record; n int := 0; v_up numeric := 0; v_down numeric := 0; v_res jsonb;
BEGIN
  PERFORM app.require_owner();
  SELECT * INTO c FROM stock_counts WHERE id = p_count FOR UPDATE;
  IF NOT FOUND OR c.status <> 'OPEN' THEN RAISE EXCEPTION 'Count not found or already finished' USING ERRCODE = 'WH005'; END IF;
  IF p_apply THEN
    FOR r IN SELECT l.product_id, l.counted_qty, coalesce(il.qty_on_hand, 0) AS sys
               FROM stock_count_lines l LEFT JOIN inventory_levels il ON il.product_id = l.product_id AND il.warehouse_id = c.warehouse_id
              WHERE l.count_id = p_count AND l.counted_qty <> coalesce(il.qty_on_hand, 0) LOOP
      INSERT INTO stock_adjustments(warehouse_id, product_id, movement, qty_delta_base, notes)
      VALUES (c.warehouse_id, r.product_id, 'ADJUST_AUDIT', r.counted_qty - r.sys, 'Stock count ' || to_char(c.started_at AT TIME ZONE 'Asia/Kolkata', 'DD-Mon-YYYY'));
      n := n + 1;
      IF r.counted_qty > r.sys THEN v_up := v_up + (r.counted_qty - r.sys); ELSE v_down := v_down + (r.sys - r.counted_qty); END IF;
    END LOOP;
  END IF;
  v_res := jsonb_build_object('counted', (SELECT count(*) FROM stock_count_lines WHERE count_id = p_count), 'changed', n, 'units_up', v_up, 'units_down', v_down);
  UPDATE stock_counts SET status = CASE WHEN p_apply THEN 'APPLIED' ELSE 'DISCARDED' END, finished_by = app.current_user_id(), finished_at = now(),
         result = v_res WHERE id = p_count;
  RETURN v_res;
END$$;

-- ===========================================================================
-- Items: hide / show, merge duplicates, photos
-- ===========================================================================
CREATE FUNCTION public.owner_set_item_active(p_product uuid, p_active boolean) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, extensions, pg_temp AS $$
BEGIN
  PERFORM app.require_owner();
  IF NOT p_active AND EXISTS (SELECT 1 FROM inventory_levels WHERE product_id = p_product AND (qty_on_hand <> 0 OR qty_in_transit <> 0)) THEN
    RAISE EXCEPTION 'This item still has stock — set its stock to 0 (or merge it) before hiding it' USING ERRCODE = 'WH005';
  END IF;
  UPDATE products SET is_active = p_active, updated_at = now() WHERE id = p_product;
  IF NOT FOUND THEN RAISE EXCEPTION 'Item not found' USING ERRCODE = 'WH005'; END IF;
END$$;

-- Moves everything from p_drop into p_keep (stock, bills, history); p_drop's code becomes an old code of p_keep.
CREATE FUNCTION public.owner_merge_items(p_keep uuid, p_drop uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, fin, extensions, pg_temp AS $$
DECLARE k products; d products; v_moved numeric;
BEGIN
  PERFORM app.require_full_owner();
  IF p_keep = p_drop THEN RAISE EXCEPTION 'Pick two different items' USING ERRCODE = 'WH005'; END IF;
  SELECT * INTO k FROM products WHERE id = p_keep FOR UPDATE;
  SELECT * INTO d FROM products WHERE id = p_drop FOR UPDATE;
  IF k.id IS NULL OR d.id IS NULL THEN RAISE EXCEPTION 'Item not found' USING ERRCODE = 'WH005'; END IF;
  IF EXISTS (SELECT 1 FROM transfer_note_items i JOIN transfer_notes n ON n.id = i.transfer_note_id
              WHERE i.product_id = p_drop AND n.status IN ('DRAFT', 'IN_TRANSIT')) THEN
    RAISE EXCEPTION 'Receive or cancel open transfers of this item first' USING ERRCODE = 'WH005';
  END IF;
  IF EXISTS (SELECT 1 FROM stock_count_lines l JOIN stock_counts c ON c.id = l.count_id WHERE l.product_id = p_drop AND c.status = 'OPEN') THEN
    RAISE EXCEPTION 'Finish the open stock count first' USING ERRCODE = 'WH005';
  END IF;

  -- units used on old bills must exist on the kept item
  INSERT INTO product_uoms(product_id, uom_code, display_name, factor_to_base, is_base, sort_order)
  SELECT p_keep, u.uom_code, u.display_name, u.factor_to_base, false, u.sort_order FROM product_uoms u
   WHERE u.product_id = p_drop AND NOT EXISTS (SELECT 1 FROM product_uoms x WHERE x.product_id = p_keep AND x.uom_code = u.uom_code);

  SELECT coalesce(sum(qty_on_hand), 0) INTO v_moved FROM inventory_levels WHERE product_id = p_drop;
  INSERT INTO inventory_levels AS il (warehouse_id, product_id, qty_on_hand, qty_in_transit, last_movement_at, last_outward_at)
  SELECT warehouse_id, p_keep, qty_on_hand, 0, last_movement_at, last_outward_at FROM inventory_levels WHERE product_id = p_drop
  ON CONFLICT (warehouse_id, product_id) DO UPDATE SET qty_on_hand = il.qty_on_hand + EXCLUDED.qty_on_hand,
     last_movement_at = greatest(il.last_movement_at, EXCLUDED.last_movement_at), updated_at = now();
  DELETE FROM inventory_levels WHERE product_id = p_drop;

  UPDATE dispatch_items SET product_id = p_keep WHERE product_id = p_drop;
  UPDATE purchase_items SET product_id = p_keep WHERE product_id = p_drop;
  UPDATE transfer_note_items SET product_id = p_keep WHERE product_id = p_drop;
  UPDATE stock_movements SET product_id = p_keep WHERE product_id = p_drop;
  UPDATE stock_adjustments SET product_id = p_keep WHERE product_id = p_drop;
  UPDATE sales_return_items SET product_id = p_keep WHERE product_id = p_drop;
  UPDATE purchase_return_items SET product_id = p_keep WHERE product_id = p_drop;
  UPDATE fin.purchase_order_items SET product_id = p_keep WHERE product_id = p_drop;
  DELETE FROM stock_count_lines WHERE product_id = p_drop;
  DELETE FROM reorder_rules r WHERE r.product_id = p_drop AND EXISTS (SELECT 1 FROM reorder_rules x WHERE x.product_id = p_keep AND x.warehouse_id = r.warehouse_id);
  UPDATE reorder_rules SET product_id = p_keep WHERE product_id = p_drop;
  UPDATE product_images SET product_id = p_keep, is_primary = false WHERE product_id = p_drop;
  UPDATE product_aliases a SET product_id = p_keep WHERE product_id = p_drop
     AND NOT EXISTS (SELECT 1 FROM product_aliases x WHERE x.product_id = p_keep AND lower(x.alias) = lower(a.alias));
  DELETE FROM products WHERE id = p_drop;
  PERFORM public.add_product_alias(p_keep, d.sku_code, 'en');
  INSERT INTO audit_log(table_name, row_id, action, actor_id, old_data, new_data)
  VALUES ('public.products', p_drop::text, 'MERGE', app.current_user_id(), to_jsonb(d), jsonb_build_object('into', p_keep, 'stock_moved', v_moved));
  RETURN jsonb_build_object('stock_moved', v_moved, 'old_code', d.sku_code);
END$$;

CREATE FUNCTION public.owner_item_photos(p_product uuid) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, extensions, pg_temp AS $$
BEGIN
  PERFORM app.require_user();
  RETURN (SELECT coalesce(jsonb_agg(jsonb_build_object('id', id, 'storage_key', storage_key, 'is_primary', is_primary) ORDER BY is_primary DESC, sort_order, created_at), '[]')
            FROM product_images WHERE product_id = p_product);
END$$;

CREATE FUNCTION public.owner_add_item_photo(p_product uuid, p_key text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, extensions, pg_temp AS $$
DECLARE v_id uuid; v_first boolean;
BEGIN
  PERFORM app.require_owner();
  IF p_key !~ ('^' || p_product::text || '/[A-Za-z0-9._-]+$') THEN RAISE EXCEPTION 'Bad photo path' USING ERRCODE = 'WH005'; END IF;
  v_first := NOT EXISTS (SELECT 1 FROM product_images WHERE product_id = p_product AND is_primary);
  INSERT INTO product_images(product_id, storage_key, is_primary, sort_order)
  VALUES (p_product, p_key, v_first, (SELECT count(*) FROM product_images WHERE product_id = p_product)) RETURNING id INTO v_id;
  RETURN jsonb_build_object('id', v_id, 'is_primary', v_first);
END$$;

CREATE FUNCTION public.owner_photo_primary(p_id uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, extensions, pg_temp AS $$
DECLARE v_prod uuid;
BEGIN
  PERFORM app.require_owner();
  SELECT product_id INTO v_prod FROM product_images WHERE id = p_id;
  UPDATE product_images SET is_primary = false WHERE product_id = v_prod AND is_primary;
  UPDATE product_images SET is_primary = true WHERE id = p_id;
END$$;

-- returns the storage key so the app can delete the file
CREATE FUNCTION public.owner_delete_item_photo(p_id uuid) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, extensions, pg_temp AS $$
DECLARE v_key text; v_prod uuid; v_primary boolean;
BEGIN
  PERFORM app.require_owner();
  DELETE FROM product_images WHERE id = p_id RETURNING storage_key, product_id, is_primary INTO v_key, v_prod, v_primary;
  IF v_primary THEN
    UPDATE product_images SET is_primary = true WHERE id = (SELECT id FROM product_images WHERE product_id = v_prod ORDER BY sort_order, created_at LIMIT 1);
  END IF;
  RETURN v_key;
END$$;

CREATE FUNCTION public.owner_hidden_items() RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, extensions, pg_temp AS $$
BEGIN
  PERFORM app.require_owner();
  RETURN (SELECT coalesce(jsonb_agg(jsonb_build_object('id', p.id, 'sku_code', p.sku_code, 'name', p.name, 'brand', b.name) ORDER BY p.name), '[]')
            FROM products p LEFT JOIN brands b ON b.id = p.brand_id WHERE NOT p.is_active);
END$$;

-- ===========================================================================
-- Activity log (who did what, newest first)
-- ===========================================================================
CREATE FUNCTION public.owner_activity(p_limit int DEFAULT 100, p_before timestamptz DEFAULT NULL, p_user uuid DEFAULT NULL) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, fin, extensions, pg_temp AS $$
DECLARE v_before timestamptz := coalesce(p_before, now() + interval '1 minute'); v_lim int := least(greatest(coalesce(p_limit, 100), 1), 300);
BEGIN
  PERFORM app.require_owner();
  RETURN (SELECT coalesce(jsonb_agg(jsonb_build_object('at', e.ts, 'kind', e.kind, 'text', e.txt, 'user_id', e.uid, 'who', u.full_name)
                             ORDER BY e.ts DESC), '[]') FROM (
    SELECT * FROM (
      SELECT d.created_at AS ts, d.created_by AS uid, 'SALE'::text AS kind, 'Sale ' || d.invoice_no || ' to ' || d.customer_name || ' · ₹' || d.grand_total AS txt
        FROM dispatches d WHERE d.created_at < v_before
      UNION ALL SELECT p.created_at, p.created_by, 'PURCHASE', 'Purchase from ' || coalesce(p.vendor_name, '?') || coalesce(' (' || p.vendor_invoice_no || ')', '') || ' · ₹' || p.grand_total
        FROM purchases p WHERE p.created_at < v_before
      UNION ALL SELECT a.at, a.actor_id, CASE a.action WHEN 'UPDATE' THEN 'CHANGE' ELSE a.action END,
             initcap(replace(split_part(a.table_name, '.', 2), '_', ' ')) || ' ' || lower(a.action)
             || coalesce(': ' || coalesce(a.new_data->>'invoice_no', a.old_data->>'invoice_no', a.new_data->>'vendor_invoice_no'), '')
             || CASE WHEN a.new_data->>'status' = 'CANCELLED' THEN ' — cancelled' || coalesce(' (' || coalesce(a.new_data->>'cancelled_reason', a.new_data->>'rejected_reason') || ')', '') ELSE '' END
        FROM audit_log a WHERE a.at < v_before AND a.actor_id IS NOT NULL
      UNION ALL SELECT cp.created_at, cp.entered_by, 'PAYMENT', CASE WHEN cp.mode = 'CREDIT_NOTE' THEN 'Credit note ' ELSE 'Payment received ' END || '₹' || cp.amount || ' from ' || c.name || ' (' || cp.mode || ')'
        FROM fin.customer_payments cp JOIN customers c ON c.id = cp.customer_id WHERE cp.created_at < v_before
      UNION ALL SELECT vp.created_at, vp.entered_by, 'SUPPLIER_PAYMENT', 'Paid ₹' || vp.amount || ' to ' || v.name || ' (' || vp.mode || ')'
        FROM fin.vendor_payments vp JOIN vendors v ON v.id = vp.vendor_id WHERE vp.created_at < v_before
      UNION ALL SELECT e.created_at, e.created_by, 'EXPENSE', 'Expense ₹' || e.amount || ' · ' || e.category || coalesce(' · ' || e.paid_to, '')
        FROM fin.expenses e WHERE e.created_at < v_before
      UNION ALL SELECT sa.created_at, sa.created_by, 'STOCK', 'Stock ' || CASE WHEN sa.qty_delta_base > 0 THEN '+' ELSE '' END || sa.qty_delta_base || ' · ' || pr.name
             || ' (' || replace(lower(sa.movement::text), 'adjust_', '') || ')'
        FROM stock_adjustments sa JOIN products pr ON pr.id = sa.product_id WHERE sa.created_at < v_before
      UNION ALL SELECT t.created_at, t.created_by, 'TRANSFER', 'Transfer ' || t.note_no FROM transfer_notes t WHERE t.created_at < v_before
      UNION ALL SELECT r.created_at, r.created_by, 'RETURN', 'Sales return ' || r.return_no || ' · ₹' || r.total FROM sales_returns r WHERE r.created_at < v_before
      UNION ALL SELECT r.created_at, r.created_by, 'RETURN', 'Purchase return ' || r.return_no || ' · ₹' || r.total FROM purchase_returns r WHERE r.created_at < v_before
      UNION ALL SELECT a.clock_in_at, a.user_id, 'CLOCK', 'Clocked in' FROM attendance a WHERE a.clock_in_at < v_before
      UNION ALL SELECT a.clock_out_at, a.user_id, 'CLOCK', 'Clocked out' FROM attendance a WHERE a.clock_out_at < v_before
      UNION ALL SELECT l.created_at, l.user_id, 'LOGIN', CASE WHEN l.success THEN 'Logged in' ELSE 'Wrong password' END || coalesce(' · ' || l.device_name, '')
        FROM login_events l WHERE l.created_at < v_before AND l.user_id IS NOT NULL
    ) e0 WHERE (p_user IS NULL OR e0.uid = p_user) AND e0.ts IS NOT NULL
    ORDER BY e0.ts DESC LIMIT v_lim) e LEFT JOIN users u ON u.id = e.uid);
END$$;

-- ===========================================================================
-- Export everything for a period (the app turns it into one Excel file)
-- ===========================================================================
CREATE FUNCTION public.owner_export_all(p_from date, p_to date) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, fin, extensions, pg_temp AS $$
BEGIN
  PERFORM app.require_full_owner();
  RETURN jsonb_build_object(
    'sales', (SELECT coalesce(jsonb_agg(jsonb_build_object('date', d.invoice_date, 'invoice_no', d.invoice_no, 'warehouse', w.code,
                'customer', d.customer_name, 'gstin', d.customer_gstin, 'taxable', d.taxable_total, 'cgst', d.cgst_total, 'sgst', d.sgst_total,
                'igst', d.igst_total, 'charges', d.loading_charges + d.transport_charges + d.other_charges, 'total', d.grand_total,
                'status', d.status, 'by', u.full_name) ORDER BY d.invoice_date, d.invoice_no), '[]')
                FROM dispatches d JOIN warehouses w ON w.id = d.warehouse_id JOIN users u ON u.id = d.created_by
               WHERE d.invoice_date BETWEEN p_from AND p_to),
    'sale_items', (SELECT coalesce(jsonb_agg(jsonb_build_object('date', d.invoice_date, 'invoice_no', d.invoice_no, 'customer', d.customer_name,
                     'sku', p.sku_code, 'item', p.name, 'hsn', di.hsn_code, 'qty', di.qty, 'unit', di.uom_code, 'price', di.unit_base_price,
                     'discount', di.line_discount, 'taxable', di.line_taxable, 'gst_rate', di.gst_rate, 'gst', di.line_tax, 'total', di.line_total)
                     ORDER BY d.invoice_date, d.invoice_no, di.line_no), '[]')
                     FROM dispatches d JOIN dispatch_items di ON di.dispatch_id = d.id JOIN products p ON p.id = di.product_id
                    WHERE d.status = 'POSTED' AND d.invoice_date BETWEEN p_from AND p_to),
    'purchases', (SELECT coalesce(jsonb_agg(jsonb_build_object('date', coalesce(pu.vendor_invoice_date, pu.received_on), 'invoice_no', pu.vendor_invoice_no,
                    'warehouse', w.code, 'supplier', pu.vendor_name, 'gstin', pu.vendor_gstin, 'taxable', pu.taxable_total, 'cgst', pu.cgst_total,
                    'sgst', pu.sgst_total, 'igst', pu.igst_total, 'total', pu.grand_total, 'status', pu.status, 'by', u.full_name)
                    ORDER BY coalesce(pu.vendor_invoice_date, pu.received_on)), '[]')
                    FROM purchases pu JOIN warehouses w ON w.id = pu.warehouse_id JOIN users u ON u.id = pu.created_by
                   WHERE coalesce(pu.vendor_invoice_date, pu.received_on, (pu.created_at AT TIME ZONE 'Asia/Kolkata')::date) BETWEEN p_from AND p_to),
    'payments_in', (SELECT coalesce(jsonb_agg(jsonb_build_object('date', cp.paid_on, 'customer', c.name, 'amount', cp.amount, 'mode', cp.mode,
                      'reference', cp.reference, 'notes', cp.notes, 'by', u.full_name) ORDER BY cp.paid_on), '[]')
                      FROM fin.customer_payments cp JOIN customers c ON c.id = cp.customer_id JOIN users u ON u.id = cp.entered_by
                     WHERE cp.paid_on BETWEEN p_from AND p_to),
    'payments_out', (SELECT coalesce(jsonb_agg(jsonb_build_object('date', vp.paid_on, 'supplier', v.name, 'amount', vp.amount, 'mode', vp.mode,
                       'reference', vp.reference, 'notes', vp.notes) ORDER BY vp.paid_on), '[]')
                       FROM fin.vendor_payments vp JOIN vendors v ON v.id = vp.vendor_id WHERE vp.paid_on BETWEEN p_from AND p_to),
    'expenses', (SELECT coalesce(jsonb_agg(jsonb_build_object('date', spent_on, 'category', category, 'amount', amount, 'mode', mode,
                   'paid_to', paid_to, 'notes', notes) ORDER BY spent_on), '[]') FROM fin.expenses WHERE spent_on BETWEEN p_from AND p_to),
    'customers', public.owner_customers(),
    'suppliers', public.owner_suppliers(),
    'stock', (SELECT coalesce(jsonb_agg(jsonb_build_object('warehouse', warehouse_code, 'sku', sku_code, 'item', name, 'brand', brand,
                'category', category_path, 'qty', qty_on_hand, 'value', valuation, 'basis', value_basis) ORDER BY warehouse_code, name), '[]')
                FROM fin.v_stock_overview WHERE qty_on_hand <> 0),
    'attendance', (SELECT coalesce(jsonb_agg(jsonb_build_object('date', a.work_date, 'employee', u.full_name, 'in', a.clock_in_at, 'out', a.clock_out_at)
                     ORDER BY a.work_date, u.full_name), '[]')
                     FROM attendance a JOIN users u ON u.id = a.user_id WHERE a.work_date BETWEEN p_from AND p_to));
END$$;

-- ===========================================================================
-- Grants: every new public function is for signed-in users only (each checks the role itself)
-- ===========================================================================
REVOKE EXECUTE ON FUNCTION app.require_full_owner(), app.guard_note_payment(), app.next_note_no(text, uuid, date),
  app.sales_return_json(uuid), app.purchase_return_json(uuid), app.recompute_dispatch_totals(uuid), app.clean_party(jsonb),
  app.require_count_access(uuid), fin.vendor_bills() FROM PUBLIC, anon, authenticated;
DO $$
DECLARE r record;
BEGIN
  FOR r IN SELECT p.oid::regprocedure AS f FROM pg_proc p
            WHERE p.pronamespace = 'public'::regnamespace AND p.proname = ANY (ARRAY[
              'business_profile', 'owner_business_settings', 'owner_save_business', 'returnable_lines', 'create_sales_return',
              'owner_cancel_sales_return', 'create_purchase_return', 'owner_cancel_purchase_return', 'owner_returns',
              'owner_edit_dispatch', 'owner_dispatch_revisions', 'invoice_data', 'owner_suppliers', 'owner_supplier_statement',
              'owner_record_vendor_payment', 'owner_delete_vendor_payment', 'owner_save_vendor', 'owner_merge_vendors',
              'owner_customers', 'owner_save_customer', 'owner_merge_customers', 'owner_add_expense', 'owner_delete_expense',
              'owner_expenses', 'owner_cash_book', 'owner_pnl', 'owner_gst_report', 'owner_bulk_price', 'owner_bulk_reorder',
              'owner_cancel_transfer', 'start_stock_count', 'stock_counts_list', 'stock_count_sheet', 'save_count_line',
              'owner_finish_stock_count', 'owner_set_item_active', 'owner_merge_items', 'owner_item_photos', 'owner_add_item_photo',
              'owner_photo_primary', 'owner_delete_item_photo', 'owner_hidden_items', 'owner_activity', 'owner_export_all'])
  LOOP
    EXECUTE format('REVOKE EXECUTE ON FUNCTION %s FROM PUBLIC, anon', r.f);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO authenticated', r.f);
  END LOOP;
END$$;

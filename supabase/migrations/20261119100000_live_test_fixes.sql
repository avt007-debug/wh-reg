-- Fixes after the first week of live testing (19 Nov 2026):
--   • Forgotten clock-outs: an open shift from an earlier day is closed automatically at the day's clock-out time
--     (marked "auto"), and the employee is told to ask for a correction if it is wrong.
--   • WhatsApp messages queued while WhatsApp is not connected are dropped once they are old, so connecting
--     WhatsApp later does not send a pile of stale reminders.
--   • Login: a removed User ID is reported as removed (not as a wrong password).
--   • My Day also lists payments collected and market runs today.
--   • Activity log: clearer wording, no duplicate lines.
--   • GST report, cash book and bulk price change no longer use temporary tables (the SQL checker could not see them).

-- ---------------------------------------------------------------------------
-- Forgotten clock-outs
-- ---------------------------------------------------------------------------
ALTER TABLE attendance ADD COLUMN auto_closed boolean NOT NULL DEFAULT false;

CREATE FUNCTION app.auto_close_shifts(p_now timestamptz DEFAULT now()) RETURNS int
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, extensions, pg_temp AS $$
DECLARE r record; n int := 0; v_out timestamptz;
        v_time time := coalesce((app.setting('notifications')->'clock_out'->>'time')::time, '18:30');
BEGIN
  FOR r IN SELECT a.* FROM attendance a
            WHERE a.clock_out_at IS NULL AND (a.clock_in_at AT TIME ZONE 'Asia/Kolkata')::date < (p_now AT TIME ZONE 'Asia/Kolkata')::date
            FOR UPDATE LOOP
    v_out := greatest(r.clock_in_at, ((r.clock_in_at AT TIME ZONE 'Asia/Kolkata')::date + v_time) AT TIME ZONE 'Asia/Kolkata');
    UPDATE attendance SET clock_out_at = v_out, auto_closed = true,
           clock_out_note = concat_ws(' · ', clock_out_note, 'Auto: forgot to clock out')
     WHERE id = r.id;
    PERFORM app.notify_user(r.user_id, 'AUTO_CLOCK_OUT', 'You forgot to clock out',
      'Your shift on ' || to_char(r.clock_in_at AT TIME ZONE 'Asia/Kolkata', 'DD Mon') || ' was closed at '
      || to_char(v_out AT TIME ZONE 'Asia/Kolkata', 'HH12:MI AM') || '. If that is wrong, send a correction from "Leave & fixes".',
      jsonb_build_object('attendance_id', r.id), 'autoclose:' || r.id);
    n := n + 1;
  END LOOP;
  RETURN n;
END$$;
REVOKE EXECUTE ON FUNCTION app.auto_close_shifts(timestamptz) FROM PUBLIC, anon, authenticated;

-- run it (and the stale-WhatsApp clean-up) every time the 5-minute scheduler runs
DO $$
DECLARE def text := pg_get_functiondef('app.run_schedules(timestamptz)'::regprocedure);
BEGIN
  IF position('IF s IS NULL THEN RETURN v_done; END IF;' IN def) = 0 THEN RAISE EXCEPTION 'run_schedules patch target missing'; END IF;
  EXECUTE replace(def, 'IF s IS NULL THEN RETURN v_done; END IF;', 'IF s IS NULL THEN RETURN v_done; END IF;
  IF app.auto_close_shifts(p_now) > 0 THEN v_done := v_done || ''"auto_close"''; END IF;
  UPDATE notification_outbox SET status = ''DEAD'', last_error = ''Not sent: too old (WhatsApp was not connected in time)''
   WHERE event_type = ''WA_TEMPLATE'' AND status = ''PENDING'' AND created_at < p_now - interval ''3 hours'';');
END$$;

-- ---------------------------------------------------------------------------
-- Login: removed User IDs
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.login_precheck(p_login_id text) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, extensions, pg_temp AS $$
  SELECT jsonb_build_object(
    'locked_until', CASE WHEN app.login_lock_until(p_login_id) > now() THEN app.login_lock_until(p_login_id) END,
    'removed', EXISTS (SELECT 1 FROM users WHERE login_id = lower(btrim(p_login_id))::extensions.citext AND removed_at IS NOT NULL))
$$;

-- ---------------------------------------------------------------------------
-- My Day: sales, purchases, payments collected, market runs
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.my_day() RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, fin, extensions, pg_temp AS $$
  SELECT jsonb_build_object(
    'dispatches', (SELECT coalesce(jsonb_agg(app.dispatch_json(id) ORDER BY created_at DESC), '[]') FROM dispatches
                    WHERE created_by = app.current_user_id() AND created_at >= app.today_ist_start()),
    'purchases',  (SELECT coalesce(jsonb_agg(app.purchase_json(id) ORDER BY created_at DESC), '[]') FROM purchases
                    WHERE created_by = app.current_user_id() AND created_at >= app.today_ist_start()),
    'payments',   (SELECT coalesce(jsonb_agg(jsonb_build_object('id', cp.id, 'customer', c.name, 'amount', cp.amount, 'mode', cp.mode,
                      'reference', cp.reference, 'created_at', cp.created_at) ORDER BY cp.created_at DESC), '[]')
                     FROM fin.customer_payments cp JOIN customers c ON c.id = cp.customer_id
                    WHERE cp.entered_by = app.current_user_id() AND cp.created_at >= app.today_ist_start() AND cp.mode <> 'CREDIT_NOTE'),
    'runs',       (SELECT coalesce(jsonb_agg(jsonb_build_object('id', r.id, 'place', r.place, 'created_at', r.created_at,
                      'visits', (SELECT count(*) FROM customer_visits v WHERE v.run_id = r.id)) ORDER BY r.created_at DESC), '[]')
                     FROM market_runs r WHERE r.user_id = app.current_user_id() AND r.created_at >= app.today_ist_start()))
$$;

-- ---------------------------------------------------------------------------
-- Activity log wording; reports without temporary tables
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.owner_activity(p_limit int DEFAULT 100, p_before timestamptz DEFAULT NULL, p_user uuid DEFAULT NULL) RETURNS jsonb
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
             CASE
               WHEN a.table_name = 'public.purchases' AND a.new_data->>'status' = 'POSTED' AND a.old_data->>'status' = 'PENDING'
                 THEN 'Purchase approved: ' || coalesce(a.new_data->>'vendor_invoice_no', '') || ' · ₹' || (a.new_data->>'grand_total')
               WHEN a.table_name = 'public.purchases' AND a.new_data->>'status' = 'REJECTED'
                 THEN 'Purchase rejected: ' || coalesce(a.new_data->>'vendor_invoice_no', '') || coalesce(' (' || (a.new_data->>'rejected_reason') || ')', '')
               WHEN a.new_data->>'status' = 'CANCELLED' AND a.old_data->>'status' IS DISTINCT FROM 'CANCELLED'
                 THEN CASE a.table_name WHEN 'public.dispatches' THEN 'Sale bill cancelled: ' WHEN 'public.purchases' THEN 'Purchase cancelled: ' ELSE 'Cancelled: ' END
                      || coalesce(a.new_data->>'invoice_no', a.new_data->>'vendor_invoice_no', '') || coalesce(' (' || (a.new_data->>'cancelled_reason') || ')', '')
               WHEN a.action = 'EDIT' AND a.table_name = 'public.dispatches'
                 THEN 'Sale bill edited: ' || coalesce(a.new_data->>'invoice_no', '') || ' · now ₹' || (a.new_data->>'grand_total')
               WHEN a.action = 'MERGE' THEN 'Merged ' || replace(split_part(a.table_name, '.', 2), '_', ' ') || ' (duplicate removed)'
               ELSE initcap(replace(split_part(a.table_name, '.', 2), '_', ' ')) || ' changed'
                    || coalesce(': ' || coalesce(a.new_data->>'invoice_no', a.new_data->>'vendor_invoice_no', a.new_data->>'name', a.new_data->>'full_name'), '')
             END
        FROM audit_log a WHERE a.at < v_before AND a.actor_id IS NOT NULL AND a.action <> 'INSERT'
          -- plain inserts are already listed as sales / purchases / payments above
          AND NOT (a.action = 'UPDATE' AND a.table_name IN ('public.dispatches', 'public.purchases')
                   AND a.new_data->>'status' IS NOT DISTINCT FROM a.old_data->>'status' AND a.new_data->>'status' <> 'CANCELLED')
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

CREATE FUNCTION app.cash_flows(v_open_date date) RETURNS TABLE(d date, at timestamptz, kind text, party text, ref text, mode text, amt numeric)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, fin, extensions, pg_temp AS $$
    SELECT cp.paid_on, cp.created_at, 'RECEIVED', c.name, cp.reference, cp.mode, cp.amount
      FROM fin.customer_payments cp JOIN customers c ON c.id = cp.customer_id WHERE cp.mode <> 'CREDIT_NOTE' AND cp.paid_on >= v_open_date
    UNION ALL
    SELECT vp.paid_on, vp.created_at, 'PAID_SUPPLIER', v.name, vp.reference, vp.mode, -vp.amount
      FROM fin.vendor_payments vp JOIN vendors v ON v.id = vp.vendor_id WHERE vp.mode <> 'DEBIT_NOTE' AND vp.paid_on >= v_open_date
    UNION ALL
    SELECT e.spent_on, e.created_at, 'EXPENSE', coalesce(e.paid_to, e.category), e.category, e.mode, -e.amount
      FROM fin.expenses e WHERE e.spent_on >= v_open_date
$$;

CREATE OR REPLACE FUNCTION public.owner_cash_book(p_from date, p_to date) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, fin, extensions, pg_temp AS $$
DECLARE s jsonb := coalesce(app.setting('business'), '{}'); v_open_date date; v_cash numeric; v_bank numeric;
BEGIN
  PERFORM app.require_full_owner();
  v_open_date := coalesce(nullif(s->>'opening_date', '')::date, '1900-01-01'::date);

  v_cash := coalesce((s->>'opening_cash')::numeric, 0) + coalesce((SELECT sum(amt) FROM app.cash_flows(v_open_date) WHERE d < p_from AND mode = 'CASH'), 0);
  v_bank := coalesce((s->>'opening_bank')::numeric, 0) + coalesce((SELECT sum(amt) FROM app.cash_flows(v_open_date) WHERE d < p_from AND mode <> 'CASH'), 0);
  RETURN jsonb_build_object(
    'opening', jsonb_build_object('cash', v_cash, 'bank', v_bank),
    'in', jsonb_build_object('cash', coalesce((SELECT sum(amt) FROM app.cash_flows(v_open_date) WHERE d BETWEEN p_from AND p_to AND amt > 0 AND mode = 'CASH'), 0),
                             'bank', coalesce((SELECT sum(amt) FROM app.cash_flows(v_open_date) WHERE d BETWEEN p_from AND p_to AND amt > 0 AND mode <> 'CASH'), 0)),
    'out', jsonb_build_object('cash', coalesce((SELECT -sum(amt) FROM app.cash_flows(v_open_date) WHERE d BETWEEN p_from AND p_to AND amt < 0 AND mode = 'CASH'), 0),
                              'bank', coalesce((SELECT -sum(amt) FROM app.cash_flows(v_open_date) WHERE d BETWEEN p_from AND p_to AND amt < 0 AND mode <> 'CASH'), 0)),
    'closing', jsonb_build_object('cash', v_cash + coalesce((SELECT sum(amt) FROM app.cash_flows(v_open_date) WHERE d BETWEEN p_from AND p_to AND mode = 'CASH'), 0),
                                  'bank', v_bank + coalesce((SELECT sum(amt) FROM app.cash_flows(v_open_date) WHERE d BETWEEN p_from AND p_to AND mode <> 'CASH'), 0)),
    'entries', (SELECT coalesce(jsonb_agg(jsonb_build_object('date', d, 'kind', kind, 'party', party, 'ref', ref, 'mode', mode, 'amount', amt)
                  ORDER BY d, at), '[]') FROM app.cash_flows(v_open_date) WHERE d BETWEEN p_from AND p_to),
    'opening_set', s ? 'opening_date' AND s->>'opening_date' IS NOT NULL);
END$$;

CREATE FUNCTION app.gst_lines(p_from date, p_to date, p_wh uuid) RETURNS TABLE(dispatch_id uuid, invoice_no text, invoice_date date, warehouse_id uuid,
  customer_name text, gstin text, pos char(2), inter boolean, invoice_value numeric, hsn text, item text, qty numeric, rate numeric, taxable numeric, tax numeric,
  sign int, note_no text, note_date date)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, fin, extensions, pg_temp AS $$
    SELECT d.id, d.invoice_no, d.invoice_date, d.warehouse_id, d.customer_name, d.customer_gstin, d.place_of_supply, d.is_interstate,
           d.grand_total, coalesce(di.hsn_code, '0000'), p.name, di.qty_base, di.gst_rate, di.line_taxable, di.line_tax, 1, NULL, NULL
      FROM dispatches d JOIN dispatch_items di ON di.dispatch_id = d.id JOIN products p ON p.id = di.product_id
     WHERE d.status = 'POSTED' AND d.invoice_date BETWEEN p_from AND p_to AND (p_wh IS NULL OR d.warehouse_id = p_wh)
    UNION ALL
    SELECT d.id, d.invoice_no, d.invoice_date, r.warehouse_id, c.name, c.gstin, d.place_of_supply, d.is_interstate,
           r.total, coalesce(di.hsn_code, p.hsn_code, '0000'), p.name, i.qty_base, i.gst_rate, i.taxable, i.tax, -1, r.return_no, r.return_date
      FROM sales_returns r JOIN sales_return_items i ON i.return_id = r.id LEFT JOIN dispatch_items di ON di.id = i.dispatch_item_id
      JOIN dispatches d ON d.id = r.dispatch_id JOIN customers c ON c.id = r.customer_id JOIN products p ON p.id = i.product_id
     WHERE r.status = 'POSTED' AND r.return_date BETWEEN p_from AND p_to AND (p_wh IS NULL OR r.warehouse_id = p_wh)
$$;

CREATE OR REPLACE FUNCTION public.owner_gst_report(p_month date, p_warehouse uuid DEFAULT NULL) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, fin, extensions, pg_temp AS $$
DECLARE v_from date := date_trunc('month', p_month)::date; v_to date := (date_trunc('month', p_month) + interval '1 month - 1 day')::date;
BEGIN
  PERFORM app.require_owner();
  RETURN jsonb_build_object(
    'period', jsonb_build_object('from', v_from, 'to', v_to, 'fp', to_char(v_from, 'MMYYYY')),
    'gstins', (SELECT coalesce(jsonb_agg(DISTINCT jsonb_build_object('gstin', gstin, 'warehouse', code, 'state_code', state_code)), '[]')
                 FROM warehouses WHERE p_warehouse IS NULL OR id = p_warehouse),
    'b2b', (SELECT coalesce(jsonb_agg(x ORDER BY x->>'invoice_date', x->>'invoice_no'), '[]') FROM (
              SELECT jsonb_build_object('gstin', gstin, 'customer', customer_name, 'invoice_no', invoice_no, 'invoice_date', invoice_date,
                       'value', max(invoice_value), 'pos', pos, 'inter', inter,
                       'rates', jsonb_agg(jsonb_build_object('rate', rate, 'taxable', tx, 'tax', tax) ORDER BY rate)) AS x
                FROM (SELECT gstin, customer_name, invoice_no, invoice_date, invoice_value, pos, inter, rate, sum(taxable) tx, sum(tax) tax
                        FROM app.gst_lines(v_from, v_to, p_warehouse) WHERE sign = 1 AND gstin IS NOT NULL AND rate > 0 GROUP BY 1,2,3,4,5,6,7,8) g
               GROUP BY gstin, customer_name, invoice_no, invoice_date, pos, inter) s),
    'b2cl', (SELECT coalesce(jsonb_agg(x ORDER BY x->>'invoice_date'), '[]') FROM (
              SELECT jsonb_build_object('invoice_no', invoice_no, 'invoice_date', invoice_date, 'value', max(invoice_value), 'pos', pos,
                       'rates', jsonb_agg(jsonb_build_object('rate', rate, 'taxable', tx, 'tax', tax) ORDER BY rate)) AS x
                FROM (SELECT invoice_no, invoice_date, invoice_value, pos, rate, sum(taxable) tx, sum(tax) tax
                        FROM app.gst_lines(v_from, v_to, p_warehouse) WHERE sign = 1 AND gstin IS NULL AND inter AND invoice_value > 100000 AND rate > 0 GROUP BY 1,2,3,4,5) g
               GROUP BY invoice_no, invoice_date, pos) s),
    'b2cs', (SELECT coalesce(jsonb_agg(jsonb_build_object('pos', pos, 'inter', inter, 'rate', rate, 'taxable', tx, 'tax', tax) ORDER BY pos, rate), '[]')
               FROM (SELECT pos, inter, rate, sum(sign * taxable) tx, sum(sign * tax) tax FROM app.gst_lines(v_from, v_to, p_warehouse)
                      WHERE gstin IS NULL AND rate > 0 AND NOT (sign = 1 AND inter AND invoice_value > 100000)
                      GROUP BY 1,2,3 HAVING sum(sign * taxable) <> 0) s),
    'cdnr', (SELECT coalesce(jsonb_agg(x ORDER BY x->>'note_date'), '[]') FROM (
              SELECT jsonb_build_object('gstin', gstin, 'customer', customer_name, 'note_no', note_no, 'note_date', note_date,
                       'invoice_no', invoice_no, 'invoice_date', invoice_date, 'value', max(invoice_value), 'pos', pos, 'inter', inter,
                       'rates', jsonb_agg(jsonb_build_object('rate', rate, 'taxable', tx, 'tax', tax) ORDER BY rate)) AS x
                FROM (SELECT gstin, customer_name, note_no, note_date, invoice_no, invoice_date, invoice_value, pos, inter, rate, sum(taxable) tx, sum(tax) tax
                        FROM app.gst_lines(v_from, v_to, p_warehouse) WHERE sign = -1 AND gstin IS NOT NULL GROUP BY 1,2,3,4,5,6,7,8,9,10) g
               GROUP BY gstin, customer_name, note_no, note_date, invoice_no, invoice_date, pos, inter) s),
    'nil', (SELECT jsonb_build_object(
               'intra_b2b', coalesce(sum(sign * taxable) FILTER (WHERE NOT inter AND gstin IS NOT NULL), 0),
               'intra_b2c', coalesce(sum(sign * taxable) FILTER (WHERE NOT inter AND gstin IS NULL), 0),
               'inter_b2b', coalesce(sum(sign * taxable) FILTER (WHERE inter AND gstin IS NOT NULL), 0),
               'inter_b2c', coalesce(sum(sign * taxable) FILTER (WHERE inter AND gstin IS NULL), 0)) FROM app.gst_lines(v_from, v_to, p_warehouse) WHERE rate = 0),
    'hsn', (SELECT coalesce(jsonb_agg(jsonb_build_object('b2b', b2b, 'hsn', hsn, 'description', item, 'rate', rate, 'qty', qty, 'value', tx + tax,
                       'taxable', tx, 'igst', CASE WHEN inter THEN tax ELSE 0 END,
                       'cgst', CASE WHEN inter THEN 0 ELSE round(tax / 2, 2) END,
                       'sgst', CASE WHEN inter THEN 0 ELSE tax - round(tax / 2, 2) END) ORDER BY b2b DESC, hsn, rate), '[]')
              FROM (SELECT gstin IS NOT NULL AS b2b, hsn, min(item) item, rate, inter, sum(sign * qty) qty, sum(sign * taxable) tx, sum(sign * tax) tax
                      FROM app.gst_lines(v_from, v_to, p_warehouse) GROUP BY 1, 2, 4, 5) h),
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
                     'sgst', coalesce(sum(sign * tax - round(sign * tax / 2, 2)) FILTER (WHERE NOT inter), 0)) FROM app.gst_lines(v_from, v_to, p_warehouse) WHERE rate > 0),
       'nil_exempt', (SELECT coalesce(sum(sign * taxable), 0) FROM app.gst_lines(v_from, v_to, p_warehouse) WHERE rate = 0),
       'inter_unregistered', (SELECT coalesce(jsonb_agg(jsonb_build_object('pos', pos, 'taxable', tx, 'igst', tax) ORDER BY pos), '[]')
                                FROM (SELECT pos, sum(sign * taxable) tx, sum(sign * tax) tax FROM app.gst_lines(v_from, v_to, p_warehouse) WHERE inter AND gstin IS NULL AND rate > 0 GROUP BY 1) s),
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

CREATE OR REPLACE FUNCTION public.owner_bulk_price(p jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, extensions, pg_temp AS $$
DECLARE v_pct numeric := nullif(p->>'pct', '')::numeric; v_round numeric := coalesce(nullif(p->>'roundTo', '')::numeric, 1);
        v_preview boolean := coalesce((p->>'preview')::boolean, false); n int; v_sample jsonb;
BEGIN
  PERFORM app.require_full_owner();
  IF v_pct IS NULL OR v_pct = 0 OR v_pct < -90 OR v_pct > 300 THEN RAISE EXCEPTION 'Change must be between -90%% and +300%%' USING ERRCODE = 'WH005'; END IF;
  IF v_round NOT IN (0.01, 1, 5, 10) THEN RAISE EXCEPTION 'Round to 0.01, 1, 5 or 10' USING ERRCODE = 'WH005'; END IF;
  WITH RECURSIVE cats AS (SELECT id FROM categories WHERE id = nullif(p->>'categoryId', '')::uuid
                          UNION ALL SELECT c.id FROM categories c JOIN cats ON c.parent_id = cats.id),
  pick AS (SELECT pr.id, pr.sku_code, pr.name, pr.default_selling_price AS old,
                  greatest(0, round(pr.default_selling_price * (1 + v_pct / 100) / v_round) * v_round) AS new
             FROM products pr
            WHERE pr.is_active AND pr.default_selling_price IS NOT NULL
              AND (nullif(p->>'brandId', '') IS NULL OR pr.brand_id = (p->>'brandId')::uuid)
              AND (nullif(p->>'categoryId', '') IS NULL OR pr.category_id IN (SELECT id FROM cats))),
  upd AS (UPDATE products pr SET default_selling_price = pick.new, updated_at = now() FROM pick
           WHERE pr.id = pick.id AND NOT v_preview RETURNING pr.id)
  SELECT (SELECT count(*) FROM pick),
         (SELECT coalesce(jsonb_agg(jsonb_build_object('sku_code', s.sku_code, 'name', s.name, 'old', s.old, 'new', s.new)), '[]')
            FROM (SELECT * FROM pick LIMIT 5) s)
    INTO n, v_sample;
  IF NOT v_preview THEN
    INSERT INTO audit_log(table_name, row_id, action, actor_id, old_data, new_data)
    VALUES ('public.products', 'bulk', 'BULK_PRICE', app.current_user_id(), NULL, p || jsonb_build_object('items', n));
  END IF;
  RETURN jsonb_build_object('items', n, 'sample', v_sample, 'applied', NOT v_preview);
END$$;

REVOKE EXECUTE ON FUNCTION app.cash_flows(date), app.gst_lines(date, date, uuid) FROM PUBLIC, anon, authenticated;

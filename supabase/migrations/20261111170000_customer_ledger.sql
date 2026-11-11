-- =============================================================================
-- customer_ledger — sales ledger with payments
--   * Anyone signed in (owner or staff) records a customer payment: date, mode,
--     amount. The person who records it is "received by".
--   * Balances: bills (sales invoices) minus payments. Payments settle the
--     oldest bills first (FIFO), which tells us each bill's unpaid amount, how
--     old it is (late = more than 30 days) and who is responsible for
--     collecting it (the employee who entered the bill).
--   * Owner: full ledger, monthly/yearly sales vs collections, late payers.
--   * Staff: every customer's pending balance & last bill, their own bills and
--     how much of them is still unpaid.
-- =============================================================================

ALTER TABLE fin.customer_payments DROP CONSTRAINT IF EXISTS customer_payments_mode_check;
ALTER TABLE fin.customer_payments ADD CONSTRAINT customer_payments_mode_check
  CHECK (mode IN ('CASH', 'UPI', 'NEFT', 'RTGS', 'IMPS', 'CHEQUE', 'CARD', 'CREDIT_NOTE', 'OTHER'));
ALTER TABLE fin.customer_payments ADD COLUMN warehouse_id uuid REFERENCES warehouses(id);
CREATE TRIGGER audit_customer_payments AFTER INSERT OR UPDATE OR DELETE ON fin.customer_payments
  FOR EACH ROW EXECUTE FUNCTION app.audit_row();

-- Every posted bill with its unpaid part (payments applied oldest bill first).
CREATE FUNCTION fin.bill_status(p_customer uuid DEFAULT NULL)
RETURNS TABLE (dispatch_id uuid, customer_id uuid, customer_name text, invoice_no text, invoice_date date, warehouse_id uuid,
               total numeric, outstanding numeric, days_old int, entered_by uuid)
LANGUAGE sql STABLE SET search_path = public, fin, extensions, pg_temp AS $$
  WITH bills AS (
    SELECT d.id, d.customer_id, d.customer_name, d.invoice_no, d.invoice_date, d.warehouse_id, d.grand_total, d.created_by,
           sum(d.grand_total) OVER (PARTITION BY d.customer_id ORDER BY d.invoice_date, d.created_at, d.id ROWS UNBOUNDED PRECEDING) AS cum
      FROM dispatches d
     WHERE d.status = 'POSTED' AND (p_customer IS NULL OR d.customer_id = p_customer)),
  paid AS (SELECT cp.customer_id, sum(cp.amount) AS amt FROM fin.customer_payments cp
            WHERE p_customer IS NULL OR cp.customer_id = p_customer GROUP BY cp.customer_id)
  SELECT b.id, b.customer_id, b.customer_name, b.invoice_no, b.invoice_date, b.warehouse_id, b.grand_total,
         greatest(0, least(b.grand_total, b.cum - coalesce(p.amt, 0))),
         (app.today_ist() - b.invoice_date)::int, b.created_by
    FROM bills b LEFT JOIN paid p ON p.customer_id = b.customer_id
$$;
REVOKE EXECUTE ON FUNCTION fin.bill_status(uuid) FROM PUBLIC, anon, authenticated;

-- Per-customer totals.
CREATE FUNCTION fin.customer_balances() RETURNS TABLE (customer_id uuid, billed numeric, paid numeric, balance numeric,
  overdue numeric, oldest_overdue_days int, last_bill_date date, last_payment_date date)
LANGUAGE sql STABLE SET search_path = public, fin, extensions, pg_temp AS $$
  WITH b AS (SELECT customer_id, sum(total) AS billed, sum(outstanding) FILTER (WHERE days_old > 30) AS overdue,
                    max(days_old) FILTER (WHERE outstanding > 0 AND days_old > 30) AS oldest, max(invoice_date) AS last_bill
               FROM fin.bill_status() GROUP BY customer_id),
       p AS (SELECT customer_id, sum(amount) AS paid, max(paid_on) AS last_pay FROM fin.customer_payments GROUP BY customer_id)
  SELECT coalesce(b.customer_id, p.customer_id), coalesce(b.billed, 0), coalesce(p.paid, 0),
         coalesce(b.billed, 0) - coalesce(p.paid, 0), coalesce(b.overdue, 0), b.oldest, b.last_bill, p.last_pay
    FROM b FULL JOIN p ON p.customer_id = b.customer_id
$$;
REVOKE EXECUTE ON FUNCTION fin.customer_balances() FROM PUBLIC, anon, authenticated;

-- ---------------------------------------------------------------- record a payment (all staff)
/* p = { customerId, amount, paidOn?, mode, reference?, notes? } */
CREATE FUNCTION public.record_customer_payment(p jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, fin, extensions, pg_temp AS $$
DECLARE v_uid uuid := app.require_user(); v_date date := coalesce(nullif(p->>'paidOn', '')::date, app.today_ist());
        v_cust uuid := (p->>'customerId')::uuid; v_amt numeric := (p->>'amount')::numeric;
BEGIN
  IF v_cust IS NULL OR NOT EXISTS (SELECT 1 FROM customers WHERE id = v_cust) THEN
    RAISE EXCEPTION 'Choose the customer' USING ERRCODE = 'WH005';
  END IF;
  IF v_amt IS NULL OR v_amt <= 0 THEN RAISE EXCEPTION 'Enter the amount received' USING ERRCODE = 'WH005'; END IF;
  IF v_date > app.today_ist() THEN RAISE EXCEPTION 'Payment date cannot be in the future' USING ERRCODE = 'WH005'; END IF;
  IF v_date < app.today_ist() - 365 THEN RAISE EXCEPTION 'Payment date is more than a year ago' USING ERRCODE = 'WH005'; END IF;
  INSERT INTO fin.customer_payments(customer_id, amount, paid_on, mode, reference, notes, entered_by, warehouse_id)
  VALUES (v_cust, round(v_amt, 2), v_date, upper(coalesce(nullif(p->>'mode', ''), 'CASH')), nullif(trim(p->>'reference'), ''),
          nullif(trim(p->>'notes'), ''), v_uid, app.current_warehouse_id());
  RETURN (SELECT jsonb_build_object('balance', balance, 'overdue', overdue) FROM fin.customer_balances() WHERE customer_id = v_cust);
END$$;

CREATE FUNCTION public.owner_delete_payment(p_id uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, fin, extensions, pg_temp AS $$
BEGIN
  PERFORM app.require_owner();
  DELETE FROM fin.customer_payments WHERE id = p_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Payment not found' USING ERRCODE = 'WH005'; END IF;
END$$;

-- ---------------------------------------------------------------- statement (all signed-in users)
CREATE FUNCTION public.customer_statement(p_customer uuid) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, fin, extensions, pg_temp AS $$
BEGIN
  PERFORM app.require_user();
  RETURN (SELECT jsonb_build_object(
    'customer', (SELECT jsonb_build_object('id', c.id, 'name', c.name, 'gstin', c.gstin, 'phone', c.phone) FROM customers c WHERE c.id = p_customer),
    'totals', (SELECT to_jsonb(cb) FROM fin.customer_balances() cb WHERE cb.customer_id = p_customer),
    'entries', coalesce((SELECT jsonb_agg(e ORDER BY e->>'date', e->>'at') FROM (
        SELECT jsonb_build_object('kind', 'BILL', 'id', s.dispatch_id, 'date', s.invoice_date, 'at', d.created_at, 'ref', s.invoice_no,
                                  'debit', s.total, 'credit', 0, 'outstanding', s.outstanding, 'days_old', s.days_old,
                                  'by', u.full_name, 'warehouse', w.name) AS e
          FROM fin.bill_status(p_customer) s JOIN dispatches d ON d.id = s.dispatch_id
          JOIN users u ON u.id = s.entered_by JOIN warehouses w ON w.id = s.warehouse_id
        UNION ALL
        SELECT jsonb_build_object('kind', 'PAYMENT', 'id', cp.id, 'date', cp.paid_on, 'at', cp.created_at,
                                  'ref', cp.mode || coalesce(' · ' || cp.reference, ''), 'debit', 0, 'credit', cp.amount,
                                  'notes', cp.notes, 'by', u.full_name)
          FROM fin.customer_payments cp JOIN users u ON u.id = cp.entered_by WHERE cp.customer_id = p_customer) x), '[]')));
END$$;

-- ---------------------------------------------------------------- owner ledger
CREATE FUNCTION public.owner_ledger() RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, fin, extensions, pg_temp AS $$
DECLARE v_today date := app.today_ist();
BEGIN
  PERFORM app.require_owner();
  RETURN jsonb_build_object(
    'customers', coalesce((SELECT jsonb_agg(jsonb_build_object(
        'customer_id', c.id, 'name', c.name, 'gstin', c.gstin, 'phone', c.phone,
        'billed', cb.billed, 'paid', cb.paid, 'balance', cb.balance, 'overdue', cb.overdue, 'oldest_overdue_days', cb.oldest_overdue_days,
        'last_bill_date', cb.last_bill_date, 'last_payment_date', cb.last_payment_date,
        'responsible', (SELECT coalesce(jsonb_agg(jsonb_build_object('name', u.full_name, 'outstanding', r.amt) ORDER BY r.amt DESC), '[]')
                          FROM (SELECT entered_by, sum(outstanding) AS amt FROM fin.bill_status(c.id) WHERE outstanding > 0 GROUP BY entered_by) r
                          JOIN users u ON u.id = r.entered_by))
        ORDER BY cb.overdue DESC, cb.balance DESC, c.name)
      FROM fin.customer_balances() cb JOIN customers c ON c.id = cb.customer_id), '[]'),
    'late', coalesce((SELECT jsonb_agg(jsonb_build_object('dispatch_id', s.dispatch_id, 'customer_id', s.customer_id, 'customer_name', s.customer_name,
        'phone', c.phone, 'invoice_no', s.invoice_no, 'invoice_date', s.invoice_date, 'days_old', s.days_old, 'total', s.total,
        'outstanding', s.outstanding, 'responsible', u.full_name) ORDER BY s.days_old DESC)
      FROM fin.bill_status() s JOIN users u ON u.id = s.entered_by JOIN customers c ON c.id = s.customer_id
      WHERE s.outstanding > 0 AND s.days_old > 30), '[]'),
    'monthly', (SELECT jsonb_agg(jsonb_build_object('month', m.m,
        'sales', (SELECT coalesce(sum(grand_total), 0) FROM dispatches WHERE status = 'POSTED' AND invoice_date >= m.m AND invoice_date < m.m + interval '1 month'),
        'collected', (SELECT coalesce(sum(amount), 0) FROM fin.customer_payments WHERE paid_on >= m.m AND paid_on < m.m + interval '1 month')) ORDER BY m.m)
      FROM (SELECT (date_trunc('month', v_today) - make_interval(months => g))::date AS m FROM generate_series(0, 11) g) m),
    'yearly', (SELECT jsonb_agg(jsonb_build_object('fy', app.fy_label(y.start), 'start', y.start,
        'sales', (SELECT coalesce(sum(grand_total), 0) FROM dispatches WHERE status = 'POSTED' AND invoice_date >= y.start AND invoice_date < y.start + interval '1 year'),
        'collected', (SELECT coalesce(sum(amount), 0) FROM fin.customer_payments WHERE paid_on >= y.start AND paid_on < y.start + interval '1 year')) ORDER BY y.start)
      FROM (SELECT (make_date(extract(year FROM v_today)::int - CASE WHEN extract(month FROM v_today) < 4 THEN 1 ELSE 0 END, 4, 1)
                    - make_interval(years => g))::date AS start FROM generate_series(0, 4) g) y),
    'by_employee', coalesce((SELECT jsonb_agg(jsonb_build_object('user_id', u.id, 'name', u.full_name,
        'bills', (SELECT count(*) FROM dispatches d WHERE d.created_by = u.id AND d.status = 'POSTED'),
        'outstanding', (SELECT coalesce(sum(outstanding), 0) FROM fin.bill_status() s WHERE s.entered_by = u.id),
        'overdue', (SELECT coalesce(sum(outstanding), 0) FROM fin.bill_status() s WHERE s.entered_by = u.id AND s.days_old > 30),
        'collected_this_month', (SELECT coalesce(sum(amount), 0) FROM fin.customer_payments cp WHERE cp.entered_by = u.id AND cp.paid_on >= date_trunc('month', v_today)))
        ORDER BY u.full_name)
      FROM users u WHERE u.removed_at IS NULL AND (EXISTS (SELECT 1 FROM dispatches d WHERE d.created_by = u.id)
                                                   OR EXISTS (SELECT 1 FROM fin.customer_payments cp WHERE cp.entered_by = u.id))), '[]'),
    'payments', coalesce((SELECT jsonb_agg(jsonb_build_object('id', cp.id, 'customer_id', cp.customer_id, 'customer_name', c.name, 'amount', cp.amount,
        'paid_on', cp.paid_on, 'mode', cp.mode, 'reference', cp.reference, 'notes', cp.notes, 'received_by', u.full_name, 'entered_at', cp.created_at)
        ORDER BY cp.paid_on DESC, cp.created_at DESC)
      FROM (SELECT * FROM fin.customer_payments ORDER BY paid_on DESC, created_at DESC LIMIT 200) cp
      JOIN customers c ON c.id = cp.customer_id JOIN users u ON u.id = cp.entered_by), '[]'));
END$$;

-- ---------------------------------------------------------------- staff ledger
CREATE FUNCTION public.my_ledger() RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, fin, extensions, pg_temp AS $$
DECLARE v_uid uuid := app.require_user();
BEGIN
  RETURN jsonb_build_object(
    'customers', coalesce((SELECT jsonb_agg(jsonb_build_object(
        'customer_id', c.id, 'name', c.name, 'phone', c.phone, 'balance', cb.balance, 'overdue', cb.overdue,
        'last_bill_date', cb.last_bill_date, 'last_payment_date', cb.last_payment_date,
        'last_bill_by', (SELECT u.full_name FROM dispatches d JOIN users u ON u.id = d.created_by
                          WHERE d.customer_id = c.id AND d.status = 'POSTED' ORDER BY d.invoice_date DESC, d.created_at DESC LIMIT 1),
        'mine_outstanding', (SELECT coalesce(sum(outstanding), 0) FROM fin.bill_status(c.id) s WHERE s.entered_by = v_uid))
        ORDER BY cb.balance DESC, c.name)
      FROM fin.customer_balances() cb JOIN customers c ON c.id = cb.customer_id WHERE cb.balance <> 0 OR cb.last_bill_date >= app.today_ist() - 90), '[]'),
    'my_bills', coalesce((SELECT jsonb_agg(jsonb_build_object('dispatch_id', s.dispatch_id, 'customer_id', s.customer_id, 'customer_name', s.customer_name,
        'invoice_no', s.invoice_no, 'invoice_date', s.invoice_date, 'total', s.total, 'outstanding', s.outstanding, 'days_old', s.days_old)
        ORDER BY s.invoice_date DESC)
      FROM fin.bill_status() s WHERE s.entered_by = v_uid AND (s.outstanding > 0 OR s.invoice_date >= app.today_ist() - 60)), '[]'),
    'my_payments', coalesce((SELECT jsonb_agg(jsonb_build_object('id', cp.id, 'customer_name', c.name, 'amount', cp.amount, 'paid_on', cp.paid_on,
        'mode', cp.mode, 'reference', cp.reference) ORDER BY cp.paid_on DESC, cp.created_at DESC)
      FROM fin.customer_payments cp JOIN customers c ON c.id = cp.customer_id
      WHERE cp.entered_by = v_uid AND cp.paid_on >= app.today_ist() - 60), '[]'));
END$$;

REVOKE EXECUTE ON FUNCTION public.record_customer_payment(jsonb), public.owner_delete_payment(uuid), public.customer_statement(uuid),
  public.owner_ledger(), public.my_ledger() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.record_customer_payment(jsonb), public.owner_delete_payment(uuid), public.customer_statement(uuid),
  public.owner_ledger(), public.my_ledger() TO authenticated;

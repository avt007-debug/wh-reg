-- Monthly sales targets (set by the owner per employee) + the employee's own dashboard.
-- "Achieved" = the employee's posted sales bills in that month, before GST (same basis as the
-- Employees page), so owner and employee always see the same number.

CREATE TABLE sales_targets (
  user_id       uuid NOT NULL REFERENCES users(id),
  month         date NOT NULL CHECK (extract(day FROM month) = 1),
  target_amount numeric(14,2) NOT NULL CHECK (target_amount > 0),
  note          text,
  set_by        uuid REFERENCES users(id),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, month)
);
ALTER TABLE sales_targets ENABLE ROW LEVEL SECURITY;           -- RPC access only
REVOKE ALL ON sales_targets FROM PUBLIC, anon, authenticated;
CREATE TRIGGER audit_sales_targets AFTER INSERT OR UPDATE OR DELETE ON sales_targets FOR EACH ROW EXECUTE FUNCTION app.audit_row();

CREATE FUNCTION app.month_sales(p_user uuid, p_from date, p_to date) RETURNS numeric
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, extensions, pg_temp AS $$
  SELECT coalesce(sum(taxable_total), 0) FROM dispatches
   WHERE created_by = p_user AND status = 'POSTED' AND invoice_date BETWEEN p_from AND p_to
$$;

-- Owner sets (or clears with NULL / 0) one employee's target for a month.
CREATE FUNCTION public.owner_set_sales_target(p_user uuid, p_month date, p_target numeric, p_note text DEFAULT NULL) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, extensions, pg_temp AS $$
DECLARE v_m date := date_trunc('month', coalesce(p_month, app.today_ist()))::date;
BEGIN
  PERFORM app.require_owner();
  IF NOT EXISTS (SELECT 1 FROM users WHERE id = p_user AND role <> 'OWNER') THEN
    RAISE EXCEPTION 'Employee not found' USING ERRCODE = 'WH005';
  END IF;
  IF p_target IS NULL OR p_target <= 0 THEN
    DELETE FROM sales_targets WHERE user_id = p_user AND month = v_m;
    RETURN jsonb_build_object('user_id', p_user, 'month', v_m, 'target', NULL);
  END IF;
  INSERT INTO sales_targets(user_id, month, target_amount, note, set_by)
  VALUES (p_user, v_m, round(p_target, 2), nullif(trim(p_note), ''), app.current_user_id())
  ON CONFLICT (user_id, month) DO UPDATE
    SET target_amount = EXCLUDED.target_amount, note = EXCLUDED.note, set_by = EXCLUDED.set_by, updated_at = now();
  RETURN jsonb_build_object('user_id', p_user, 'month', v_m, 'target', round(p_target, 2));
END$$;

-- Owner: every employee's target vs achieved for a month.
CREATE FUNCTION public.owner_sales_targets(p_month date) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, extensions, pg_temp AS $$
DECLARE v_from date := date_trunc('month', p_month)::date; v_to date := (date_trunc('month', p_month) + interval '1 month - 1 day')::date;
BEGIN
  PERFORM app.require_owner();
  RETURN (SELECT coalesce(jsonb_agg(jsonb_build_object(
            'user_id', u.id, 'full_name', u.full_name, 'login_id', u.login_id, 'warehouse_name', w.name,
            'target', t.target_amount, 'note', t.note,
            'last_month_target', (SELECT target_amount FROM sales_targets WHERE user_id = u.id AND month = (v_from - interval '1 month')::date),
            'achieved', app.month_sales(u.id, v_from, v_to))
            ORDER BY u.full_name), '[]')
            FROM users u LEFT JOIN warehouses w ON w.id = u.primary_warehouse_id
            LEFT JOIN sales_targets t ON t.user_id = u.id AND t.month = v_from
           WHERE u.role <> 'OWNER' AND u.removed_at IS NULL);
END$$;

-- Employee's own dashboard for a month (default: this month).
CREATE FUNCTION public.my_dashboard(p_month date DEFAULT NULL) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, fin, extensions, pg_temp AS $$
DECLARE
  v_uid uuid := app.require_user();
  v_today date := app.today_ist();
  v_from date := date_trunc('month', coalesce(p_month, v_today))::date;
  v_to date := (date_trunc('month', coalesce(p_month, v_today)) + interval '1 month - 1 day')::date;
  v_last date := least(v_to, v_today);
BEGIN
  RETURN jsonb_build_object(
    'me', (SELECT jsonb_build_object('full_name', u.full_name, 'login_id', u.login_id, 'warehouse_name', w.name)
             FROM users u LEFT JOIN warehouses w ON w.id = u.primary_warehouse_id WHERE u.id = v_uid),
    'month', v_from, 'today', v_today,
    'open_shift', (SELECT to_jsonb(a) FROM attendance a WHERE a.user_id = v_uid AND a.clock_out_at IS NULL),
    'today_shifts', app.attendance_rows(v_uid, v_today, v_today),
    -- one row per calendar day of the month up to today, including days with no clock-in
    'days', (SELECT coalesce(jsonb_agg(jsonb_build_object(
               'date', d.d, 'first_in', x.first_in, 'last_out', x.last_out, 'shifts', coalesce(x.shifts, 0),
               'open', coalesce(x.open, false), 'hours', coalesce(x.hours, 0)) ORDER BY d.d DESC), '[]')
               FROM generate_series(v_from, v_last, interval '1 day') AS d(d)
               LEFT JOIN LATERAL (
                 SELECT min(a.clock_in_at) AS first_in,
                        CASE WHEN bool_or(a.clock_out_at IS NULL) THEN NULL ELSE max(a.clock_out_at) END AS last_out,
                        count(*) AS shifts, bool_or(a.clock_out_at IS NULL) AS open,
                        round(sum(extract(epoch FROM (coalesce(a.clock_out_at, CASE WHEN a.work_date = v_today THEN now() END) - a.clock_in_at))) / 3600.0, 2) AS hours
                   FROM attendance a WHERE a.user_id = v_uid AND a.work_date = d.d::date) x ON true
              WHERE v_from <= v_today),
    'stats', app.employee_month_stats(v_uid, v_from, v_to),
    'target', (SELECT target_amount FROM sales_targets WHERE user_id = v_uid AND month = v_from),
    'target_note', (SELECT note FROM sales_targets WHERE user_id = v_uid AND month = v_from),
    'achieved', app.month_sales(v_uid, v_from, v_to),
    'days_left', greatest(0, v_to - v_today + CASE WHEN v_today BETWEEN v_from AND v_to THEN 1 ELSE 0 END),
    'sales_today', app.month_sales(v_uid, v_today, v_today),
    'bills_today', (SELECT count(*) FROM dispatches WHERE created_by = v_uid AND status = 'POSTED' AND invoice_date = v_today),
    'sales_by_day', (SELECT coalesce(jsonb_agg(jsonb_build_object('date', invoice_date, 'sales', s) ORDER BY invoice_date), '[]')
                       FROM (SELECT invoice_date, sum(taxable_total) AS s FROM dispatches
                              WHERE created_by = v_uid AND status = 'POSTED' AND invoice_date BETWEEN v_from AND v_to
                              GROUP BY invoice_date) z),
    'collected_month', (SELECT coalesce(sum(amount), 0) FROM fin.customer_payments
                         WHERE entered_by = v_uid AND paid_on BETWEEN v_from AND v_to),
    'to_collect', (SELECT coalesce(sum(outstanding), 0) FROM fin.bill_status() WHERE entered_by = v_uid AND outstanding > 0),
    'overdue', (SELECT coalesce(sum(outstanding), 0) FROM fin.bill_status() WHERE entered_by = v_uid AND outstanding > 0 AND days_old > 30),
    'recent_bills', (SELECT coalesce(jsonb_agg(jsonb_build_object('invoice_no', invoice_no, 'invoice_date', invoice_date,
                       'customer_name', customer_name, 'taxable', taxable_total, 'total', grand_total) ORDER BY invoice_date DESC, created_at DESC), '[]')
                       FROM (SELECT * FROM dispatches WHERE created_by = v_uid AND status = 'POSTED' AND invoice_date BETWEEN v_from AND v_to
                              ORDER BY invoice_date DESC, created_at DESC LIMIT 5) r));
END$$;

-- Employees page (owner) now carries the target too.
CREATE OR REPLACE FUNCTION public.owner_employees_month(p_month date) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, extensions, pg_temp AS $$
DECLARE v_from date := date_trunc('month', p_month)::date; v_to date := (date_trunc('month', p_month) + interval '1 month - 1 day')::date;
BEGIN
  PERFORM app.require_owner();
  RETURN (SELECT coalesce(jsonb_agg(jsonb_build_object(
            'id', u.id, 'login_id', u.login_id, 'full_name', u.full_name, 'role', u.role, 'phone', u.phone,
            'is_active', u.is_active, 'removed_at', u.removed_at, 'warehouse_name', w.name,
            'clocked_in_since', (SELECT clock_in_at FROM attendance a WHERE a.user_id = u.id AND a.clock_out_at IS NULL),
            'target', (SELECT target_amount FROM sales_targets t WHERE t.user_id = u.id AND t.month = v_from),
            'stats', app.employee_month_stats(u.id, v_from, v_to)) ORDER BY u.removed_at NULLS FIRST, u.full_name), '[]')
            FROM users u LEFT JOIN warehouses w ON w.id = u.primary_warehouse_id
           WHERE u.role <> 'OWNER');
END$$;

REVOKE EXECUTE ON FUNCTION app.month_sales(uuid, date, date) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.owner_set_sales_target(uuid, date, numeric, text), public.owner_sales_targets(date),
  public.my_dashboard(date) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.owner_set_sales_target(uuid, date, numeric, text), public.owner_sales_targets(date),
  public.my_dashboard(date) TO authenticated;

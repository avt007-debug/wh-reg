-- Employee add-ins (C):
--   customer history while billing (balance, overdue, credit limit, last prices, repeat last order) ·
--   customer list (call / WhatsApp) · delivery proof (photo, signature, receiver, location) ·
--   market-run / visit location + photo · visit plan · leave requests · clock-in/out correction requests ·
--   staff "my bills" (print / share / mark delivered).

-- ===========================================================================
-- Customer history while billing
-- ===========================================================================
CREATE FUNCTION public.customer_snapshot(p_customer uuid) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, fin, extensions, pg_temp AS $$
DECLARE b record; cc fin.customer_credit;
BEGIN
  PERFORM app.require_user();
  SELECT * INTO b FROM fin.customer_balances() WHERE customer_id = p_customer;
  SELECT * INTO cc FROM fin.customer_credit WHERE customer_id = p_customer;
  RETURN jsonb_build_object(
    'customer', (SELECT jsonb_build_object('id', id, 'name', name, 'gstin', gstin, 'phone', phone, 'address', address, 'notes', notes)
                   FROM customers WHERE id = p_customer),
    'balance', coalesce(b.balance, 0), 'overdue', coalesce(b.overdue, 0), 'oldest_overdue_days', b.oldest_overdue_days,
    'credit_limit', cc.credit_limit, 'credit_days', coalesce(cc.credit_days, 30),
    'over_limit', cc.credit_limit IS NOT NULL AND coalesce(b.balance, 0) > cc.credit_limit,
    'last_bill', (SELECT jsonb_build_object('id', d.id, 'invoice_no', d.invoice_no, 'invoice_date', d.invoice_date, 'total', d.grand_total,
                         'by', u.full_name, 'items', (SELECT count(*) FROM dispatch_items WHERE dispatch_id = d.id))
                    FROM dispatches d JOIN users u ON u.id = d.created_by
                   WHERE d.customer_id = p_customer AND d.status = 'POSTED' ORDER BY d.invoice_date DESC, d.created_at DESC LIMIT 1),
    'last_payment', (SELECT jsonb_build_object('paid_on', paid_on, 'amount', amount, 'mode', mode) FROM fin.customer_payments
                      WHERE customer_id = p_customer AND mode <> 'CREDIT_NOTE' ORDER BY paid_on DESC, created_at DESC LIMIT 1),
    'items', (SELECT coalesce(jsonb_agg(x ORDER BY x->>'date' DESC), '[]') FROM (
                SELECT DISTINCT ON (di.product_id) jsonb_build_object('product_id', di.product_id, 'sku_code', p.sku_code, 'name', p.name,
                         'uom', di.uom_code, 'factor', di.conversion_factor, 'qty', di.qty, 'price', di.unit_base_price,
                         'discount_pct', di.discount_pct, 'gst_rate', di.gst_rate, 'date', d.invoice_date, 'invoice_no', d.invoice_no) AS x
                  FROM dispatch_items di JOIN dispatches d ON d.id = di.dispatch_id JOIN products p ON p.id = di.product_id
                 WHERE d.customer_id = p_customer AND d.status = 'POSTED'
                 ORDER BY di.product_id, d.invoice_date DESC, d.created_at DESC) s LIMIT 60));
END$$;

-- Lines of the customer's last bill, ready to drop into a new bill (with stock at the chosen warehouse).
CREATE FUNCTION public.customer_last_order(p_customer uuid, p_warehouse uuid DEFAULT NULL) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, extensions, pg_temp AS $$
DECLARE v_disp uuid;
BEGIN
  PERFORM app.require_user();
  SELECT id INTO v_disp FROM dispatches WHERE customer_id = p_customer AND status = 'POSTED' ORDER BY invoice_date DESC, created_at DESC LIMIT 1;
  IF v_disp IS NULL THEN RETURN '[]'; END IF;
  RETURN (SELECT coalesce(jsonb_agg(jsonb_build_object('hit', h.x, 'uom', di.uom_code, 'qty', di.qty, 'price', di.unit_base_price,
            'discount_pct', di.discount_pct, 'gst_rate', di.gst_rate, 'hsn_code', di.hsn_code) ORDER BY di.line_no), '[]')
            FROM dispatch_items di JOIN products p ON p.id = di.product_id
            CROSS JOIN LATERAL (SELECT x FROM jsonb_array_elements(public.find_material(p.sku_code, 5, coalesce(p_warehouse, app.current_warehouse_id()))) x
                                 WHERE x->>'id' = di.product_id::text LIMIT 1) h
           WHERE di.dispatch_id = v_disp AND p.is_active);
END$$;

-- Customer list for employees (call / WhatsApp / see what they owe)
CREATE FUNCTION public.staff_customers(p_q text DEFAULT NULL) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, fin, extensions, pg_temp AS $$
DECLARE v_q text := nullif(btrim(coalesce(p_q, '')), '');
BEGIN
  PERFORM app.require_user();
  RETURN (SELECT coalesce(jsonb_agg(x ORDER BY (x->>'balance')::numeric DESC, x->>'name'), '[]') FROM (
    SELECT jsonb_build_object('id', c.id, 'name', c.name, 'gstin', c.gstin, 'phone', c.phone, 'address', c.address, 'is_dealer', c.is_dealer,
             'balance', coalesce(b.balance, 0), 'overdue', coalesce(b.overdue, 0), 'oldest_overdue_days', b.oldest_overdue_days,
             'last_bill_date', b.last_bill_date, 'last_payment_date', b.last_payment_date) AS x
      FROM customers c LEFT JOIN fin.customer_balances() b ON b.customer_id = c.id
     WHERE c.is_active AND (v_q IS NULL OR c.name ILIKE '%' || v_q || '%' OR c.phone LIKE '%' || v_q || '%' OR c.gstin ILIKE v_q || '%'
                            OR c.address ILIKE '%' || v_q || '%')
     LIMIT 400) s);
END$$;

-- ===========================================================================
-- Field photos (private bucket): everyone uploads into their own folder '<user id>/…'; owners read all
-- ===========================================================================
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES ('field-photos', 'field-photos', false, 6291456, ARRAY['image/jpeg', 'image/png', 'image/webp'])
ON CONFLICT (id) DO NOTHING;

CREATE POLICY "staff upload field photos to own folder" ON storage.objects FOR INSERT TO authenticated
  WITH CHECK (bucket_id = 'field-photos' AND (storage.foldername(name))[1] = (SELECT app.current_user_id())::text);
CREATE POLICY "read own or (owner) all field photos" ON storage.objects FOR SELECT TO authenticated
  USING (bucket_id = 'field-photos' AND ((SELECT app.is_owner()) OR (storage.foldername(name))[1] = (SELECT app.current_user_id())::text));

CREATE FUNCTION app.own_photo_path(p_path text) RETURNS text
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, extensions, pg_temp AS $$
BEGIN
  IF p_path IS NULL OR btrim(p_path) = '' THEN RETURN NULL; END IF;
  IF p_path !~ ('^' || app.current_user_id()::text || '/[A-Za-z0-9._-]+$') THEN
    RAISE EXCEPTION 'Photo must be uploaded to your own folder' USING ERRCODE = 'WH005';
  END IF;
  RETURN p_path;
END$$;

-- ===========================================================================
-- Delivery proof
-- ===========================================================================
CREATE TABLE delivery_proofs (
  dispatch_id     uuid PRIMARY KEY REFERENCES dispatches(id) ON DELETE CASCADE,
  receiver_name   text NOT NULL,
  receiver_phone  text,
  photo_path      text,
  signature_path  text,
  lat             numeric(9,6),
  lng             numeric(9,6),
  accuracy_m      int,
  note            text,
  delivered_by    uuid NOT NULL REFERENCES users(id),
  delivered_at    timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE delivery_proofs ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON delivery_proofs FROM PUBLIC, anon, authenticated;

CREATE FUNCTION app.can_touch_bill(p_dispatch uuid) RETURNS void
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, extensions, pg_temp AS $$
DECLARE d dispatches; v_uid uuid := app.require_user();
BEGIN
  SELECT * INTO d FROM dispatches WHERE id = p_dispatch;
  IF NOT FOUND THEN RAISE EXCEPTION 'Bill not found' USING ERRCODE = 'WH005'; END IF;
  IF NOT app.is_owner() AND d.created_by <> v_uid AND d.warehouse_id IS DISTINCT FROM app.current_warehouse_id() THEN
    RAISE EXCEPTION 'Not your bill' USING ERRCODE = 'WH002';
  END IF;
END$$;

-- p = { dispatchId, receiverName, receiverPhone?, photoPath?, signaturePath?, lat?, lng?, accuracy?, note? }
CREATE FUNCTION public.mark_delivered(p jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, extensions, pg_temp AS $$
DECLARE v_id uuid := (p->>'dispatchId')::uuid; v_uid uuid := app.require_user(); d dispatches;
BEGIN
  PERFORM app.can_touch_bill(v_id);
  SELECT * INTO d FROM dispatches WHERE id = v_id;
  IF d.status <> 'POSTED' THEN RAISE EXCEPTION 'This bill is cancelled' USING ERRCODE = 'WH005'; END IF;
  IF length(btrim(coalesce(p->>'receiverName', ''))) < 2 THEN RAISE EXCEPTION 'Who received the goods?' USING ERRCODE = 'WH005'; END IF;
  IF nullif(p->>'photoPath', '') IS NULL AND nullif(p->>'signaturePath', '') IS NULL THEN
    RAISE EXCEPTION 'Add a photo or the receiver''s signature' USING ERRCODE = 'WH005';
  END IF;
  INSERT INTO delivery_proofs(dispatch_id, receiver_name, receiver_phone, photo_path, signature_path, lat, lng, accuracy_m, note, delivered_by)
  VALUES (v_id, btrim(p->>'receiverName'), nullif(right(regexp_replace(coalesce(p->>'receiverPhone', ''), '\D', '', 'g'), 10), ''),
          app.own_photo_path(p->>'photoPath'), app.own_photo_path(p->>'signaturePath'),
          nullif(p->>'lat', '')::numeric, nullif(p->>'lng', '')::numeric, nullif(p->>'accuracy', '')::numeric::int,
          nullif(btrim(coalesce(p->>'note', '')), ''), v_uid)
  ON CONFLICT (dispatch_id) DO UPDATE SET receiver_name = EXCLUDED.receiver_name, receiver_phone = EXCLUDED.receiver_phone,
     photo_path = coalesce(EXCLUDED.photo_path, delivery_proofs.photo_path), signature_path = coalesce(EXCLUDED.signature_path, delivery_proofs.signature_path),
     lat = coalesce(EXCLUDED.lat, delivery_proofs.lat), lng = coalesce(EXCLUDED.lng, delivery_proofs.lng),
     accuracy_m = coalesce(EXCLUDED.accuracy_m, delivery_proofs.accuracy_m), note = EXCLUDED.note,
     delivered_by = EXCLUDED.delivered_by, delivered_at = now();
  RETURN public.delivery_info(v_id);
END$$;

CREATE FUNCTION public.delivery_info(p_dispatch uuid) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, extensions, pg_temp AS $$
BEGIN
  PERFORM app.can_touch_bill(p_dispatch);
  RETURN (SELECT to_jsonb(x) FROM (SELECT dp.*, u.full_name AS delivered_by_name FROM delivery_proofs dp JOIN users u ON u.id = dp.delivered_by
                                    WHERE dp.dispatch_id = p_dispatch) x);
END$$;

-- { dispatch id: "Delivered to … · time" } for the owner's sales page
CREATE FUNCTION public.owner_delivered_ids(p_month date) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, extensions, pg_temp AS $$
BEGIN
  PERFORM app.require_owner();
  RETURN (SELECT coalesce(jsonb_object_agg(dp.dispatch_id, 'Delivered to ' || dp.receiver_name || ' · '
            || to_char(dp.delivered_at AT TIME ZONE 'Asia/Kolkata', 'DD-Mon HH12:MI AM') || ' · by ' || u.full_name), '{}')
            FROM delivery_proofs dp JOIN dispatches d ON d.id = dp.dispatch_id JOIN users u ON u.id = dp.delivered_by
           WHERE d.invoice_date >= date_trunc('month', p_month) AND d.invoice_date < date_trunc('month', p_month) + interval '1 month');
END$$;

-- Employee: recent bills they made or of their warehouse, with delivery status
CREATE FUNCTION public.my_recent_bills(p_days int DEFAULT 7) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, extensions, pg_temp AS $$
DECLARE v_uid uuid := app.require_user();
BEGIN
  RETURN (SELECT coalesce(jsonb_agg(jsonb_build_object('id', d.id, 'invoice_no', d.invoice_no, 'invoice_date', d.invoice_date,
            'customer_name', d.customer_name, 'customer_gstin', d.customer_gstin, 'grand_total', d.grand_total, 'status', d.status,
            'warehouse_code', w.code, 'mine', d.created_by = v_uid, 'by', u.full_name,
            'delivered', dp.dispatch_id IS NOT NULL, 'receiver', dp.receiver_name, 'delivered_at', dp.delivered_at)
            ORDER BY d.invoice_date DESC, d.created_at DESC), '[]')
            FROM dispatches d JOIN warehouses w ON w.id = d.warehouse_id JOIN users u ON u.id = d.created_by
            LEFT JOIN delivery_proofs dp ON dp.dispatch_id = d.id
           WHERE d.invoice_date > app.today_ist() - least(greatest(coalesce(p_days, 7), 1), 60)
             AND (app.is_owner() OR d.created_by = v_uid OR d.warehouse_id = app.current_warehouse_id()));
END$$;

-- ===========================================================================
-- Market runs / visits: location and photo
-- ===========================================================================
ALTER TABLE market_runs ADD COLUMN lat numeric(9,6), ADD COLUMN lng numeric(9,6), ADD COLUMN accuracy_m int, ADD COLUMN photo_path text, ADD COLUMN located_at timestamptz;
ALTER TABLE customer_visits ADD COLUMN lat numeric(9,6), ADD COLUMN lng numeric(9,6), ADD COLUMN accuracy_m int, ADD COLUMN photo_path text;

CREATE OR REPLACE FUNCTION app.visit_json(v customer_visits) RETURNS jsonb
LANGUAGE sql IMMUTABLE SET search_path = public, extensions, pg_temp AS $$
  SELECT jsonb_build_object('id', v.id, 'run_id', v.run_id, 'visit_date', v.visit_date, 'customer_name', v.customer_name,
           'shop_name', v.shop_name, 'phone', v.phone, 'place', v.place, 'outcome', v.outcome, 'notes', v.notes,
           'created_at', v.created_at, 'lat', v.lat, 'lng', v.lng, 'photo_path', v.photo_path)
$$;

DO $$
DECLARE def text := pg_get_functiondef('app.runs_json(uuid,date,date)'::regprocedure);
BEGIN
  IF position('''notes'', r.notes, ''created_at'', r.created_at,' IN def) = 0 THEN RAISE EXCEPTION 'runs_json patch target missing'; END IF;
  EXECUTE replace(def, '''notes'', r.notes, ''created_at'', r.created_at,',
    '''notes'', r.notes, ''created_at'', r.created_at, ''lat'', r.lat, ''lng'', r.lng, ''accuracy_m'', r.accuracy_m, ''photo_path'', r.photo_path,');
END$$;

-- p_kind 'run' | 'visit'
CREATE FUNCTION public.set_field_location(p_kind text, p_id uuid, p_lat numeric, p_lng numeric, p_accuracy numeric DEFAULT NULL, p_photo text DEFAULT NULL)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, extensions, pg_temp AS $$
DECLARE v_uid uuid := app.require_user();
BEGIN
  IF p_lat IS NOT NULL AND (p_lat NOT BETWEEN -90 AND 90 OR p_lng NOT BETWEEN -180 AND 180) THEN
    RAISE EXCEPTION 'Bad location' USING ERRCODE = 'WH005';
  END IF;
  IF p_kind = 'run' THEN
    UPDATE market_runs SET lat = coalesce(p_lat, lat), lng = coalesce(p_lng, lng), accuracy_m = coalesce(p_accuracy::int, accuracy_m),
           photo_path = coalesce(app.own_photo_path(p_photo), photo_path), located_at = CASE WHEN p_lat IS NOT NULL THEN now() ELSE located_at END
     WHERE id = p_id AND user_id = v_uid;
  ELSE
    UPDATE customer_visits SET lat = coalesce(p_lat, lat), lng = coalesce(p_lng, lng), accuracy_m = coalesce(p_accuracy::int, accuracy_m),
           photo_path = coalesce(app.own_photo_path(p_photo), photo_path)
     WHERE id = p_id AND user_id = v_uid;
  END IF;
  IF NOT FOUND THEN RAISE EXCEPTION 'Entry not found' USING ERRCODE = 'WH005'; END IF;
END$$;

-- ===========================================================================
-- Visit plan (employee plans the day; owner can plan for them)
-- ===========================================================================
CREATE TABLE visit_plans (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       uuid NOT NULL REFERENCES users(id),
  plan_date     date NOT NULL,
  customer_id   uuid REFERENCES customers(id) ON DELETE SET NULL,
  customer_name text NOT NULL,
  place         text,
  purpose       text,
  status        text NOT NULL DEFAULT 'PLANNED' CHECK (status IN ('PLANNED', 'DONE', 'SKIPPED')),
  result_note   text,
  created_by    uuid NOT NULL REFERENCES users(id),
  created_at    timestamptz NOT NULL DEFAULT now(),
  done_at       timestamptz
);
CREATE INDEX visit_plans_user_date ON visit_plans(user_id, plan_date);
ALTER TABLE visit_plans ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON visit_plans FROM PUBLIC, anon, authenticated;

CREATE FUNCTION app.plan_json(v visit_plans) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, extensions, pg_temp AS $$
  SELECT to_jsonb(v) || jsonb_build_object('employee', (SELECT full_name FROM users WHERE id = v.user_id),
                                           'planned_by', (SELECT full_name FROM users WHERE id = v.created_by),
                                           'phone', (SELECT phone FROM customers WHERE id = v.customer_id))
$$;

CREATE FUNCTION public.my_visit_plan(p_from date, p_to date) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, extensions, pg_temp AS $$
DECLARE v_uid uuid := app.require_user();
BEGIN
  RETURN (SELECT coalesce(jsonb_agg(app.plan_json(v) ORDER BY v.plan_date, v.created_at), '[]') FROM visit_plans v
           WHERE v.user_id = v_uid AND v.plan_date BETWEEN p_from AND p_to);
END$$;

-- p = { id?, userId? (owner only), planDate, customerId?, customerName, place?, purpose? }
CREATE FUNCTION public.save_visit_plan(p jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, extensions, pg_temp AS $$
DECLARE v_uid uuid := app.require_user(); v_for uuid; v visit_plans; v_name text;
BEGIN
  v_for := CASE WHEN app.is_owner() THEN coalesce(nullif(p->>'userId', '')::uuid, v_uid) ELSE v_uid END;
  v_name := coalesce(nullif(btrim(p->>'customerName'), ''), (SELECT name FROM customers WHERE id = nullif(p->>'customerId', '')::uuid));
  IF v_name IS NULL THEN RAISE EXCEPTION 'Whom will you visit?' USING ERRCODE = 'WH005'; END IF;
  IF nullif(p->>'planDate', '')::date IS NULL OR (p->>'planDate')::date < app.today_ist() - 1 THEN
    RAISE EXCEPTION 'Pick today or a later date' USING ERRCODE = 'WH005';
  END IF;
  IF nullif(p->>'id', '') IS NULL THEN
    INSERT INTO visit_plans(user_id, plan_date, customer_id, customer_name, place, purpose, created_by)
    VALUES (v_for, (p->>'planDate')::date, nullif(p->>'customerId', '')::uuid, v_name, nullif(btrim(p->>'place'), ''),
            nullif(btrim(p->>'purpose'), ''), v_uid) RETURNING * INTO v;
    IF v_for <> v_uid THEN
      PERFORM app.notify_user(v_for, 'VISIT_PLAN', 'New visit planned for you', v_name || ' on ' || to_char(v.plan_date, 'DD Mon')
        || coalesce(' — ' || v.purpose, ''), jsonb_build_object('plan_id', v.id));
    END IF;
  ELSE
    UPDATE visit_plans SET plan_date = (p->>'planDate')::date, customer_id = nullif(p->>'customerId', '')::uuid, customer_name = v_name,
           place = nullif(btrim(p->>'place'), ''), purpose = nullif(btrim(p->>'purpose'), '')
     WHERE id = (p->>'id')::uuid AND (user_id = v_uid OR app.is_owner()) RETURNING * INTO v;
    IF NOT FOUND THEN RAISE EXCEPTION 'Plan not found' USING ERRCODE = 'WH005'; END IF;
  END IF;
  RETURN app.plan_json(v);
END$$;

CREATE FUNCTION public.set_visit_plan_status(p_id uuid, p_status text, p_note text DEFAULT NULL) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, extensions, pg_temp AS $$
DECLARE v_uid uuid := app.require_user();
BEGIN
  IF p_status NOT IN ('PLANNED', 'DONE', 'SKIPPED') THEN RAISE EXCEPTION 'Unknown status' USING ERRCODE = 'WH005'; END IF;
  UPDATE visit_plans SET status = p_status, result_note = nullif(btrim(coalesce(p_note, '')), ''),
         done_at = CASE WHEN p_status = 'PLANNED' THEN NULL ELSE now() END
   WHERE id = p_id AND (user_id = v_uid OR app.is_owner());
  IF NOT FOUND THEN RAISE EXCEPTION 'Plan not found' USING ERRCODE = 'WH005'; END IF;
END$$;

CREATE FUNCTION public.delete_visit_plan(p_id uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, extensions, pg_temp AS $$
DECLARE v_uid uuid := app.require_user();
BEGIN
  DELETE FROM visit_plans WHERE id = p_id AND (app.is_owner() OR (user_id = v_uid AND created_by = v_uid));
  IF NOT FOUND THEN RAISE EXCEPTION 'Plan not found (a plan made by the owner can only be marked done or skipped)' USING ERRCODE = 'WH005'; END IF;
END$$;

CREATE FUNCTION public.owner_visit_plans(p_from date, p_to date, p_user uuid DEFAULT NULL) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, extensions, pg_temp AS $$
BEGIN
  PERFORM app.require_owner();
  RETURN (SELECT coalesce(jsonb_agg(app.plan_json(v) ORDER BY v.plan_date, v.user_id, v.created_at), '[]') FROM visit_plans v
           WHERE v.plan_date BETWEEN p_from AND p_to AND (p_user IS NULL OR v.user_id = p_user));
END$$;

-- ===========================================================================
-- Leave requests and clock-in / out corrections
-- ===========================================================================
CREATE TABLE clock_fix_requests (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id        uuid NOT NULL REFERENCES users(id),
  work_date      date NOT NULL,
  attendance_id  uuid REFERENCES attendance(id) ON DELETE SET NULL,
  want_in        timestamptz,
  want_out       timestamptz,
  reason         text NOT NULL,
  status         text NOT NULL DEFAULT 'REQUESTED' CHECK (status IN ('REQUESTED', 'APPROVED', 'REJECTED', 'CANCELLED')),
  owner_note     text,
  decided_by     uuid REFERENCES users(id),
  decided_at     timestamptz,
  created_at     timestamptz NOT NULL DEFAULT now(),
  CHECK (want_out IS NULL OR want_in IS NULL OR want_out > want_in)
);
ALTER TABLE clock_fix_requests ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON clock_fix_requests FROM PUBLIC, anon, authenticated;
ALTER TABLE leave_days ADD COLUMN owner_note text;

CREATE FUNCTION public.request_leave(p_from date, p_to date, p_reason text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, extensions, pg_temp AS $$
DECLARE v_uid uuid := app.require_user(); n int;
BEGIN
  IF p_from IS NULL OR p_to IS NULL OR p_to < p_from THEN RAISE EXCEPTION 'Pick the leave dates' USING ERRCODE = 'WH005'; END IF;
  IF p_to - p_from > 30 THEN RAISE EXCEPTION 'At most 31 days in one request' USING ERRCODE = 'WH005'; END IF;
  IF p_from < app.today_ist() - 7 THEN RAISE EXCEPTION 'Leave can be asked for at most 7 days back' USING ERRCODE = 'WH005'; END IF;
  IF length(btrim(coalesce(p_reason, ''))) < 3 THEN RAISE EXCEPTION 'Please give a reason' USING ERRCODE = 'WH005'; END IF;
  INSERT INTO leave_days(user_id, leave_date, reason, status)
  SELECT v_uid, d::date, btrim(p_reason), 'REQUESTED' FROM generate_series(p_from, p_to, interval '1 day') d
  ON CONFLICT (user_id, leave_date) DO UPDATE SET reason = EXCLUDED.reason, status = 'REQUESTED', decided_by = NULL, decided_at = NULL, owner_note = NULL
   WHERE leave_days.status IN ('REJECTED', 'CANCELLED');
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n > 0 THEN
    PERFORM app.notify_owners('LEAVE_REQUEST', 'Leave request', (SELECT full_name FROM users WHERE id = v_uid) || ' asked for leave '
      || to_char(p_from, 'DD Mon') || CASE WHEN p_to > p_from THEN ' – ' || to_char(p_to, 'DD Mon') ELSE '' END || ': ' || btrim(p_reason),
      jsonb_build_object('user_id', v_uid));
  END IF;
  RETURN jsonb_build_object('days', n);
END$$;

CREATE FUNCTION public.cancel_leave_request(p_id uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, extensions, pg_temp AS $$
DECLARE v_uid uuid := app.require_user();
BEGIN
  UPDATE leave_days SET status = 'CANCELLED' WHERE id = p_id AND user_id = v_uid AND status IN ('REQUESTED', 'APPROVED') AND leave_date >= app.today_ist();
  IF NOT FOUND THEN RAISE EXCEPTION 'Only your own upcoming leave can be cancelled' USING ERRCODE = 'WH005'; END IF;
END$$;

-- p = { date, attendanceId?, clockIn ('HH:MM' or null), clockOut ('HH:MM' or null), reason }
CREATE FUNCTION public.request_clock_fix(p jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, extensions, pg_temp AS $$
DECLARE v_uid uuid := app.require_user(); v_date date := nullif(p->>'date', '')::date; v_in timestamptz; v_out timestamptz; v_id uuid; v_att uuid;
BEGIN
  IF v_date IS NULL OR v_date > app.today_ist() OR v_date < app.today_ist() - 31 THEN
    RAISE EXCEPTION 'Pick a date in the last month' USING ERRCODE = 'WH005';
  END IF;
  IF length(btrim(coalesce(p->>'reason', ''))) < 3 THEN RAISE EXCEPTION 'Please give a reason' USING ERRCODE = 'WH005'; END IF;
  IF nullif(p->>'clockIn', '') IS NOT NULL THEN v_in := (v_date::text || ' ' || (p->>'clockIn'))::timestamp AT TIME ZONE 'Asia/Kolkata'; END IF;
  IF nullif(p->>'clockOut', '') IS NOT NULL THEN v_out := (v_date::text || ' ' || (p->>'clockOut'))::timestamp AT TIME ZONE 'Asia/Kolkata'; END IF;
  IF v_in IS NULL AND v_out IS NULL THEN RAISE EXCEPTION 'Enter the correct clock-in or clock-out time' USING ERRCODE = 'WH005'; END IF;
  IF v_out <= v_in THEN RAISE EXCEPTION 'Clock-out must be after clock-in' USING ERRCODE = 'WH005'; END IF;
  v_att := nullif(p->>'attendanceId', '')::uuid;
  IF v_att IS NOT NULL AND NOT EXISTS (SELECT 1 FROM attendance WHERE id = v_att AND user_id = v_uid) THEN
    RAISE EXCEPTION 'Attendance entry not found' USING ERRCODE = 'WH005';
  END IF;
  IF v_att IS NULL AND v_in IS NULL THEN RAISE EXCEPTION 'For a missed day, enter the clock-in time' USING ERRCODE = 'WH005'; END IF;
  INSERT INTO clock_fix_requests(user_id, work_date, attendance_id, want_in, want_out, reason)
  VALUES (v_uid, v_date, v_att, v_in, v_out, btrim(p->>'reason')) RETURNING id INTO v_id;
  PERFORM app.notify_owners('CLOCK_FIX_REQUEST', 'Clock time correction', (SELECT full_name FROM users WHERE id = v_uid)
    || ' asks to correct ' || to_char(v_date, 'DD Mon') || ': '
    || concat_ws(', ', 'in ' || to_char(v_in AT TIME ZONE 'Asia/Kolkata', 'HH12:MI AM'), 'out ' || to_char(v_out AT TIME ZONE 'Asia/Kolkata', 'HH12:MI AM'))
    || ' — ' || btrim(p->>'reason'), jsonb_build_object('request_id', v_id));
  RETURN jsonb_build_object('id', v_id);
END$$;

CREATE FUNCTION public.my_requests() RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, extensions, pg_temp AS $$
DECLARE v_uid uuid := app.require_user();
BEGIN
  RETURN jsonb_build_object(
    'leave', (SELECT coalesce(jsonb_agg(jsonb_build_object('id', id, 'date', leave_date, 'reason', reason, 'status', status, 'owner_note', owner_note)
                ORDER BY leave_date DESC), '[]') FROM leave_days WHERE user_id = v_uid AND leave_date > app.today_ist() - 90),
    'clock', (SELECT coalesce(jsonb_agg(jsonb_build_object('id', id, 'date', work_date, 'want_in', want_in, 'want_out', want_out, 'reason', reason,
                'status', status, 'owner_note', owner_note, 'created_at', created_at) ORDER BY created_at DESC), '[]')
                FROM clock_fix_requests WHERE user_id = v_uid AND created_at > now() - interval '90 days'));
END$$;

CREATE FUNCTION public.owner_requests(p_all boolean DEFAULT false) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, extensions, pg_temp AS $$
BEGIN
  PERFORM app.require_owner();
  RETURN jsonb_build_object(
    'leave', (SELECT coalesce(jsonb_agg(jsonb_build_object('id', l.id, 'user_id', l.user_id, 'employee', u.full_name, 'date', l.leave_date,
                'reason', l.reason, 'status', l.status, 'owner_note', l.owner_note, 'created_at', l.created_at) ORDER BY l.leave_date), '[]')
                FROM leave_days l JOIN users u ON u.id = l.user_id
               WHERE (p_all AND l.leave_date > app.today_ist() - 60) OR l.status = 'REQUESTED'),
    'clock', (SELECT coalesce(jsonb_agg(jsonb_build_object('id', c.id, 'user_id', c.user_id, 'employee', u.full_name, 'date', c.work_date,
                'want_in', c.want_in, 'want_out', c.want_out, 'reason', c.reason, 'status', c.status, 'owner_note', c.owner_note,
                'current_in', a.clock_in_at, 'current_out', a.clock_out_at, 'created_at', c.created_at) ORDER BY c.created_at), '[]')
                FROM clock_fix_requests c JOIN users u ON u.id = c.user_id LEFT JOIN attendance a ON a.id = c.attendance_id
               WHERE (p_all AND c.created_at > now() - interval '60 days') OR c.status = 'REQUESTED'));
END$$;

CREATE FUNCTION public.owner_decide_leave(p_ids uuid[], p_approve boolean, p_note text DEFAULT NULL) RETURNS int
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, extensions, pg_temp AS $$
DECLARE n int; r record;
BEGIN
  PERFORM app.require_owner();
  UPDATE leave_days SET status = CASE WHEN p_approve THEN 'APPROVED' ELSE 'REJECTED' END, decided_by = app.current_user_id(), decided_at = now(),
         owner_note = nullif(btrim(coalesce(p_note, '')), '')
   WHERE id = ANY (p_ids) AND status = 'REQUESTED';
  GET DIAGNOSTICS n = ROW_COUNT;
  FOR r IN SELECT user_id, min(leave_date) f, max(leave_date) t, count(*) c FROM leave_days WHERE id = ANY (p_ids) GROUP BY 1 LOOP
    PERFORM app.notify_user(r.user_id, 'LEAVE_DECISION', CASE WHEN p_approve THEN 'Leave approved' ELSE 'Leave not approved' END,
      to_char(r.f, 'DD Mon') || CASE WHEN r.t > r.f THEN ' – ' || to_char(r.t, 'DD Mon') ELSE '' END || coalesce(' · ' || nullif(btrim(p_note), ''), ''));
  END LOOP;
  RETURN n;
END$$;

CREATE FUNCTION public.owner_add_leave(p_user uuid, p_from date, p_to date, p_reason text DEFAULT NULL) RETURNS int
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, extensions, pg_temp AS $$
DECLARE n int;
BEGIN
  PERFORM app.require_owner();
  IF p_to < p_from OR p_to - p_from > 60 THEN RAISE EXCEPTION 'Pick the leave dates' USING ERRCODE = 'WH005'; END IF;
  INSERT INTO leave_days(user_id, leave_date, reason, status, decided_by, decided_at)
  SELECT p_user, d::date, nullif(btrim(coalesce(p_reason, '')), ''), 'APPROVED', app.current_user_id(), now()
    FROM generate_series(p_from, p_to, interval '1 day') d
  ON CONFLICT (user_id, leave_date) DO UPDATE SET status = 'APPROVED', decided_by = EXCLUDED.decided_by, decided_at = now(),
     reason = coalesce(EXCLUDED.reason, leave_days.reason);
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n;
END$$;

CREATE FUNCTION public.owner_decide_clock_fix(p_id uuid, p_approve boolean, p_note text DEFAULT NULL) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, extensions, pg_temp AS $$
DECLARE c clock_fix_requests;
BEGIN
  PERFORM app.require_owner();
  SELECT * INTO c FROM clock_fix_requests WHERE id = p_id FOR UPDATE;
  IF NOT FOUND OR c.status <> 'REQUESTED' THEN RAISE EXCEPTION 'Request not found or already decided' USING ERRCODE = 'WH005'; END IF;
  IF p_approve THEN
    IF c.attendance_id IS NOT NULL THEN
      UPDATE attendance SET clock_in_at = coalesce(c.want_in, clock_in_at), clock_out_at = coalesce(c.want_out, clock_out_at),
             work_date = (coalesce(c.want_in, clock_in_at) AT TIME ZONE 'Asia/Kolkata')::date, edited_by = app.current_user_id()
       WHERE id = c.attendance_id;
    ELSE
      IF c.want_out IS NULL AND EXISTS (SELECT 1 FROM attendance WHERE user_id = c.user_id AND clock_out_at IS NULL) THEN
        RAISE EXCEPTION 'They are clocked in right now — the missed day needs a clock-out time too' USING ERRCODE = 'WH005';
      END IF;
      INSERT INTO attendance(user_id, warehouse_id, work_date, clock_in_at, clock_out_at, clock_in_note, edited_by)
      VALUES (c.user_id, (SELECT primary_warehouse_id FROM users WHERE id = c.user_id), c.work_date, c.want_in, c.want_out,
              'Added on request: ' || c.reason, app.current_user_id());
    END IF;
  END IF;
  UPDATE clock_fix_requests SET status = CASE WHEN p_approve THEN 'APPROVED' ELSE 'REJECTED' END, decided_by = app.current_user_id(),
         decided_at = now(), owner_note = nullif(btrim(coalesce(p_note, '')), '') WHERE id = p_id;
  PERFORM app.notify_user(c.user_id, 'CLOCK_FIX_DECISION', CASE WHEN p_approve THEN 'Clock time corrected' ELSE 'Clock correction not approved' END,
    to_char(c.work_date, 'DD Mon') || coalesce(' · ' || nullif(btrim(p_note), ''), ''));
END$$;

-- ===========================================================================
-- Grants
-- ===========================================================================
REVOKE EXECUTE ON FUNCTION app.own_photo_path(text), app.can_touch_bill(uuid), app.plan_json(visit_plans) FROM PUBLIC, anon, authenticated;
DO $$
DECLARE r record;
BEGIN
  FOR r IN SELECT p.oid::regprocedure AS f FROM pg_proc p
            WHERE p.pronamespace = 'public'::regnamespace AND p.proname = ANY (ARRAY[
              'customer_snapshot', 'customer_last_order', 'staff_customers', 'mark_delivered', 'delivery_info', 'owner_delivered_ids',
              'my_recent_bills', 'set_field_location', 'my_visit_plan', 'save_visit_plan', 'set_visit_plan_status', 'delete_visit_plan',
              'owner_visit_plans', 'request_leave', 'cancel_leave_request', 'request_clock_fix', 'my_requests', 'owner_requests',
              'owner_decide_leave', 'owner_add_leave', 'owner_decide_clock_fix'])
  LOOP
    EXECUTE format('REVOKE EXECUTE ON FUNCTION %s FROM PUBLIC, anon', r.f);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO authenticated', r.f);
  END LOOP;
END$$;

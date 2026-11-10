-- =============================================================================
-- rls_and_rules_test.sql — end-to-end database tests for the Supabase backend.
-- Signs in as each user exactly the way the Data API does (role
-- `authenticated` + request.jwt.claims) and calls the same RPCs the app uses.
-- Run on a FRESH reset + seed:  ./supabase/tests/run.sh --supabase | --plain
-- =============================================================================
\set ON_ERROR_STOP on
\set QUIET on
\o /dev/null
SET client_min_messages = notice;

DROP SCHEMA IF EXISTS t CASCADE;
CREATE SCHEMA t;
GRANT USAGE ON SCHEMA t TO PUBLIC;
CREATE FUNCTION t.ok(cond boolean, name text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  IF cond IS NOT TRUE THEN RAISE EXCEPTION 'FAIL: %', name; END IF;
  RAISE NOTICE 'PASS: %', name;
END$$;
CREATE FUNCTION t.throws(sql text, state text, name text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  BEGIN
    EXECUTE sql;
  EXCEPTION WHEN OTHERS THEN
    IF SQLSTATE = state THEN RAISE NOTICE 'PASS: % (got %)', name, state; RETURN; END IF;
    RAISE EXCEPTION 'FAIL: % — expected %, got % (%)', name, state, SQLSTATE, SQLERRM;
  END;
  RAISE EXCEPTION 'FAIL: % — expected error %, statement succeeded', name, state;
END$$;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA t TO PUBLIC;

\set WHA '''a0000000-0000-0000-0000-000000000001'''
\set WHB '''a0000000-0000-0000-0000-000000000002'''
\set OWNER '''00000000-0000-0000-0000-000000000001'''
\set EMPA '''00000000-0000-0000-0000-000000000010'''
\set EMPB '''00000000-0000-0000-0000-000000000011'''
-- "Sign in" helpers: exactly what PostgREST does for a request with a user JWT.
\set AS_OWNER 'RESET ROLE; SET ROLE authenticated; SELECT set_config(''request.jwt.claims'', ''{"sub":"00000000-0000-0000-0000-000000000001","role":"authenticated"}'', false);'
\set AS_EMPA  'RESET ROLE; SET ROLE authenticated; SELECT set_config(''request.jwt.claims'', ''{"sub":"00000000-0000-0000-0000-000000000010","role":"authenticated"}'', false);'
\set AS_EMPB  'RESET ROLE; SET ROLE authenticated; SELECT set_config(''request.jwt.claims'', ''{"sub":"00000000-0000-0000-0000-000000000011","role":"authenticated"}'', false);'
\set AS_ANON  'RESET ROLE; SET ROLE anon; SELECT set_config(''request.jwt.claims'', ''{"role":"anon"}'', false);'
\set AS_SERVICE 'RESET ROLE; SET ROLE service_role; SELECT set_config(''request.jwt.claims'', ''{"role":"service_role"}'', false);'

-- =============================================================================
\echo '── Anonymous (not signed in)'
-- =============================================================================
:AS_ANON
SELECT t.throws('SELECT * FROM products', '42501', 'anon cannot read the catalogue');
SELECT t.throws('SELECT * FROM inventory_levels', '42501', 'anon cannot read stock');
SELECT t.throws($$SELECT public.search_items('drill')$$, '42501', 'anon cannot call RPCs');

-- =============================================================================
\echo '── Employee A (WHA): isolation & lockout'
-- =============================================================================
:AS_EMPA
SELECT t.ok((public.me())->>'warehouse_code' = 'WHA', 'me(): employee is tied to WHA');
SELECT t.ok((SELECT count(*) FROM inventory_levels) = 4
        AND NOT EXISTS (SELECT 1 FROM inventory_levels WHERE warehouse_id <> :WHA),
        'employee sees stock of own warehouse only');
SELECT t.ok((SELECT count(*) FROM users) = 1, 'employee sees only own user row');
SELECT t.ok((public.search_items('pana'))->0->>'sku_code' = 'STN-CS-1724', 'vernacular alias search "pana" → spanner set');
SELECT t.ok((public.search_items('scrwdriver'))->0->>'sku_code' = 'TAP-SD-903', 'typo-tolerant search');
SELECT t.throws('SELECT * FROM fin.purchase_discounts', '42501', 'fin.* schema is invisible to employees');
SELECT t.throws('SELECT * FROM fin.v_sales_daily', '42501', 'owner analytics views are invisible');
SELECT t.throws('SELECT * FROM notification_outbox', '42501', 'WhatsApp outbox not readable');
SELECT t.throws('SELECT * FROM audit_log', '42501', 'audit log not readable');
SELECT t.throws('SELECT * FROM secure.override_pins', '42501', 'PIN hashes not readable');
SELECT t.throws($$SELECT app.apply_movement('a0000000-0000-0000-0000-000000000001', (SELECT id FROM products LIMIT 1),
                 'ADJUST_FOUND', 1000, 'x', gen_random_uuid(), gen_random_uuid())$$,
                '42501', 'internal stock function cannot be called directly');
SELECT t.throws($$INSERT INTO stock_adjustments(warehouse_id, product_id, movement, qty_delta_base)
                 VALUES ('a0000000-0000-0000-0000-000000000001', (SELECT id FROM products LIMIT 1), 'ADJUST_FOUND', 5)$$,
                '42501', 'employees cannot adjust stock');
SELECT t.throws($$UPDATE inventory_levels SET qty_on_hand = 99999$$, '42501', 'employees cannot write stock levels');
SELECT t.throws($$SELECT public.owner_stock_overview()$$, 'WH002', 'owner dashboard RPC refuses employees');
SELECT t.throws($$SELECT public.owner_set_purchase_discount(gen_random_uuid(), 'PERCENT', 50)$$, 'WH002', 'owner discount RPC refuses employees');
SELECT t.throws($$SELECT public.owner_cancel_dispatch(gen_random_uuid(), 'x')$$, 'WH002', 'employees cannot cancel invoices');
SELECT t.throws($$SELECT public.wa_claim_outbox(10)$$, '42501', 'WhatsApp worker RPCs are service-role only');

-- ---- Direct table writes (what a tampered app could send) are still sanitised.
BEGIN;
INSERT INTO purchases(id, client_txn_id, warehouse_id, vendor_id, vendor_invoice_no, vendor_invoice_date, is_interstate, created_by)
VALUES ('c0000000-0000-0000-0000-000000000001', gen_random_uuid(), :WHA,
        (SELECT id FROM vendors WHERE gstin = '29AAACW1234K1Z9'), 'KTD/2026/7781', app.today_ist() - 2, true, :OWNER);
INSERT INTO purchase_items(purchase_id, line_no, product_id, uom_code, conversion_factor, qty, gst_rate, unit_base_price, unit_incl_price)
VALUES ('c0000000-0000-0000-0000-000000000001', 1, (SELECT id FROM products WHERE sku_code = 'STN-CS-1724'),
        'BOX', 999, 10, 18, 3500, 4130);
COMMIT;
SELECT t.ok((SELECT qty_on_hand FROM inventory_levels il JOIN products p ON p.id = il.product_id
              WHERE p.sku_code = 'STN-CS-1724') = 110, 'inward 10 BOX x 5 = 50 pcs (server-side UoM factor, spoofed 999 ignored)');
SELECT t.ok((SELECT created_by FROM purchases WHERE id = 'c0000000-0000-0000-0000-000000000001') = :EMPA,
            'created_by forced to the signed-in user');
SELECT t.ok((SELECT (taxable_total, cgst_total, sgst_total, igst_total, grand_total, is_interstate)
               = (35000.00, 3150.00, 3150.00, 0.00, 41300.00, false)
             FROM purchases WHERE id = 'c0000000-0000-0000-0000-000000000001'),
            'purchase totals + CGST/SGST split; is_interstate derived from GSTINs');

-- ---- INWARD through the RPC (what the app calls)
SELECT public.create_purchase(jsonb_build_object(
  'clientTxnId', gen_random_uuid(), 'vendorId', (SELECT id FROM vendors WHERE gstin = '27AADCB2230M1ZT'),
  'vendorInvoiceNo', 'BCP-55120', 'vendorInvoiceDate', app.today_ist(),
  'attachments', jsonb_build_array(jsonb_build_object('kind','LORRY_RECEIPT','storagePath','a0000000-0000-0000-0000-000000000001/2026-11/lr.jpg','mimeType','image/jpeg')),
  'lines', jsonb_build_array(jsonb_build_object('productId', (SELECT id FROM products WHERE sku_code = 'BOS-GSB13RE'),
           'uomCode','PCS','qty',5,'gstRate',18,'unitBasePrice',2711.8644,'unitInclPrice',3200)))) AS r \gset p_
SELECT t.ok((:'p_r'::jsonb)->'purchase'->>'igst_total' = '2440.68' AND (:'p_r'::jsonb)->'purchase'->>'grand_total' = '16000.00',
            'create_purchase RPC: inter-state uses IGST, totals returned');

SELECT t.ok((public.create_purchase(jsonb_build_object(
  'clientTxnId', gen_random_uuid(), 'warehouseId', 'a0000000-0000-0000-0000-000000000002',
  'vendorId', (SELECT id FROM vendors WHERE gstin = '29AAACW1234K1Z9'), 'vendorInvoiceNo', 'KTD-PIN', 'vendorInvoiceDate', app.today_ist(),
  'lines', jsonb_build_array(jsonb_build_object('productId', (SELECT id FROM products WHERE sku_code = 'FIS-SX8'),
           'uomCode','PCS','qty',1,'gstRate',18,'unitBasePrice',1.80,'unitInclPrice',2.12)))))->'purchase'->>'warehouse_id'
     = 'a0000000-0000-0000-0000-000000000001', 'staff RPC entries are pinned to their own warehouse (requested WHB ignored)');
SELECT t.throws($$INSERT INTO purchases(client_txn_id, warehouse_id, vendor_id, vendor_invoice_no, vendor_invoice_date, is_interstate)
                 VALUES (gen_random_uuid(), 'a0000000-0000-0000-0000-000000000002', (SELECT id FROM vendors LIMIT 1), 'X1', current_date, false)$$,
                '42501', 'direct insert into another warehouse blocked by RLS');

DO $$ BEGIN
  BEGIN
    PERFORM public.create_purchase(jsonb_build_object('clientTxnId', gen_random_uuid(), 'vendorId', (SELECT id FROM vendors LIMIT 1),
      'vendorInvoiceNo', 'BAD-GST', 'vendorInvoiceDate', current_date,
      'lines', jsonb_build_array(jsonb_build_object('productId', (SELECT id FROM products LIMIT 1), 'uomCode','PCS','qty',1,
               'gstRate',18,'unitBasePrice',100,'unitInclPrice',112))));
    RAISE EXCEPTION 'should not reach' USING ERRCODE = 'T0001';
  EXCEPTION WHEN check_violation THEN RAISE NOTICE 'PASS: base/inclusive price mismatch rejected (23514)';
  END;
  BEGIN
    PERFORM public.create_purchase(jsonb_build_object('clientTxnId', gen_random_uuid(), 'vendorId', (SELECT id FROM vendors LIMIT 1),
      'vendorInvoiceNo', 'BAD-SLAB', 'vendorInvoiceDate', current_date,
      'lines', jsonb_build_array(jsonb_build_object('productId', (SELECT id FROM products LIMIT 1), 'uomCode','PCS','qty',1,
               'gstRate',15,'unitBasePrice',100,'unitInclPrice',115))));
    RAISE EXCEPTION 'should not reach' USING ERRCODE = 'T0001';
  EXCEPTION WHEN foreign_key_violation THEN RAISE NOTICE 'PASS: non-existent GST slab (15%%) rejected';
  END;
END $$;

-- ---- OUTWARD: stock safeguard
DO $$
DECLARE v_detail text;
BEGIN
  PERFORM public.create_dispatch(jsonb_build_object('clientTxnId', gen_random_uuid(),
    'customerId', (SELECT id FROM customers WHERE gstin = '29AABCS5678L1ZM'), 'transportMode', 'TRANSPORTER', 'vehicleRegNo', 'KA01AB1234',
    'lines', jsonb_build_array(
      jsonb_build_object('productId', (SELECT id FROM products WHERE sku_code = 'BOS-GSB13RE'), 'uomCode','PCS','qty',40,'unitBasePrice',3200),
      jsonb_build_object('productId', (SELECT id FROM products WHERE sku_code = 'STN-CS-1724'), 'uomCode','BOX','qty',30,'unitBasePrice',4000))));
  RAISE EXCEPTION 'should not reach' USING ERRCODE = 'T0001';
EXCEPTION WHEN SQLSTATE 'WH001' THEN
  GET STACKED DIAGNOSTICS v_detail = PG_EXCEPTION_DETAIL;
  PERFORM t.ok(jsonb_array_length(v_detail::jsonb) = 2 AND (v_detail::jsonb)->0->>'availableBase' IS NOT NULL,
               'dispatch blocked; BOTH shortfalls reported at once (30 drills, 110 spanner sets available)');
END $$;
SELECT t.ok(jsonb_array_length((public.check_dispatch(jsonb_build_object('lines', jsonb_build_array(
  jsonb_build_object('productId', (SELECT id FROM products WHERE sku_code = 'BOS-GSB13RE'), 'uomCode','PCS','qty',31)))))->'shortfalls') = 1,
  'check_dispatch dry-run reports shortfall live');

SELECT t.ok((public.request_stock_override('000000', 'test'))->>'ok' = 'false', 'wrong PIN gives no override');
SELECT (public.request_stock_override('246810', 'Urgent dealer order, stock arriving tomorrow'))->>'overrideId' AS ovr \gset
SELECT t.ok(:'ovr' IS NOT NULL, 'correct PIN issues a single-use override grant');

SELECT public.create_dispatch(jsonb_build_object(
  'clientTxnId', 'd1000000-0000-0000-0000-000000000001',
  'customerId', (SELECT id FROM customers WHERE gstin = '29AABCS5678L1ZM'),
  'salesAgentId', (SELECT id FROM sales_agents WHERE name LIKE 'Manjunath%'),
  'transportMode', 'TRANSPORTER', 'vehicleRegNo', 'ka-01-ab-1234', 'driverPhone', '+91 98450 12345',
  'transporterName', 'VRL Logistics', 'invoiceDate', app.today_ist() - 30, 'overrideId', :'ovr',
  'lines', jsonb_build_array(
    jsonb_build_object('productId', (SELECT id FROM products WHERE sku_code = 'BOS-GSB13RE'), 'uomCode','PCS','qty',40,'unitBasePrice',3200,'discountPct',5),
    jsonb_build_object('productId', (SELECT id FROM products WHERE sku_code = 'FIS-SX8'), 'uomCode','CTN','qty',1,'unitBasePrice',3600)))) -> 'dispatch' AS d1 \gset
SELECT t.ok((SELECT qty_on_hand FROM inventory_levels il JOIN products p ON p.id = il.product_id
              WHERE p.sku_code = 'BOS-GSB13RE') = -10, 'override allowed dispatch beyond stock (now -10)');
SELECT t.ok((SELECT qty_on_hand FROM inventory_levels il JOIN products p ON p.id = il.product_id
              WHERE p.sku_code = 'FIS-SX8') = 8001, '1 CTN of plugs = 2000 pcs deducted');
SELECT t.ok((:'d1'::jsonb ->> 'invoice_date')::date = app.today_ist() AND :'d1'::jsonb ->> 'vehicle_reg_no' = 'KA01AB1234'
            AND :'d1'::jsonb ->> 'driver_phone' = '9845012345' AND :'d1'::jsonb ->> 'is_interstate' = 'false',
            'staff cannot back-date; vehicle no. & phone normalised; intra-state');
SELECT t.ok((:'d1'::jsonb ->> 'taxable_total', :'d1'::jsonb ->> 'discount_total', :'d1'::jsonb ->> 'cgst_total',
             :'d1'::jsonb ->> 'sgst_total', :'d1'::jsonb ->> 'grand_total')
            = ('125200.00', '6400.00', '11268.00', '11268.00', '147736.00'), 'create_dispatch returns correct GST totals');
SELECT t.ok(:'d1'::jsonb ->> 'invoice_no' = 'WHA/' || app.fy_label(app.today_ist()) || '/00001', 'invoice number per warehouse & FY');
SELECT t.ok((public.create_dispatch(jsonb_build_object('clientTxnId', 'd1000000-0000-0000-0000-000000000001')))->>'replayed' = 'true',
            'retry with same clientTxnId returns the original invoice (idempotent)');

SELECT t.throws(format($$SELECT public.create_dispatch(jsonb_build_object('clientTxnId', gen_random_uuid(),
  'customerId', (SELECT id FROM customers LIMIT 1), 'transportMode', 'CUSTOMER_PICKUP', 'overrideId', %L,
  'lines', jsonb_build_array(jsonb_build_object('productId', (SELECT id FROM products WHERE sku_code = 'BOS-GSB13RE'),
           'uomCode','PCS','qty',1,'unitBasePrice',3200))))$$, :'ovr'), 'WH001', 'a consumed override cannot be reused');

SELECT public.create_dispatch(jsonb_build_object('clientTxnId', gen_random_uuid(),
  'customerId', (SELECT id FROM customers WHERE gstin = '33AACCT4321M1ZF'), 'transportMode', 'OWN_VEHICLE', 'vehicleRegNo', 'KA05MN4321',
  'lines', jsonb_build_array(jsonb_build_object('productId', (SELECT id FROM products WHERE sku_code = 'TAP-SD-903'),
           'uomCode','CTN','qty',2,'unitBasePrice',7440)))) -> 'dispatch' AS d3 \gset
SELECT t.ok(:'d3'::jsonb ->> 'is_interstate' = 'true' AND :'d3'::jsonb ->> 'igst_total' = '2678.40'
            AND :'d3'::jsonb ->> 'grand_total' = '17558.40', 'inter-state sale uses IGST');

SELECT t.throws(format($$INSERT INTO dispatch_items(dispatch_id, line_no, product_id, uom_code, conversion_factor, qty, unit_base_price)
                 VALUES (%L, 2, (SELECT id FROM products LIMIT 1), 'PCS', 1, 1, 1)$$, :'d3'::jsonb->>'id'),
                'WH005', 'lines cannot be added to an already-committed invoice');
SELECT t.throws($$UPDATE dispatches SET grand_total = 1$$, '42501', 'employees cannot edit invoice amounts');
SELECT t.ok(jsonb_array_length((public.my_day())->'dispatches') = 2 AND jsonb_array_length((public.my_day())->'purchases') = 3,
            'my_day(): own invoices and inwards from today');

-- ---- Storage: lorry-receipt photos
SELECT t.throws($$INSERT INTO storage.objects(bucket_id, name) VALUES ('purchase-docs', 'a0000000-0000-0000-0000-000000000002/2026-11/x.jpg')$$,
                '42501', 'cannot upload receipts into another warehouse''s folder');
INSERT INTO storage.objects(bucket_id, name) VALUES ('purchase-docs', 'a0000000-0000-0000-0000-000000000001/2026-11/lr.jpg');
SELECT t.ok((SELECT count(*) FROM storage.objects WHERE bucket_id = 'purchase-docs') = 0, 'staff can upload but not browse purchase documents');
SELECT t.throws($$INSERT INTO storage.objects(bucket_id, name) VALUES ('product-images', 'x.jpg')$$, '42501', 'only owners upload catalogue photos');

-- ---- Transfer note WHA → WHB (created and dispatched in one RPC)
SELECT (public.create_transfer(jsonb_build_object('clientTxnId', gen_random_uuid(), 'toWarehouseId', 'a0000000-0000-0000-0000-000000000002',
  'vehicleRegNo', 'KA01TT0001', 'lines', jsonb_build_array(jsonb_build_object('productId', (SELECT id FROM products WHERE sku_code = 'TAP-SD-903'),
  'uomCode','PCS','qty',20)))))->>'id' AS tn \gset
SELECT t.ok((SELECT status FROM transfer_notes WHERE id = :'tn') = 'IN_TRANSIT', 'transfer note created & dispatched');
SELECT t.ok((SELECT qty_on_hand FROM inventory_levels il JOIN products p ON p.id = il.product_id
              WHERE p.sku_code = 'TAP-SD-903') = 172, 'transfer out: 240 − 48 sold − 20 moved = 172');
SELECT t.throws(format('SELECT public.receive_transfer(%L)', :'tn'), 'WH002', 'source warehouse cannot receive its own transfer');
SELECT t.throws($$INSERT INTO transfer_notes(client_txn_id, from_warehouse_id, to_warehouse_id)
                 VALUES (gen_random_uuid(), 'a0000000-0000-0000-0000-000000000002', 'a0000000-0000-0000-0000-000000000001')$$,
                '42501', 'cannot raise a transfer out of someone else''s warehouse');

-- =============================================================================
\echo '── Employee B (WHB)'
-- =============================================================================
:AS_EMPB
SELECT t.ok((SELECT count(*) FROM dispatches) = 0 AND (SELECT count(*) FROM purchases) = 0,
            'employee B sees none of employee A''s transactions');
SELECT t.ok(NOT EXISTS (SELECT 1 FROM inventory_levels WHERE warehouse_id <> :WHB), 'employee B sees only WHB stock');
SELECT t.ok(jsonb_array_length(public.list_transfers('IN_TRANSIT')) = 1, 'destination sees the inbound transfer note');
SELECT t.ok((SELECT qty_in_transit FROM inventory_levels il JOIN products p ON p.id = il.product_id
              WHERE p.sku_code = 'TAP-SD-903') = 20, 'destination sees 20 pcs in transit');
SELECT t.throws(format('SELECT public.dispatch_transfer(%L)', :'tn'), 'WH002', 'destination cannot dispatch someone else''s transfer');
SELECT public.receive_transfer(:'tn', '[{"lineNo":1,"qtyReceivedBase":18}]');
SELECT t.ok((SELECT (qty_on_hand, qty_in_transit) = (48.000, 0.000) FROM inventory_levels il JOIN products p ON p.id = il.product_id
              WHERE p.sku_code = 'TAP-SD-903'), 'received 18 of 20 (2 short recorded), in-transit cleared');

DO $$
DECLARE i int;
BEGIN
  FOR i IN 1..5 LOOP PERFORM public.request_stock_override('11111' || i, 'guess'); END LOOP;
END $$;
SELECT t.throws($$SELECT public.request_stock_override('246810', 'x')$$, 'WH003',
                'PIN locked after 5 wrong attempts in 15 minutes (even the right PIN)');
SELECT t.throws($$SELECT app.request_stock_override('246810', 'a0000000-0000-0000-0000-000000000001', 'x')$$, 'WH002',
                'cannot request an override for another warehouse');

-- =============================================================================
\echo '── Owner'
-- =============================================================================
:AS_OWNER
SELECT t.ok((SELECT count(DISTINCT warehouse_id) FROM inventory_levels) = 2, 'owner sees all warehouses');
SELECT t.throws('SELECT * FROM secure.override_pins', '42501', 'owners cannot read PIN hashes either');
SELECT t.throws('SELECT * FROM fin.purchase_discounts', '42501', 'owners reach fin.* only through owner_* RPCs');

SELECT t.ok((SELECT (r->>'owner_discount', r->>'net_taxable', r->>'net_payable') = ('1750.00', '33250.00', '39550.00')
             FROM public.owner_set_purchase_discount('c0000000-0000-0000-0000-000000000001', 'PERCENT', 5, 'Quarterly scheme') r),
            'owner discount: billed 41,300 → net payable 39,550');
SELECT t.ok((SELECT (i->>'avgCost')::numeric FROM jsonb_array_elements((public.owner_stock_overview())->'items') i
              WHERE i->>'sku' = 'STN-CS-1724') = 665,
            'stock valued at net cost: (35,000 − 1,750) ÷ 50 = ₹665 per spanner set');
SELECT t.ok(jsonb_array_length((public.owner_stock_overview())->'warehouses') = 2, 'stock overview: valuation per warehouse');
SELECT t.ok(jsonb_array_length(public.owner_top_items(app.today_ist(), app.today_ist())) = 3, 'top sellers');
SELECT t.ok(jsonb_array_length(public.owner_margins(app.today_ist() - 30, app.today_ist())) >= 1, 'margin spread by category');
SELECT t.ok(jsonb_array_length(public.owner_sales_trend(app.today_ist() - 30, app.today_ist(), 'month')) = 1, 'monthly sales trend');
SELECT t.ok((SELECT (s->>'invoices')::int FROM jsonb_array_elements((public.owner_staff_performance(app.today_ist(), app.today_ist()))->'staff') s
              WHERE s->>'user_id' = :EMPA) = 2, 'staff performance: 2 invoices for Ravi');
SELECT t.ok(jsonb_array_length(public.owner_dead_stock(0)) >= 1, 'dead-stock report');
SELECT t.ok(EXISTS (SELECT 1 FROM jsonb_array_elements(public.owner_reorder_alerts()) a
                     WHERE a->>'warehouse_code' = 'WHB' AND a->>'sku_code' = 'STN-CS-1724'),
            'reorder alert: WHB has 0 spanner sets vs threshold 20');
SELECT t.ok(jsonb_array_length((public.owner_create_purchase_orders(:WHB,
               ARRAY(SELECT id FROM products WHERE sku_code = 'STN-CS-1724')))->'purchaseOrderIds') = 1,
            'one-click PO created against last vendor');
SELECT t.ok(jsonb_array_length(public.owner_list_users()) = 3, 'owner lists staff logins');
SELECT t.throws($$SELECT public.owner_update_user('00000000-0000-0000-0000-000000000001', false)$$, 'WH005', 'owner cannot lock themselves out');

SELECT public.owner_cancel_dispatch((:'d3'::jsonb->>'id')::uuid, 'Wrong customer');
SELECT t.ok((SELECT qty_on_hand FROM inventory_levels il JOIN products p ON p.id = il.product_id
              WHERE il.warehouse_id = :WHA AND p.sku_code = 'TAP-SD-903') = 220, 'owner cancel restores stock via reversal');
UPDATE dispatches SET transporter_name = 'Gati' WHERE id = (:'d1'::jsonb->>'id')::uuid;
SELECT t.throws(format('UPDATE dispatches SET grand_total = 1 WHERE id = %L', :'d1'::jsonb->>'id'), '42501',
                'even owners cannot edit invoice amounts (cancel & re-issue)');
INSERT INTO storage.objects(bucket_id, name) VALUES ('product-images', 'BOS-GSB13RE.jpg');
SELECT t.ok((SELECT count(*) FROM storage.objects WHERE bucket_id = 'purchase-docs') = 1, 'owner can read purchase documents');

-- =============================================================================
\echo '── WhatsApp worker (service role, as used by the Edge Function)'
-- =============================================================================
:AS_SERVICE
SELECT public.wa_claim_outbox(20) AS claimed \gset
SELECT t.ok(jsonb_array_length(:'claimed'::jsonb) = 2 AND (:'claimed'::jsonb)->0->>'event_type' = 'DISPATCH_ALERT',
            'one dispatch alert queued per committed invoice; claimed by the relay');
SELECT t.ok(jsonb_array_length(public.wa_claim_outbox(20)) = 0, 'claimed rows are not handed out twice (SKIP LOCKED + SENDING)');
SELECT t.ok((public.wa_dispatch_payload(((:'claimed'::jsonb)->0->>'aggregate_id')::uuid))->>'invoice_no' LIKE 'WHA/%',
            'alert payload has invoice, customer GSTIN, items, totals, transport');
SELECT public.wa_mark_sent(((:'claimed'::jsonb)->0->>'id')::bigint, 'wamid.TEST', '["919800000001"]');
SELECT public.wa_status_update('wamid.TEST', 'delivered');
SELECT t.ok(((public.wa_eod_payload(app.today_ist()))->'warehouses'->0->>'total_incl_gst')::numeric = 147736.00,
            'EOD digest payload: WHA total after cancellation');

-- =============================================================================
\echo '── Platform checks (as postgres)'
-- =============================================================================
RESET ROLE;
SELECT t.ok((SELECT status FROM notification_outbox WHERE provider_message_id = 'wamid.TEST') = 'DELIVERED', 'delivery webhook marks DELIVERED');
SELECT app.enqueue_eod_digest(); SELECT app.enqueue_eod_digest();
SELECT t.ok((SELECT count(*) FROM notification_outbox WHERE event_type = 'EOD_DIGEST') = 1, 'EOD digest enqueued exactly once per day');
SELECT t.ok((SELECT short_base FROM fin.v_transfer_shortages) = 2, 'transit shortage of 2 pcs recorded');
SELECT t.ok((SELECT count(*) FROM audit_log WHERE table_name = 'public.stock_overrides') = 1, 'override usage audited');
SELECT t.ok(NOT EXISTS (
  SELECT 1 FROM pg_tables WHERE schemaname IN ('public','fin','secure') AND NOT rowsecurity), 'RLS enabled on every table');
SELECT t.ok(NOT EXISTS (
  SELECT 1 FROM information_schema.role_table_grants WHERE grantee = 'anon' AND table_schema IN ('public','fin','secure')),
  'anon has no table privileges at all');
SELECT t.ok(NOT EXISTS (
  SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname IN ('public','app','fin') AND has_function_privilege('anon', p.oid, 'EXECUTE')),
  'anon can execute no app functions');

UPDATE dispatches SET created_at = now() - interval '1 day' WHERE id = (:'d1'::jsonb->>'id')::uuid;
:AS_EMPA
SELECT t.ok((SELECT count(*) FROM dispatches) = 1, 'yesterday''s entries drop out of the employee''s daily view');
RESET ROLE;
UPDATE users SET is_active = false WHERE id = :EMPA;
:AS_EMPA
SELECT t.ok((SELECT count(*) FROM inventory_levels) = 0, 'deactivated user immediately sees nothing');
RESET ROLE;
UPDATE users SET is_active = true WHERE id = :EMPA;

DROP SCHEMA t CASCADE;
\echo '✓ ALL DATABASE TESTS PASSED'

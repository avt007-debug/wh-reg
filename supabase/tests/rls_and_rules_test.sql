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
SELECT t.throws($$SELECT public.owner_update_purchase(gen_random_uuid(), '{}'::jsonb)$$, 'WH002', 'employees cannot edit purchases');
SELECT t.throws($$SELECT public.owner_set_stock('a0000000-0000-0000-0000-000000000001', gen_random_uuid(), 5)$$, 'WH002', 'employees cannot set stock counts');
SELECT t.throws($$SELECT public.owner_purchases_month(current_date)$$, 'WH002', 'employees cannot open the purchase register');
SELECT t.throws($$SELECT public.owner_stock_list()$$, 'WH002', 'employees cannot open the owner stock list');

-- ---- Direct table writes (what a tampered app could send) are still sanitised.
BEGIN;
INSERT INTO purchases(id, client_txn_id, warehouse_id, vendor_id, vendor_invoice_no, vendor_invoice_date, is_interstate, created_by)
VALUES ('c0000000-0000-0000-0000-000000000001', gen_random_uuid(), :WHA,
        (SELECT id FROM vendors WHERE gstin = '29AAACW1234K1Z9'), 'KTD/2026/7781', app.today_ist() - 2, true, :OWNER);
INSERT INTO purchase_items(purchase_id, line_no, product_id, uom_code, conversion_factor, qty, gst_rate, unit_base_price, unit_incl_price)
VALUES ('c0000000-0000-0000-0000-000000000001', 1, (SELECT id FROM products WHERE sku_code = 'STN-CS-1724'),
        'BOX', 999, 10, 18, 3500, 4130);
COMMIT;
-- Staff purchases wait for the owner: no stock until approved.
SELECT t.ok((SELECT status::text FROM purchases WHERE id = 'c0000000-0000-0000-0000-000000000001') = 'PENDING'
            AND (SELECT qty_on_hand FROM inventory_levels il JOIN products p ON p.id = il.product_id
                  WHERE p.sku_code = 'STN-CS-1724') = 60, 'staff purchase is PENDING and adds no stock yet');
SELECT t.throws($$SELECT public.owner_approve_purchase('c0000000-0000-0000-0000-000000000001')$$, 'WH002', 'employees cannot approve purchases');
SELECT t.throws($$SELECT public.owner_pending_purchases()$$, 'WH002', 'employees cannot list pending approvals');
:AS_OWNER
SELECT t.ok((SELECT x->>'entered_by' FROM jsonb_array_elements(public.owner_pending_purchases()) x
              WHERE x->>'id' = 'c0000000-0000-0000-0000-000000000001') = (SELECT full_name FROM users WHERE id = :EMPA),
            'owner sees the pending purchase and who entered it');
SELECT t.ok(public.owner_approve_purchase('c0000000-0000-0000-0000-000000000001')->>'status' = 'POSTED', 'owner approves the purchase');
SELECT t.throws($$SELECT public.owner_approve_purchase('c0000000-0000-0000-0000-000000000001')$$, 'WH005', 'a purchase cannot be approved twice');
:AS_EMPA
SELECT t.ok((SELECT qty_on_hand FROM inventory_levels il JOIN products p ON p.id = il.product_id
              WHERE p.sku_code = 'STN-CS-1724') = 110, 'after approval: inward 10 BOX x 5 = 50 pcs (server-side UoM factor, spoofed 999 ignored)');
SELECT t.ok((SELECT created_by FROM purchases WHERE id = 'c0000000-0000-0000-0000-000000000001') = :EMPA,
            'created_by forced to the signed-in user');
SELECT t.ok((SELECT (taxable_total, cgst_total, sgst_total, igst_total, grand_total, is_interstate)
               = (35000.00, 3150.00, 3150.00, 0.00, 41300.00, false)
             FROM purchases WHERE id = 'c0000000-0000-0000-0000-000000000001'),
            'purchase totals + CGST/SGST split; is_interstate derived from GSTINs');
-- Even if an attacker could set the owner-edit flag, a non-owner still cannot add lines later.
SELECT set_config('app.editing_doc', 'c0000000-0000-0000-0000-000000000001', false);
SELECT t.throws($$INSERT INTO purchase_items(purchase_id, line_no, product_id, uom_code, conversion_factor, qty, gst_rate, unit_base_price, unit_incl_price)
                 VALUES ('c0000000-0000-0000-0000-000000000001', 9, (SELECT id FROM products WHERE sku_code = 'FIS-SX8'), 'PCS', 1, 1, 18, 1, 1.18)$$,
                'WH005', 'edit flag is useless to non-owners (lines still locked)');
SELECT set_config('app.editing_doc', '', false);

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
SELECT t.ok((:'p_r'::jsonb)->'purchase'->>'status' = 'PENDING', 'staff inward via RPC comes back as PENDING (waiting for the owner)');
:AS_OWNER
SELECT t.ok((SELECT count(*) FROM jsonb_array_elements(public.owner_pending_purchases()) x
              WHERE x->>'vendor_invoice_no' IN ('BCP-55120', 'KTD-PIN') AND x->>'status' = 'PENDING') = 2, 'both staff purchases await approval');
SELECT public.owner_approve_purchase((x->>'id')::uuid) FROM jsonb_array_elements(public.owner_pending_purchases()) x
 WHERE x->>'vendor_invoice_no' IN ('BCP-55120', 'KTD-PIN') \g /dev/null
:AS_EMPA

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

-- ---- Per-item discount, purchase register, purchase editing, stock counts
SELECT id AS spanner_line FROM purchase_items WHERE purchase_id = 'c0000000-0000-0000-0000-000000000001' \gset
SELECT t.ok(((public.owner_set_item_discount(:'spanner_line', 'PERCENT', 10, 'Scheme'))->>'net_payable')::numeric = 36050.00,
            'extra 10% item discount on top of 5% bill discount → net payable ₹36,050');
SELECT t.ok((SELECT (i->>'avgCost')::numeric FROM jsonb_array_elements((public.owner_stock_overview())->'items') i
              WHERE i->>'sku' = 'STN-CS-1724') = 595, 'net cost per spanner set now (35,000 − 3,500 − 1,750) ÷ 50 = ₹595');
SELECT t.ok(EXISTS (SELECT 1 FROM jsonb_array_elements(public.owner_purchases_month(app.today_ist() - 2)) x
                     WHERE x->>'vendor_invoice_no' = 'KTD/2026/7781' AND jsonb_array_length(x->'lines') = 1
                       AND (x->'lines'->0->>'item_discount_amount')::numeric = 3500
                       AND x->'lines'->0->>'sku_code' = 'STN-CS-1724'),
            'monthly purchase register lists the invoice with item code, name and item discount');
SELECT public.owner_update_purchase('c0000000-0000-0000-0000-000000000001', jsonb_build_object(
  'lorryReceiptNo', 'LR-991',
  'lines', jsonb_build_array(jsonb_build_object('productId', (SELECT id FROM products WHERE sku_code = 'STN-CS-1724'),
           'uomCode', 'BOX', 'qty', 8, 'gstRate', 18, 'unitBasePrice', 3500, 'unitInclPrice', 4130,
           'discountType', 'PERCENT', 'discountValue', 10)))) AS ed \gset
SELECT t.ok((:'ed'::jsonb->>'taxable_total')::numeric = 28000 AND (:'ed'::jsonb->>'grand_total')::numeric = 33040
            AND :'ed'::jsonb->>'lorry_receipt_no' = 'LR-991', 'purchase edited: 10 → 8 BOX, totals recomputed to ₹33,040');
SELECT t.ok((SELECT qty_on_hand FROM inventory_levels il JOIN products p ON p.id = il.product_id
              WHERE il.warehouse_id = :WHA AND p.sku_code = 'STN-CS-1724') = 100, 'stock re-posted after edit: 110 − 10 pcs = 100');
SELECT t.ok((:'ed'::jsonb->'lines'->0->>'item_discount_amount')::numeric = 2800
            AND (:'ed'::jsonb->>'net_payable')::numeric = 28840, 'item discount kept through the edit; net payable ₹28,840');
SELECT t.ok(((public.owner_set_stock(:WHA, (SELECT id FROM products WHERE sku_code = 'FIS-SX8'), 9000, 'ADJUST_AUDIT', 'cycle count'))->>'delta')::numeric = 999,
            'owner sets a stock count (8001 → 9000); difference posted');
SELECT t.ok((SELECT qty_on_hand FROM inventory_levels il JOIN products p ON p.id = il.product_id
              WHERE il.warehouse_id = :WHA AND p.sku_code = 'FIS-SX8') = 9000, 'stock count applied');
SELECT public.owner_set_purchase_discount('c0000000-0000-0000-0000-000000000001', 'PERCENT', 0);
SELECT t.ok(NOT EXISTS (SELECT 1 FROM jsonb_array_elements(public.owner_purchases_month(app.today_ist() - 2)) x
                             WHERE x->>'vendor_invoice_no' = 'KTD/2026/7781' AND (x->>'bill_discount_amount')::numeric <> 0),
            'bill discount can be cleared (0)');
SELECT t.ok((SELECT (x->'per_warehouse'->>'WHA')::numeric FROM jsonb_array_elements(public.owner_stock_list(:WHA)) x
              WHERE x->>'sku_code' = 'FIS-SX8') = 9000, 'owner stock list shows the warehouse count');
SELECT t.ok((SELECT count(*) FROM jsonb_array_elements(public.owner_stock_list(NULL, (SELECT id FROM brands WHERE name = 'Bosch'))) x)
            = (SELECT count(*) FROM products WHERE is_active AND brand_id = (SELECT id FROM brands WHERE name = 'Bosch')),
            'company (brand) filter returns only that company''s items');
SELECT t.ok(jsonb_array_length(public.owner_stock_list()) = (SELECT count(*) FROM products WHERE is_active),
            'no company selected → every active item, including zero stock');

-- =============================================================================
\echo '── Items, stock history, staff passwords, attendance, field work, employee reports'
:AS_OWNER
SELECT public.owner_save_product(jsonb_build_object('skuCode', 'tap-hm-500', 'name', 'Claw Hammer 500g', 'brandId', (SELECT id FROM brands WHERE name = 'Taparia'),
  'hsnCode', '8205', 'gstRate', 18, 'mrp', 590, 'sellingPrice', 500, 'reorderLevel', 12,
  'packs', jsonb_build_array(jsonb_build_object('code', 'BOX', 'factor', 6)),
  'openingStock', jsonb_build_array(jsonb_build_object('warehouseId', :WHA, 'qty', 30)))) ->> 'id' AS hm \gset
SELECT t.ok((SELECT sku_code FROM products WHERE id = :'hm') = 'TAP-HM-500'
            AND (SELECT count(*) FROM product_uoms WHERE product_id = :'hm') = 2, 'owner adds an item (code upper-cased, base + BOX pack)');
SELECT t.ok((SELECT qty_on_hand FROM inventory_levels WHERE product_id = :'hm' AND warehouse_id = :WHA) = 30, 'opening stock posted for the new item');
SELECT t.throws($$SELECT public.owner_save_product(jsonb_build_object('skuCode', 'TAP-HM-500', 'name', 'Dup', 'gstRate', 18))$$, 'WH005', 'duplicate item code refused');
SELECT t.throws($$SELECT public.owner_save_product(jsonb_build_object('skuCode', 'X-1', 'name', 'Bad HSN', 'gstRate', 18, 'hsnCode', '12'))$$, 'WH005', 'bad HSN refused');
SELECT public.owner_save_product(jsonb_build_object('id', :'hm', 'skuCode', 'TAP-HM-500', 'name', 'Claw Hammer 500 g', 'hsnCode', '820520', 'gstRate', 5,
  'mrp', 525, 'sellingPrice', 500, 'packs', '[]'::jsonb)) \g /dev/null
SELECT t.ok((SELECT name || '|' || hsn_code || '|' || default_gst_rate FROM products WHERE id = :'hm') = 'Claw Hammer 500 g|820520|5.00'
            AND (SELECT count(*) FROM product_uoms WHERE product_id = :'hm') = 1, 'owner edits name, HSN, GST and removes the pack');
SELECT t.ok((SELECT x->>'entered_by' FROM jsonb_array_elements(public.owner_stock_history(:'hm')) x LIMIT 1) = 'Business Owner',
            'stock history shows who entered the stock');
SELECT t.ok((SELECT x->>'entered_by' FROM jsonb_array_elements(public.owner_stock_history((SELECT id FROM products WHERE sku_code = 'STN-CS-1724'), :WHA)) x
              WHERE x->>'movement' = 'PURCHASE_IN' LIMIT 1) = (SELECT full_name FROM users WHERE id = :EMPA),
            'an approved staff purchase is credited to the employee who entered it');
SELECT t.ok((SELECT x->'last_entry'->>'by' FROM jsonb_array_elements(public.owner_stock_list(:WHA)) x WHERE x->>'sku_code' = 'TAP-HM-500') = 'Business Owner',
            'stock list shows the last person who entered stock');
SELECT public.owner_reject_purchase(id, 'wrong bill') FROM purchases WHERE false \g /dev/null

-- staff passwords: written by the Edge Function (service role), read only by owners
RESET ROLE; SET ROLE service_role;
SELECT public.svc_store_staff_password(:EMPA, 'Ravi2026pass');
SELECT public.svc_store_staff_password(:EMPA, 'Ravi2027pass');
:AS_OWNER
SELECT t.ok(public.owner_staff_password(:EMPA) = 'Ravi2027pass', 'owner can look up the password they last set');
SELECT t.ok((SELECT (x->>'has_saved_password')::boolean FROM jsonb_array_elements(public.owner_list_users()) x WHERE x->>'id' = :EMPA),
            'user list marks saved passwords');
SELECT t.throws($$SELECT public.owner_staff_password('00000000-0000-0000-0000-000000000001')$$, 'WH002', 'owner passwords are never stored or shown');
SELECT t.throws($$SELECT public.svc_store_staff_password('00000000-0000-0000-0000-000000000010', 'x')$$, '42501', 'the app cannot write passwords directly');

-- attendance + field work as an employee
:AS_EMPA
SELECT t.throws($$SELECT public.owner_staff_password('00000000-0000-0000-0000-000000000010')$$, 'WH002', 'employees cannot see passwords');
SELECT t.throws($$SELECT * FROM attendance$$, '42501', 'attendance table is not directly readable');
SELECT t.ok((public.clock_in('reached shop'))->>'clock_out_at' IS NULL, 'employee clocks in');
SELECT t.throws($$SELECT public.clock_in()$$, 'WH005', 'cannot clock in twice');
SELECT t.ok((public.my_attendance())->'open' IS NOT NULL, 'my_attendance shows the open shift');
SELECT t.ok((public.clock_out())->>'clock_out_at' IS NOT NULL, 'employee clocks out');
SELECT t.throws($$SELECT public.clock_out()$$, 'WH005', 'cannot clock out when not clocked in');
SELECT t.ok(jsonb_array_length((public.log_market_run(jsonb_build_object('place', 'Puttur', 'notes', 'weekly round',
  'visits', jsonb_build_array(jsonb_build_object('customerName', 'Sri Lakshmi Hardware', 'phone', '98480 12345', 'outcome', 'ORDER'),
                              jsonb_build_object('customerName', 'Balaji Traders', 'outcome', 'INTERESTED'))))) -> 'visits') = 2,
            'employee logs a market run to Puttur with 2 customers');
SELECT public.log_market_run(jsonb_build_object('place', 'puttur ')) \g /dev/null
SELECT public.log_market_run(jsonb_build_object('place', 'Nagari')) \g /dev/null
SELECT public.add_customer_visit(jsonb_build_object('customerName', 'Walk-in contractor', 'place', 'Chittoor', 'outcome', 'FOLLOW_UP'));
SELECT t.ok(jsonb_array_length((public.my_field_month())->'runs') = 3 AND jsonb_array_length((public.my_field_month())->'loose_visits') = 1,
            'my_field_month lists runs and stand-alone customers');
:AS_EMPB
SELECT t.ok(jsonb_array_length((public.my_field_month())->'runs') = 0, 'employees only see their own field work');
SELECT t.throws($$SELECT public.owner_employees_month(current_date)$$, 'WH002', 'employees cannot open the employee report');

:AS_OWNER
SELECT t.ok((SELECT (x->'stats'->>'market_runs')::int = 3 AND (x->'stats'->>'places')::int = 2 AND (x->'stats'->>'customers_approached')::int = 3
                    AND (x->'stats'->>'days_present')::int = 1
               FROM jsonb_array_elements(public.owner_employees_month(app.today_ist())) x WHERE x->>'id' = :EMPA),
            'monthly report: 3 runs, 2 places, 3 customers, 1 day present');
SELECT t.ok((SELECT (x->>'runs')::int FROM jsonb_array_elements((public.owner_employee_month(:EMPA, app.today_ist()))->'places') x
              WHERE lower(x->>'place') = 'puttur') = 2, 'runs are counted per place (Puttur twice, case/space-insensitive)');
SELECT t.ok(jsonb_array_length((public.owner_employee_month(:EMPA, app.today_ist()))->'trend') = 6, 'six-month performance trend');
SELECT public.owner_fix_attendance(((public.owner_employee_month(:EMPA, app.today_ist()))->'attendance'->0->>'id')::uuid,
                                   app.today_ist_start() + interval '9 hours', app.today_ist_start() + interval '18 hours');
SELECT t.ok((SELECT (x->>'hours')::numeric FROM jsonb_array_elements((public.owner_employee_month(:EMPA, app.today_ist()))->'attendance') x LIMIT 1) = 9,
            'owner corrects a shift (09:00–18:00 = 9 h)');

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

\echo '── Sales bills: typed invoice no, new customer, ₹ discount, MRP, GST vs Non-GST'
:AS_EMPA
SELECT public.create_dispatch(jsonb_build_object('clientTxnId', gen_random_uuid(), 'invoiceNo', 'ctr-b-101',
  'newCustomer', jsonb_build_object('name', 'Venkat Traders', 'gstin', '37AAPFV1234K1ZS', 'phone', '98480 11111'),
  'lines', jsonb_build_array(
    jsonb_build_object('productId', (SELECT id FROM products WHERE sku_code = 'FIS-SX8'), 'uomCode', 'PCS', 'qty', 10,
                       'unitBasePrice', 2, 'gstRate', 18, 'discountAmount', 2, 'mrp', 3, 'hsnCode', '3926'),
    jsonb_build_object('productId', (SELECT id FROM products WHERE sku_code = 'TAP-SD-903'), 'uomCode', 'PCS', 'qty', 1,
                       'unitBasePrice', 300, 'gstRate', 0, 'hsnCode', '8205')))) -> 'dispatch' AS sb \gset
SELECT t.ok(:'sb'::jsonb->>'invoice_no' = 'CTR-B-101' AND :'sb'::jsonb->>'customer_gstin' = '37AAPFV1234K1ZS',
            'typed invoice number kept (upper-cased); new customer with GSTIN created on the bill');
SELECT t.ok((:'sb'::jsonb->>'taxable_total')::numeric = 318 AND (:'sb'::jsonb->>'grand_total')::numeric = 321.24
            AND (:'sb'::jsonb->>'discount_total')::numeric = 2,
            '₹2 discount on 10 × ₹2 at 18% (=₹21.24) + ₹300 at 0% → ₹321.24');
SELECT t.ok((public.create_dispatch(jsonb_build_object('clientTxnId', gen_random_uuid(),
  'newCustomer', jsonb_build_object('name', 'venkat traders ltd', 'gstin', '37aapfv1234k1zs'),
  'lines', jsonb_build_array(jsonb_build_object('productId', (SELECT id FROM products WHERE sku_code = 'FIS-SX8'),
                             'uomCode', 'PCS', 'qty', 1, 'unitBasePrice', 2)))) -> 'dispatch' ->> 'customer_name') = 'Venkat Traders',
            'same GSTIN reuses the existing customer; blank invoice number is auto-numbered');
SELECT t.throws($$SELECT public.create_dispatch(jsonb_build_object('clientTxnId', gen_random_uuid(), 'invoiceNo', 'CTR-B-101',
  'newCustomer', jsonb_build_object('name', 'X Y'), 'lines', jsonb_build_array(jsonb_build_object(
  'productId', (SELECT id FROM products WHERE sku_code = 'FIS-SX8'), 'uomCode', 'PCS', 'qty', 1, 'unitBasePrice', 2))))$$,
  '23505', 'the same invoice number cannot be used twice');
SELECT t.throws($$SELECT public.create_dispatch(jsonb_build_object('clientTxnId', gen_random_uuid(),
  'newCustomer', jsonb_build_object('name', 'Bad GST', 'gstin', '37AAPFV1234K1ZZ'), 'lines', jsonb_build_array(jsonb_build_object(
  'productId', (SELECT id FROM products WHERE sku_code = 'FIS-SX8'), 'uomCode', 'PCS', 'qty', 1, 'unitBasePrice', 2))))$$,
  'WH005', 'an invalid customer GST number is refused');
SELECT t.throws($$SELECT public.create_dispatch(jsonb_build_object('clientTxnId', gen_random_uuid(),
  'newCustomer', jsonb_build_object('name', 'Too Much Off'), 'lines', jsonb_build_array(jsonb_build_object(
  'productId', (SELECT id FROM products WHERE sku_code = 'FIS-SX8'), 'uomCode', 'PCS', 'qty', 1, 'unitBasePrice', 2, 'discountAmount', 5))))$$,
  '23514', 'discount cannot be more than the line value');
SELECT t.throws($$SELECT public.owner_sales_month(current_date)$$, 'WH002', 'employees cannot open the sales register');
SELECT t.throws($$SELECT public.owner_attendance_today()$$, 'WH002', 'employees cannot see everyone''s attendance');

:AS_OWNER
SELECT t.ok((SELECT (x->>'entered_by') = (SELECT full_name FROM users WHERE id = :EMPA)
                    AND (SELECT sum((l->>'line_total')::numeric) FROM jsonb_array_elements(x->'lines') l WHERE (l->>'gst_rate')::numeric = 0) = 300
                    AND (SELECT sum((l->>'line_total')::numeric) FROM jsonb_array_elements(x->'lines') l WHERE (l->>'gst_rate')::numeric > 0) = 21.24
               FROM jsonb_array_elements(public.owner_sales_month(app.today_ist())) x WHERE x->>'invoice_no' = 'CTR-B-101'),
            'sales register: who entered it; ₹21.24 GST-billed and ₹300 Non-GST-billed');
SELECT t.ok((SELECT x->'lines'->0->>'mrp' FROM jsonb_array_elements(public.owner_sales_month(app.today_ist())) x WHERE x->>'invoice_no' = 'CTR-B-101') = '3.00',
            'MRP stored on the sales line');
SELECT public.create_purchase(jsonb_build_object('clientTxnId', gen_random_uuid(), 'warehouseId', :WHA,
  'vendorId', (SELECT id FROM vendors WHERE gstin = '29AAACW1234K1Z9'), 'vendorInvoiceNo', 'DISC-1', 'vendorInvoiceDate', app.today_ist(),
  'lines', jsonb_build_array(
    jsonb_build_object('productId', (SELECT id FROM products WHERE sku_code = 'FIS-SX8'), 'uomCode', 'PCS', 'qty', 10,
                       'gstRate', 18, 'unitBasePrice', 100, 'unitInclPrice', 118, 'discountAmount', 50, 'mrp', 150),
    jsonb_build_object('productId', (SELECT id FROM products WHERE sku_code = 'TAP-SD-903'), 'uomCode', 'PCS', 'qty', 2,
                       'gstRate', 0, 'unitBasePrice', 250, 'unitInclPrice', 250)))) -> 'purchase' AS pd \gset
SELECT t.ok((:'pd'::jsonb->>'taxable_total')::numeric = 1450 AND (:'pd'::jsonb->>'grand_total')::numeric = 1621,
            'purchase with ₹50 discount on a 18% line + a 0% line: taxable ₹1,450, total ₹1,621');
SELECT t.ok((SELECT (l->>'discount_amount')::numeric = 50 AND (l->>'mrp')::numeric = 150
               FROM jsonb_array_elements(public.owner_purchase_detail((:'pd'::jsonb->>'id')::uuid) -> 'lines') l WHERE (l->>'gst_rate')::numeric = 18),
            'purchase line keeps its discount amount and MRP');
SELECT t.ok((SELECT x->>'first_in' IS NOT NULL FROM jsonb_array_elements(public.owner_attendance_today()) x WHERE x->>'id' = :EMPA),
            'dashboard shows today''s clock-in for the employee');
SELECT t.ok((SELECT count(*) FROM jsonb_array_elements(public.owner_attendance_today(:WHB)) x WHERE x->>'id' = :EMPA) = 0,
            'today''s attendance follows the warehouse switch');

\echo '── Extra charges, discount %, new seller, credit notes'
:AS_EMPA
SELECT public.create_dispatch(jsonb_build_object('clientTxnId', gen_random_uuid(), 'newCustomer', jsonb_build_object('name', 'Charges Test'),
  'loadingCharges', 50, 'transportCharges', 200,
  'lines', jsonb_build_array(jsonb_build_object('productId', (SELECT id FROM products WHERE sku_code = 'TAP-SD-903'), 'uomCode', 'PCS',
           'qty', 2, 'unitBasePrice', 100, 'discountPct', 10, 'gstRate', 18)))) -> 'dispatch' AS ch \gset
SELECT t.ok((:'ch'::jsonb->>'grand_total')::numeric = 462.40,
            'sale: (2 × ₹100 − 10%) + 18% GST = ₹212.40, + loading ₹50 + transport ₹200 = ₹462.40');
SELECT public.create_purchase(jsonb_build_object('clientTxnId', gen_random_uuid(),
  'newVendor', jsonb_build_object('name', 'Sai Hardware Agencies', 'gstin', '37AAPFV1234K1ZS'),
  'vendorInvoiceNo', 'SAI-1', 'vendorInvoiceDate', app.today_ist(), 'loadingCharges', 30,
  'lines', jsonb_build_array(jsonb_build_object('productId', (SELECT id FROM products WHERE sku_code = 'TAP-SD-903'), 'uomCode', 'PCS',
           'qty', 10, 'unitBasePrice', 200, 'discountPct', 5, 'gstRate', 18, 'creditPct', 50)))) -> 'purchase' AS sp \gset
SELECT t.ok((:'sp'::jsonb->>'grand_total')::numeric = 2272 AND :'sp'::jsonb->>'vendor_name' = 'Sai Hardware Agencies',
            'staff purchase with a new seller: (10 × ₹200 − 5%) + 18% = ₹2,242 + loading ₹30 = ₹2,272');
SELECT t.throws($$SELECT public.owner_credit_summary()$$, 'WH002', 'employees cannot see credit notes');
SELECT t.throws($$SELECT * FROM fin.purchase_credit_notes$$, '42501', 'credit note table is not readable by staff');
:AS_OWNER
SELECT t.ok((public.owner_purchase_detail((:'sp'::jsonb->>'id')::uuid)->>'credit_total')::numeric = 0,
            'a staff-entered credit % is ignored (only the owner sets credit)');
SELECT public.owner_set_purchase_credits((:'sp'::jsonb->>'id')::uuid, NULL, 3);
SELECT public.owner_approve_purchase((:'sp'::jsonb->>'id')::uuid) \g /dev/null
SELECT t.ok((public.owner_purchase_detail((:'sp'::jsonb->>'id')::uuid)->>'credit_total')::numeric = 57,
            'owner sets 3% credit on the bill → ₹57 credit note (3% of ₹1,900 before GST)');
SELECT public.create_purchase(jsonb_build_object('clientTxnId', gen_random_uuid(), 'warehouseId', :WHA,
  'vendorId', (SELECT id FROM vendors WHERE gstin = '37AAPFV1234K1ZS'), 'vendorInvoiceNo', 'SAI-2', 'vendorInvoiceDate', app.today_ist(),
  'lines', jsonb_build_array(
    jsonb_build_object('productId', (SELECT id FROM products WHERE sku_code = 'FIS-SX8'), 'uomCode', 'PCS', 'qty', 100, 'unitBasePrice', 2, 'gstRate', 18, 'creditPct', 10),
    jsonb_build_object('productId', (SELECT id FROM products WHERE sku_code = 'TAP-SD-903'), 'uomCode', 'PCS', 'qty', 1, 'unitBasePrice', 100, 'gstRate', 18)))) -> 'purchase' AS op \gset
SELECT t.ok(:'op'::jsonb->>'status' = 'POSTED' AND (public.owner_purchase_detail((:'op'::jsonb->>'id')::uuid)->>'credit_total')::numeric = 20,
            'owner purchase: credit % per line saved with the bill (10% of ₹200 = ₹20)');
SELECT t.ok((SELECT (x->>'available')::numeric FROM jsonb_array_elements(public.owner_credit_summary()->'vendors') x WHERE x->>'gstin' = '37AAPFV1234K1ZS') = 77
            AND (SELECT jsonb_array_length(x->'items') FROM jsonb_array_elements(public.owner_credit_summary()->'vendors') x WHERE x->>'gstin' = '37AAPFV1234K1ZS') = 2,
            'credit available by seller (₹77) and by item (2 items)');
SELECT public.owner_use_credit(jsonb_build_object('vendorId', (SELECT id FROM vendors WHERE gstin = '37AAPFV1234K1ZS'), 'amount', 50, 'notes', 'adjusted in SAI-3'));
SELECT t.ok((SELECT (x->>'available')::numeric FROM jsonb_array_elements(public.owner_credit_summary()->'vendors') x WHERE x->>'gstin' = '37AAPFV1234K1ZS') = 27,
            'using ₹50 leaves ₹27 available');
SELECT t.throws($$SELECT public.owner_use_credit(jsonb_build_object('vendorId', (SELECT id FROM vendors WHERE gstin = '37AAPFV1234K1ZS'), 'amount', 100))$$,
            'WH005', 'cannot use more credit than is available');
SELECT public.owner_update_purchase((:'op'::jsonb->>'id')::uuid, jsonb_build_object('loadingCharges', 40, 'lines', jsonb_build_array(
    jsonb_build_object('productId', (SELECT id FROM products WHERE sku_code = 'FIS-SX8'), 'uomCode', 'PCS', 'qty', 100, 'unitBasePrice', 2,
                       'gstRate', 18, 'discountPct', 10, 'creditPct', 5)))) \g /dev/null
SELECT t.ok((public.owner_purchase_detail((:'op'::jsonb->>'id')::uuid)->>'credit_total')::numeric = 9
            AND (public.owner_purchase_detail((:'op'::jsonb->>'id')::uuid)->>'grand_total')::numeric = 252.40,
            'editing keeps credit % and discount %: (₹200 − 10%) + 18% + loading ₹40 = ₹252.40; credit 5% of ₹180 = ₹9');

\echo '── Customer ledger & payments'
:AS_OWNER
SELECT id AS lc FROM customers WHERE name = 'Charges Test' \gset
RESET ROLE;
UPDATE dispatches SET invoice_date = app.today_ist() - 40 WHERE customer_id = :'lc';
:AS_OWNER
SELECT public.create_dispatch(jsonb_build_object('clientTxnId', gen_random_uuid(), 'warehouseId', :WHA, 'customerId', :'lc',
  'lines', jsonb_build_array(jsonb_build_object('productId', (SELECT id FROM products WHERE sku_code = 'TAP-SD-903'), 'uomCode', 'PCS',
           'qty', 1, 'unitBasePrice', 100, 'gstRate', 0)))) \g /dev/null
:AS_EMPB
SELECT t.ok((public.record_customer_payment(jsonb_build_object('customerId', :'lc', 'amount', 200, 'mode', 'UPI', 'reference', 'UTR123'))->>'balance')::numeric = 362.40,
            'any employee records a payment; balance = ₹462.40 + ₹100 − ₹200 = ₹362.40');
SELECT t.throws($$SELECT public.record_customer_payment(jsonb_build_object('customerId', (SELECT id FROM customers LIMIT 1), 'amount', 10, 'paidOn', app.today_ist() + 1))$$,
            'WH005', 'payment date cannot be in the future');
SELECT t.throws($$SELECT public.owner_ledger()$$, 'WH002', 'employees cannot open the owner ledger');
SELECT t.ok((SELECT (x->>'balance')::numeric FROM jsonb_array_elements(public.my_ledger()->'customers') x WHERE x->>'customer_id' = :'lc') = 362.40,
            'employee ledger shows the customer''s pending balance');
SELECT t.ok(jsonb_array_length(public.customer_statement(:'lc')->'entries') = 3, 'statement: 2 bills + 1 payment');
:AS_EMPA
SELECT t.ok((SELECT (x->>'outstanding')::numeric FROM jsonb_array_elements(public.my_ledger()->'my_bills') x WHERE (x->>'days_old')::int = 40) = 262.40,
            'the old bill is paid first (FIFO): ₹462.40 − ₹200 = ₹262.40 still due on the bill Ravi entered');
:AS_OWNER
SELECT t.ok((SELECT (x->>'outstanding')::numeric = 262.40 AND x->>'responsible' = (SELECT full_name FROM users WHERE id = :EMPA)
               FROM jsonb_array_elements(public.owner_ledger()->'late') x WHERE x->>'customer_id' = :'lc'),
            'late payers: bill over 30 days, amount, and the employee responsible');
SELECT t.ok((SELECT (x->>'overdue')::numeric FROM jsonb_array_elements(public.owner_ledger()->'customers') x WHERE x->>'customer_id' = :'lc') = 262.40
            AND jsonb_array_length(public.owner_ledger()->'monthly') = 12 AND jsonb_array_length(public.owner_ledger()->'yearly') = 5,
            'owner ledger: overdue per customer, 12 months and 5 financial years');
SELECT t.ok((SELECT x->>'received_by' FROM jsonb_array_elements(public.owner_ledger()->'payments') x WHERE x->>'reference' = 'UTR123')
            = (SELECT full_name FROM users WHERE id = :EMPB), 'payments show who received them');

-- =============================================================================
\echo '── Platform checks (as postgres)'
-- =============================================================================
RESET ROLE;
SELECT t.ok((SELECT status FROM notification_outbox WHERE provider_message_id = 'wamid.TEST') = 'DELIVERED', 'delivery webhook marks DELIVERED');
SELECT app.enqueue_eod_digest(); SELECT app.enqueue_eod_digest();
SELECT t.ok((SELECT count(*) FROM notification_outbox WHERE event_type = 'EOD_DIGEST') = 1, 'EOD digest enqueued exactly once per day');
SELECT t.ok((SELECT short_base FROM fin.v_transfer_shortages) = 2, 'transit shortage of 2 pcs recorded');
SELECT t.ok((SELECT count(*) FROM audit_log WHERE table_name = 'public.stock_overrides') = 1, 'override usage audited');
SELECT t.ok((SELECT count(*) FROM audit_log WHERE action = 'EDIT' AND row_id = 'c0000000-0000-0000-0000-000000000001') = 1,
            'purchase edit audited (before/after kept)');
SELECT t.ok((SELECT count(*) FROM audit_log WHERE table_name = 'fin.purchase_item_discounts') >= 2, 'item discounts audited');
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
SELECT t.ok(NOT EXISTS (SELECT 1 FROM dispatches WHERE id = (:'d1'::jsonb->>'id')::uuid) AND EXISTS (SELECT 1 FROM dispatches),
            'yesterday''s entries drop out of the employee''s daily view');
RESET ROLE;
UPDATE users SET is_active = false WHERE id = :EMPA;
:AS_EMPA
SELECT t.ok((SELECT count(*) FROM inventory_levels) = 0, 'deactivated user immediately sees nothing');
RESET ROLE;
UPDATE users SET is_active = true WHERE id = :EMPA;

DROP SCHEMA t CASCADE;
\echo '✓ ALL DATABASE TESTS PASSED'

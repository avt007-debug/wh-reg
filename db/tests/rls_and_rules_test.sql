-- =============================================================================
-- rls_and_rules_test.sql
-- End-to-end tests for RLS isolation, financial lockout, stock safeguard,
-- override PIN, GST maths, transfers, and owner analytics.
--
-- Run against a FRESH database (migrated + seeded):
--   ./db/test.sh
-- Any failure stops the script with a non-zero exit code.
-- =============================================================================
\set ON_ERROR_STOP on
\set QUIET on
\o /dev/null
SET client_min_messages = notice;

-- ---- tiny assertion helpers ------------------------------------------------
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

-- Convenience ids
\set WHA '''a0000000-0000-0000-0000-000000000001'''
\set WHB '''a0000000-0000-0000-0000-000000000002'''
\set OWNER '''00000000-0000-0000-0000-000000000001'''
\set EMPA '''00000000-0000-0000-0000-000000000010'''
\set EMPB '''00000000-0000-0000-0000-000000000011'''

-- =============================================================================
\echo '── Employee A (WHA): isolation & lockout'
-- =============================================================================
SET ROLE app_employee;
SELECT set_config('app.user_id', :EMPA, false);

SELECT t.ok((SELECT count(*) FROM inventory_levels) = 4
        AND NOT EXISTS (SELECT 1 FROM inventory_levels WHERE warehouse_id <> :WHA),
        'employee sees stock of own warehouse only');
SELECT t.ok((SELECT count(*) FROM users) = 1, 'employee sees only own user row');
SELECT t.throws('SELECT * FROM fin.purchase_discounts', '42501', 'fin.* schema is invisible to employees');
SELECT t.throws('SELECT * FROM fin.v_sales_daily', '42501', 'owner analytics views are invisible');
SELECT t.throws('SELECT * FROM notification_outbox', '42501', 'outbox not readable by employees');
SELECT t.throws('SELECT * FROM audit_log', '42501', 'audit log not readable by employees');
SELECT t.throws('SELECT * FROM auth.credentials', '42501', 'password hashes not readable by employees');
SELECT t.throws($$SELECT app.apply_movement('a0000000-0000-0000-0000-000000000001', (SELECT id FROM products LIMIT 1),
                 'ADJUST_FOUND', 1000, 'x', gen_random_uuid(), gen_random_uuid())$$,
                '42501', 'internal stock function cannot be called directly');
SELECT t.throws($$INSERT INTO stock_adjustments(warehouse_id, product_id, movement, qty_delta_base)
                 VALUES ('a0000000-0000-0000-0000-000000000001', (SELECT id FROM products LIMIT 1), 'ADJUST_FOUND', 5)$$,
                '42501', 'employees cannot adjust stock');
SELECT t.throws($$UPDATE inventory_levels SET qty_on_hand = 99999$$, '42501', 'employees cannot write stock levels');
SELECT t.throws($$SELECT app.cancel_dispatch(gen_random_uuid(), 'x')$$, '42501', 'employees cannot cancel invoices');

-- ---- INWARD (intra-state KA vendor -> CGST+SGST) ---------------------------
-- Client tries to spoof: conversion_factor 999 and created_by = owner. Both must be ignored.
BEGIN;
INSERT INTO purchases(id, client_txn_id, warehouse_id, vendor_id, vendor_invoice_no, vendor_invoice_date, is_interstate, created_by)
VALUES ('c0000000-0000-0000-0000-000000000001', gen_random_uuid(), :WHA,
        (SELECT id FROM vendors WHERE gstin = '29AAACW1234K1Z9'), 'KTD/2026/7781', app.today_ist() - 2, true, :OWNER);
INSERT INTO purchase_items(purchase_id, line_no, product_id, uom_code, conversion_factor, qty, gst_rate, unit_base_price, unit_incl_price)
VALUES ('c0000000-0000-0000-0000-000000000001', 1, (SELECT id FROM products WHERE sku_code = 'STN-CS-1724'),
        'BOX', 999, 10, 18, 3500, 4130);
COMMIT;

SELECT t.ok((SELECT qty_on_hand FROM inventory_levels il JOIN products p ON p.id = il.product_id
              WHERE p.sku_code = 'STN-CS-1724') = 110, 'inward 10 BOX x 5 = 50 pcs added (server-side UoM factor)');
SELECT t.ok((SELECT created_by FROM purchases WHERE id = 'c0000000-0000-0000-0000-000000000001') = :EMPA,
            'created_by is forced to the logged-in user');
SELECT t.ok((SELECT (taxable_total, cgst_total, sgst_total, igst_total, grand_total, is_interstate)
               = (35000.00, 3150.00, 3150.00, 0.00, 41300.00, false)
             FROM purchases WHERE id = 'c0000000-0000-0000-0000-000000000001'),
            'purchase totals + CGST/SGST split computed at commit; is_interstate derived from GSTINs');

-- Inter-state vendor (MH -> KA) => IGST
BEGIN;
INSERT INTO purchases(id, client_txn_id, warehouse_id, vendor_id, vendor_invoice_no, vendor_invoice_date, is_interstate)
VALUES ('c0000000-0000-0000-0000-000000000002', gen_random_uuid(), :WHA,
        (SELECT id FROM vendors WHERE gstin = '27AADCB2230M1ZT'), 'BCP-55120', app.today_ist(), false);
INSERT INTO purchase_items(purchase_id, line_no, product_id, uom_code, conversion_factor, qty, gst_rate, unit_base_price, unit_incl_price)
VALUES ('c0000000-0000-0000-0000-000000000002', 1, (SELECT id FROM products WHERE sku_code = 'BOS-GSB13RE'),
        'PCS', 1, 5, 18, 2711.8644, 3200);           -- entered as inclusive ₹3,200 -> base back-calculated
COMMIT;
SELECT t.ok((SELECT igst_total = 2440.68 AND cgst_total = 0 AND grand_total = 16000.00 FROM purchases
              WHERE id = 'c0000000-0000-0000-0000-000000000002'), 'inter-state purchase uses IGST');

SELECT t.throws($$INSERT INTO purchases(client_txn_id, warehouse_id, vendor_id, vendor_invoice_no, vendor_invoice_date, is_interstate)
                 VALUES (gen_random_uuid(), 'a0000000-0000-0000-0000-000000000002', (SELECT id FROM vendors LIMIT 1), 'X1', current_date, false)$$,
                '42501', 'employee cannot post inward into another warehouse');

DO $$ BEGIN
  BEGIN
    INSERT INTO purchases(id, client_txn_id, warehouse_id, vendor_id, vendor_invoice_no, vendor_invoice_date, is_interstate)
    VALUES ('c0000000-0000-0000-0000-0000000000ff', gen_random_uuid(), 'a0000000-0000-0000-0000-000000000001',
            (SELECT id FROM vendors LIMIT 1), 'BAD-GST', current_date, false);
    INSERT INTO purchase_items(purchase_id, line_no, product_id, uom_code, conversion_factor, qty, gst_rate, unit_base_price, unit_incl_price)
    VALUES ('c0000000-0000-0000-0000-0000000000ff', 1, (SELECT id FROM products LIMIT 1), 'PCS', 1, 1, 18, 100, 112);
    RAISE EXCEPTION 'should not reach' USING ERRCODE = 'T0001';
  EXCEPTION WHEN check_violation THEN RAISE NOTICE 'PASS: base/inclusive price mismatch rejected (23514)';
  END;
END $$;

DO $$ BEGIN
  BEGIN
    INSERT INTO purchases(id, client_txn_id, warehouse_id, vendor_id, vendor_invoice_no, vendor_invoice_date, is_interstate)
    VALUES ('c0000000-0000-0000-0000-0000000000fe', gen_random_uuid(), 'a0000000-0000-0000-0000-000000000001',
            (SELECT id FROM vendors LIMIT 1), 'BAD-SLAB', current_date, false);
    INSERT INTO purchase_items(purchase_id, line_no, product_id, uom_code, conversion_factor, qty, gst_rate, unit_base_price, unit_incl_price)
    VALUES ('c0000000-0000-0000-0000-0000000000fe', 1, (SELECT id FROM products LIMIT 1), 'PCS', 1, 1, 15, 100, 115);
    RAISE EXCEPTION 'should not reach' USING ERRCODE = 'T0001';
  EXCEPTION WHEN foreign_key_violation THEN RAISE NOTICE 'PASS: non-existent GST slab (15%%) rejected';
  END;
END $$;

-- ---- OUTWARD: stock safeguard ---------------------------------------------
DO $$ BEGIN
  BEGIN
    INSERT INTO dispatches(id, client_txn_id, warehouse_id, customer_id, transport_mode, vehicle_reg_no)
    VALUES ('d0000000-0000-0000-0000-000000000001', gen_random_uuid(), 'a0000000-0000-0000-0000-000000000001',
            (SELECT id FROM customers WHERE gstin = '29AABCS5678L1ZM'), 'TRANSPORTER', 'KA 01 AB 1234');
    INSERT INTO dispatch_items(dispatch_id, line_no, product_id, uom_code, conversion_factor, qty, unit_base_price)
    VALUES ('d0000000-0000-0000-0000-000000000001', 1, (SELECT id FROM products WHERE sku_code = 'BOS-GSB13RE'), 'PCS', 1, 40, 3200);
    RAISE EXCEPTION 'should not reach' USING ERRCODE = 'T0001';
  EXCEPTION WHEN SQLSTATE 'WH001' THEN RAISE NOTICE 'PASS: dispatch of 40 drills blocked (only 30 in stock)';
  END;
END $$;

SELECT t.ok(app.request_stock_override('000000', :WHA, 'test') IS NULL, 'wrong PIN gives no override');
SELECT app.request_stock_override('246810', :WHA, 'Urgent dealer order, stock arriving tomorrow') AS ovr \gset
SELECT t.ok(:'ovr' IS NOT NULL, 'correct PIN issues a single-use override grant');

BEGIN;
INSERT INTO dispatches(id, client_txn_id, warehouse_id, customer_id, sales_agent_id, transport_mode,
                       vehicle_reg_no, driver_phone, transporter_name, invoice_date, override_id)
VALUES ('d0000000-0000-0000-0000-000000000001', gen_random_uuid(), :WHA,
        (SELECT id FROM customers WHERE gstin = '29AABCS5678L1ZM'),
        (SELECT id FROM sales_agents WHERE name LIKE 'Manjunath%'),
        'TRANSPORTER', 'ka-01-ab-1234', '+91 98450 12345', 'VRL Logistics',
        app.today_ist() - 30,                                  -- attempt to back-date
        :'ovr');
INSERT INTO dispatch_items(dispatch_id, line_no, product_id, uom_code, conversion_factor, qty, unit_base_price, discount_pct)
VALUES ('d0000000-0000-0000-0000-000000000001', 1, (SELECT id FROM products WHERE sku_code = 'BOS-GSB13RE'), 'PCS', 1, 40, 3200, 5),
       ('d0000000-0000-0000-0000-000000000001', 2, (SELECT id FROM products WHERE sku_code = 'FIS-SX8'), 'CTN', 1, 1, 3600, 0);  -- price is per CTN
COMMIT;

SELECT t.ok((SELECT qty_on_hand FROM inventory_levels il JOIN products p ON p.id = il.product_id
              WHERE p.sku_code = 'BOS-GSB13RE') = -10, 'override allowed dispatch beyond stock (now -10)');
SELECT t.ok((SELECT qty_on_hand FROM inventory_levels il JOIN products p ON p.id = il.product_id
              WHERE p.sku_code = 'FIS-SX8') = 8000, '1 CTN of plugs = 2000 pcs deducted');
SELECT t.ok((SELECT (invoice_date, vehicle_reg_no, driver_phone, is_interstate)
               = (app.today_ist(), 'KA01AB1234', '9845012345', false)
             FROM dispatches WHERE id = 'd0000000-0000-0000-0000-000000000001'),
            'staff cannot back-date; vehicle no. & phone normalised; intra-state');
-- 40 x 3200 x 95% = 121600 ; plugs 2000 x 1.80 = 3600 ; taxable 125200 ; GST 18% = 22536
SELECT t.ok((SELECT (taxable_total, discount_total, cgst_total, sgst_total, grand_total)
               = (125200.00, 6400.00, 11268.00, 11268.00, 147736.00)
             FROM dispatches WHERE id = 'd0000000-0000-0000-0000-000000000001'),
            'dispatch: discount, taxable, CGST/SGST and invoice value correct');
SELECT t.ok((SELECT invoice_no FROM dispatches WHERE id = 'd0000000-0000-0000-0000-000000000001')
             = 'WHA/' || app.fy_label(app.today_ist()) || '/00001', 'invoice number auto-generated per warehouse & FY');

DO $$ BEGIN
  BEGIN
    INSERT INTO dispatches(id, client_txn_id, warehouse_id, customer_id, transport_mode, override_id)
    VALUES ('d0000000-0000-0000-0000-000000000002', gen_random_uuid(), 'a0000000-0000-0000-0000-000000000001',
            (SELECT id FROM customers LIMIT 1), 'CUSTOMER_PICKUP',
            (SELECT id FROM stock_overrides ORDER BY created_at DESC LIMIT 1));
    INSERT INTO dispatch_items(dispatch_id, line_no, product_id, uom_code, conversion_factor, qty, unit_base_price)
    VALUES ('d0000000-0000-0000-0000-000000000002', 1, (SELECT id FROM products WHERE sku_code = 'BOS-GSB13RE'), 'PCS', 1, 1, 3200);
    RAISE EXCEPTION 'should not reach' USING ERRCODE = 'T0001';
  EXCEPTION WHEN SQLSTATE 'WH001' THEN RAISE NOTICE 'PASS: a consumed override cannot be reused';
  END;
END $$;

-- Inter-state sale (KA warehouse -> TN dealer) => IGST
BEGIN;
INSERT INTO dispatches(id, client_txn_id, warehouse_id, customer_id, transport_mode, vehicle_reg_no)
VALUES ('d0000000-0000-0000-0000-000000000003', gen_random_uuid(), :WHA,
        (SELECT id FROM customers WHERE gstin = '33AACCT4321M1ZF'), 'OWN_VEHICLE', 'KA05MN4321');
INSERT INTO dispatch_items(dispatch_id, line_no, product_id, uom_code, conversion_factor, qty, unit_base_price)
VALUES ('d0000000-0000-0000-0000-000000000003', 1, (SELECT id FROM products WHERE sku_code = 'TAP-SD-903'), 'CTN', 1, 2, 7440);
COMMIT;
SELECT t.ok((SELECT is_interstate AND igst_total = 2678.40 AND grand_total = 17558.40 FROM dispatches
              WHERE id = 'd0000000-0000-0000-0000-000000000003'), 'inter-state sale uses IGST');

SELECT t.throws($$INSERT INTO dispatch_items(dispatch_id, line_no, product_id, uom_code, conversion_factor, qty, unit_base_price)
                 VALUES ('d0000000-0000-0000-0000-000000000003', 2, (SELECT id FROM products LIMIT 1), 'PCS', 1, 1, 1)$$,
                'WH005', 'lines cannot be added to an already-committed invoice');
SELECT t.throws($$UPDATE dispatches SET grand_total = 1$$, '42501', 'employees cannot edit invoices');
SELECT t.ok((SELECT count(*) FROM dispatches) = 2, 'employee sees own dispatches from today');

-- ---- Transfer note WHA -> WHB ----------------------------------------------
BEGIN;
INSERT INTO transfer_notes(id, client_txn_id, from_warehouse_id, to_warehouse_id, vehicle_reg_no)
VALUES ('e0000000-0000-0000-0000-000000000001', gen_random_uuid(), :WHA, :WHB, 'KA01TT0001');
INSERT INTO transfer_note_items(transfer_note_id, line_no, product_id, uom_code, conversion_factor, qty)
VALUES ('e0000000-0000-0000-0000-000000000001', 1, (SELECT id FROM products WHERE sku_code = 'TAP-SD-903'), 'PCS', 1, 20);
COMMIT;
SELECT t.throws($$SELECT app.receive_transfer('e0000000-0000-0000-0000-000000000001')$$, 'WH002',
                'source warehouse cannot receive its own transfer');
SELECT app.dispatch_transfer('e0000000-0000-0000-0000-000000000001');
SELECT t.ok((SELECT qty_on_hand FROM inventory_levels il JOIN products p ON p.id = il.product_id
              WHERE p.sku_code = 'TAP-SD-903') = 172, 'transfer out: 240 - 48 sold - 20 moved = 172');
SELECT t.throws($$INSERT INTO transfer_notes(client_txn_id, from_warehouse_id, to_warehouse_id)
                 VALUES (gen_random_uuid(), 'a0000000-0000-0000-0000-000000000002', 'a0000000-0000-0000-0000-000000000001')$$,
                '42501', 'cannot raise a transfer out of someone else''s warehouse');

-- =============================================================================
\echo '── Employee B (WHB)'
-- =============================================================================
SELECT set_config('app.user_id', :EMPB, false);
SELECT t.ok((SELECT count(*) FROM dispatches) = 0 AND (SELECT count(*) FROM purchases) = 0,
            'employee B sees none of employee A''s transactions');
SELECT t.ok(NOT EXISTS (SELECT 1 FROM inventory_levels WHERE warehouse_id <> :WHB), 'employee B sees only WHB stock');
SELECT t.ok((SELECT qty_in_transit FROM inventory_levels il JOIN products p ON p.id = il.product_id
              WHERE p.sku_code = 'TAP-SD-903') = 20, 'destination sees 20 pcs in transit');
SELECT t.ok((SELECT count(*) FROM transfer_notes) = 1, 'destination warehouse can see inbound transfer note');
SELECT t.throws($$SELECT app.dispatch_transfer('e0000000-0000-0000-0000-000000000001')$$, 'WH002',
                'destination cannot dispatch someone else''s transfer');
SELECT app.receive_transfer('e0000000-0000-0000-0000-000000000001', '[{"line_no":1,"qty_received_base":18}]');
SELECT t.ok((SELECT (qty_on_hand, qty_in_transit) = (48.000, 0.000) FROM inventory_levels il JOIN products p ON p.id = il.product_id
              WHERE p.sku_code = 'TAP-SD-903'), 'received 18 of 20 (2 short recorded), in-transit cleared');

DO $$
DECLARE i int;
BEGIN
  FOR i IN 1..5 LOOP PERFORM app.request_stock_override('11111' || i, 'a0000000-0000-0000-0000-000000000002', 'guess'); END LOOP;
END $$;
SELECT t.throws($$SELECT app.request_stock_override('246810', 'a0000000-0000-0000-0000-000000000002', 'x')$$, 'WH003',
                'PIN locked after 5 wrong attempts in 15 minutes (even the right PIN)');
SELECT t.throws($$SELECT app.request_stock_override('246810', 'a0000000-0000-0000-0000-000000000001', 'x')$$, 'WH002',
                'cannot request an override for another warehouse');

-- =============================================================================
\echo '── API bug simulation: employee identity under the OWNER db role'
-- =============================================================================
RESET ROLE;
SET ROLE app_owner;
SELECT set_config('app.user_id', :EMPA, false);
SELECT t.ok((SELECT count(*) FROM fin.v_stock_overview) = 0 AND (SELECT count(*) FROM fin.purchase_discounts) = 0
            AND (SELECT count(*) FROM dispatches) = 0,
            'owner-role session with an employee identity still sees nothing (policies re-check users.role)');
SELECT t.throws($$INSERT INTO fin.purchase_discounts(purchase_id, discount_type, discount_value, entered_by)
                 VALUES ('c0000000-0000-0000-0000-000000000001', 'PERCENT', 50, '00000000-0000-0000-0000-000000000010')$$,
                '42501', '...and cannot write owner-only data');

-- =============================================================================
\echo '── Owner'
-- =============================================================================
SELECT set_config('app.user_id', :OWNER, false);
SELECT t.ok((SELECT count(DISTINCT warehouse_id) FROM inventory_levels) = 2, 'owner sees all warehouses');
SELECT t.throws('SELECT password_hash FROM auth.credentials', '42501', 'owners cannot read password hashes');
SELECT t.throws('SELECT override_pin_hash FROM auth.credentials', '42501', 'owners cannot read override PIN hashes');

INSERT INTO fin.purchase_discounts(purchase_id, discount_type, discount_value, reason, entered_by)
VALUES ('c0000000-0000-0000-0000-000000000001', 'PERCENT', 5, 'Quarterly scheme', :OWNER);
SELECT t.ok((SELECT (owner_discount, net_taxable, net_payable) = (1750.00, 33250.00, 39550.00)
             FROM fin.v_purchase_net_summary WHERE purchase_id = 'c0000000-0000-0000-0000-000000000001'),
            'owner discount: billed 41,300 -> net payable 39,550');
SELECT t.ok((SELECT effective_unit_cost_base FROM fin.v_purchase_line_cost
              WHERE purchase_id = 'c0000000-0000-0000-0000-000000000001') = 665.0000,
            'effective cost per spanner set = (35000 - 1750) / 50 = 665');

SELECT t.ok((SELECT count(*) FROM fin.top_selling_items(app.today_ist(), app.today_ist())) = 3, 'top sellers computed');
SELECT t.ok((SELECT count(*) FROM fin.margin_spread(app.today_ist() - 30, app.today_ist())) >= 1, 'margin spread computed');
SELECT t.ok((SELECT invoices FROM fin.employee_performance(app.today_ist(), app.today_ist())
              WHERE user_id = :EMPA) = 2, 'employee performance attributes 2 invoices to Ravi');
SELECT t.ok((SELECT count(*) FROM fin.dead_stock(0)) >= 1, 'dead-stock function runs');
SELECT t.ok((SELECT short_base FROM fin.v_transfer_shortages) = 2, 'transit shortage of 2 pcs visible to owner');
SELECT t.ok(EXISTS (SELECT 1 FROM fin.v_reorder_alerts WHERE warehouse_code = 'WHB' AND sku_code = 'STN-CS-1724'),
            'reorder alert: WHB has 0 spanner sets vs threshold 20');
SELECT t.ok((SELECT count(*) FROM fin.create_po_from_reorder(:WHB,
               ARRAY(SELECT id FROM products WHERE sku_code = 'STN-CS-1724'))) = 1,
            'one-click PO created against last vendor');
SELECT t.ok((SELECT (fin.eod_digest())->'warehouses'->0->>'total_incl_gst')::numeric = 165294.40
            AND jsonb_array_length((fin.eod_digest())->'low_stock') > 0, 'EOD digest payload: WHA total + low-stock list');
SELECT t.ok((SELECT count(*) FROM notification_outbox WHERE event_type = 'DISPATCH_ALERT') = 2,
            'one WhatsApp dispatch alert queued per committed invoice');
SELECT t.ok((SELECT count(*) FROM audit_log WHERE table_name = 'public.stock_overrides') = 1, 'override usage audited');

SELECT app.cancel_dispatch('d0000000-0000-0000-0000-000000000003', 'Wrong customer');
SELECT t.ok((SELECT qty_on_hand FROM inventory_levels il JOIN products p ON p.id = il.product_id
              WHERE il.warehouse_id = :WHA AND p.sku_code = 'TAP-SD-903') = 220, 'owner cancel restores stock via reversal');
UPDATE dispatches SET transporter_name = 'Gati' WHERE id = 'd0000000-0000-0000-0000-000000000001';
SELECT t.throws($$UPDATE dispatches SET grand_total = 1 WHERE id = 'd0000000-0000-0000-0000-000000000001'$$, '42501',
                'even owners cannot edit invoice money columns (cancel & re-issue instead)');

-- =============================================================================
\echo '── Time window & deactivation'
-- =============================================================================
RESET ROLE;
UPDATE dispatches SET created_at = now() - interval '1 day' WHERE id = 'd0000000-0000-0000-0000-000000000001';
SET ROLE app_employee;
SELECT set_config('app.user_id', :EMPA, false);
SELECT t.ok((SELECT count(*) FROM dispatches) = 1, 'yesterday''s entries drop out of the employee''s daily log');
RESET ROLE;
UPDATE users SET is_active = false WHERE id = :EMPA;
SET ROLE app_employee;
SELECT t.ok((SELECT count(*) FROM inventory_levels) = 0, 'deactivated user immediately sees nothing');
RESET ROLE;
UPDATE users SET is_active = true WHERE id = :EMPA;

DROP SCHEMA t CASCADE;
\echo '✓ ALL DATABASE TESTS PASSED'

-- =============================================================================
-- supabase/seed.sql — DEVELOPMENT DATA ONLY (runs on `supabase db reset`).
-- Never run against production; `supabase db push` does not run it.
-- Logins in the app (all passwords: ChangeMe@123):
--   owner      Owner (all warehouses)     override PIN 246810
--   ravi.wha   Employee @ WHA Bengaluru
--   kumar.whb  Employee @ WHB Chennai
-- Each User ID maps to the Supabase Auth e-mail '<user id>@staff.whreg.app'
-- (keep in sync with LOGIN_EMAIL_DOMAIN in the app and Edge Functions).
-- GSTINs below are synthetic but checksum-valid.
-- =============================================================================
BEGIN;

-- Supabase Auth users (columns GoTrue expects to be non-NULL are set to '').
INSERT INTO auth.users (instance_id, id, aud, role, email, encrypted_password, email_confirmed_at,
                        raw_app_meta_data, raw_user_meta_data, created_at, updated_at,
                        confirmation_token, email_change, email_change_token_new, recovery_token)
SELECT '00000000-0000-0000-0000-000000000000', v.id, 'authenticated', 'authenticated',
       v.login || '@staff.whreg.app', extensions.crypt('ChangeMe@123', extensions.gen_salt('bf')), now(),
       '{"provider":"email","providers":["email"]}', jsonb_build_object('login_id', v.login), now(), now(), '', '', '', ''
FROM (VALUES ('00000000-0000-0000-0000-000000000001'::uuid, 'owner'),
             ('00000000-0000-0000-0000-000000000010'::uuid, 'ravi.wha'),
             ('00000000-0000-0000-0000-000000000011'::uuid, 'kumar.whb')) v(id, login);

INSERT INTO auth.identities (id, user_id, provider_id, identity_data, provider, last_sign_in_at, created_at, updated_at)
SELECT gen_random_uuid(), u.id, u.id::text, jsonb_build_object('sub', u.id::text, 'email', u.email), 'email', now(), now(), now()
FROM auth.users u WHERE u.email LIKE '%@staff.whreg.app';

INSERT INTO gst_rates(rate, label, is_active, note) VALUES
  (0,  'Nil',  true, NULL),
  (5,  '5%',   true, NULL),
  (12, '12%',  true, 'Largely retired by GST 2.0 (22-Sep-2025); keep only for items still notified at 12%'),
  (18, '18%',  true, 'Standard rate for most hardware & power tools'),
  (28, '28%',  true, 'Largely retired by GST 2.0 (22-Sep-2025)'),
  (40, '40%',  false, 'GST 2.0 demerit slab; not expected for hardware')
ON CONFLICT (rate) DO NOTHING;

INSERT INTO warehouses(id, code, name, address, state_code, gstin) VALUES
  ('a0000000-0000-0000-0000-000000000001', 'WHA', 'Warehouse A – Bengaluru', 'Peenya Industrial Area', '29', '29AAHCW5544N1ZJ'),
  ('a0000000-0000-0000-0000-000000000002', 'WHB', 'Warehouse B – Chennai',   'Ambattur Industrial Estate', '33', '33AAJCW6655P1ZI');

INSERT INTO users(id, login_id, full_name, phone, role, primary_warehouse_id) VALUES
  ('00000000-0000-0000-0000-000000000001', 'owner',     'Business Owner', '9800000001', 'OWNER',    NULL),
  ('00000000-0000-0000-0000-000000000010', 'ravi.wha',  'Ravi (WHA)',     '9800000010', 'EMPLOYEE', 'a0000000-0000-0000-0000-000000000001'),
  ('00000000-0000-0000-0000-000000000011', 'kumar.whb', 'Kumar (WHB)',    '9800000011', 'EMPLOYEE', 'a0000000-0000-0000-0000-000000000002');

INSERT INTO secure.override_pins(user_id, pin_hash)
VALUES ('00000000-0000-0000-0000-000000000001', extensions.crypt('246810', extensions.gen_salt('bf', 10)));

-- Act as the owner for the rest of the seed (triggers stamp created_by from auth.uid()).
SELECT set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-000000000001","role":"authenticated"}', true);

INSERT INTO brands(name) VALUES ('Stanley'), ('Bosch'), ('Taparia'), ('Fischer');

WITH pt AS (INSERT INTO categories(name, sort_order) VALUES ('Power Tools', 1) RETURNING id),
     ht AS (INSERT INTO categories(name, sort_order) VALUES ('Hand Tools', 2) RETURNING id),
     fa AS (INSERT INTO categories(name, sort_order) VALUES ('Fasteners', 3) RETURNING id),
     dr AS (INSERT INTO categories(parent_id, name) SELECT id, 'Drills' FROM pt RETURNING id),
     sp AS (INSERT INTO categories(parent_id, name) SELECT id, 'Spanners' FROM ht RETURNING id),
     sd AS (INSERT INTO categories(parent_id, name) SELECT id, 'Screwdrivers' FROM ht RETURNING id),
     an AS (INSERT INTO categories(parent_id, name) SELECT id, 'Wall Anchors' FROM fa RETURNING id)
SELECT 1;

INSERT INTO products(sku_code, name, brand_id, category_id, specification, specs, hsn_code, default_gst_rate,
                     mrp, default_selling_price, default_reorder_level)
SELECT v.sku, v.name, b.id, c.id, v.spec, v.specs::jsonb, v.hsn, v.gst, v.mrp, v.sp, v.reorder
FROM (VALUES
  ('BOS-GSB13RE', 'Impact Drill GSB 13 RE', 'Bosch',   'Power Tools > Drills',       '13mm, 600W', '{"chuck_mm":13,"watts":600}', '84672100', 18, 4999, 3200, 10),
  ('STN-CS-1724', 'Combination Spanner Set 17-24mm', 'Stanley', 'Hand Tools > Spanners', '6 pc, 17–24mm', '{"pieces":6}', '82041110', 18, 1450, 820, 20),
  ('TAP-SD-903',  'Screwdriver Set 903', 'Taparia', 'Hand Tools > Screwdrivers', '6 pc, insulated', '{"pieces":6,"insulated":true}', '82054000', 18, 520, 310, 50),
  ('FIS-SX8',     'Nylon Wall Plug SX 8x40', 'Fischer', 'Fasteners > Wall Anchors', '8mm x 40mm', '{"dia_mm":8,"len_mm":40}', '39269099', 18, 4, 1.80, 2000)
) AS v(sku, name, brand, cat, spec, specs, hsn, gst, mrp, sp, reorder)
JOIN brands b ON b.name = v.brand
JOIN categories c ON c.path = v.cat;

-- Packaging: Fischer plugs PCS -> BOX(100) -> CTN(20 boxes = 2000); spanner sets BOX(5 sets)
INSERT INTO product_uoms(product_id, uom_code, display_name, factor_to_base, sort_order)
SELECT p.id, v.code, v.disp, v.f, v.so FROM (VALUES
  ('FIS-SX8', 'BOX', 'Box of 100', 100, 2), ('FIS-SX8', 'CTN', 'Carton (20 boxes)', 2000, 1),
  ('STN-CS-1724', 'BOX', 'Box of 5 sets', 5, 1), ('TAP-SD-903', 'CTN', 'Carton of 24', 24, 1)
) v(sku, code, disp, f, so) JOIN products p ON p.sku_code = v.sku;

-- Vernacular aliases (search hits these).
INSERT INTO product_aliases(product_id, alias, language)
SELECT p.id, v.alias, v.lang FROM (VALUES
  ('STN-CS-1724', 'pana set', 'hi'), ('STN-CS-1724', 'spanar', 'kn'),
  ('TAP-SD-903', 'pechkas', 'hi'), ('TAP-SD-903', 'tirupuli', 'ta'),
  ('BOS-GSB13RE', 'drill machine', 'en-IN'), ('FIS-SX8', 'gitti', 'hi'), ('FIS-SX8', 'rawl plug', 'en-IN')
) v(sku, alias, lang) JOIN products p ON p.sku_code = v.sku;

INSERT INTO vendors(name, gstin, state_code, phone) VALUES
  ('Karnataka Tools Distributors', '29AAACW1234K1Z9', '29', '9811111111'),
  ('Bosch Channel Partner Mumbai',  '27AADCB2230M1ZT', '27', '9822222222');

INSERT INTO customers(name, gstin, state_code, phone) VALUES
  ('Sri Hardware & Sanitary',  '29AABCS5678L1ZM', '29', '9833333333'),
  ('Chennai Tools Mart',       '33AACCT4321M1ZF', '33', '9844444444'),
  ('Deepak Industrial Supply', '29AAFCD7788Q1ZG', '29', '9855555555'),
  ('Kovai Power Tools',        '33AAGCK1122R1ZH', '33', '9866666666');

INSERT INTO sales_agents(name, phone, user_id) VALUES
  ('Manjunath (Field)', '9877777777', NULL),
  ('Ravi (Counter)',    '9800000010', '00000000-0000-0000-0000-000000000010');

-- Opening stock (owner adjustment) — WHA has stock, WHB is thin.
INSERT INTO stock_adjustments(warehouse_id, product_id, movement, qty_delta_base, notes)
SELECT w.id, p.id, 'OPENING', v.qty, 'Opening balance'
FROM (VALUES ('WHA','BOS-GSB13RE', 25), ('WHA','STN-CS-1724', 60), ('WHA','TAP-SD-903', 240), ('WHA','FIS-SX8', 10000),
             ('WHB','BOS-GSB13RE', 4),  ('WHB','TAP-SD-903', 30)) v(wh, sku, qty)
JOIN warehouses w ON w.code = v.wh JOIN products p ON p.sku_code = v.sku;

COMMIT;

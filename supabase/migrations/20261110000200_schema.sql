-- =============================================================================
-- schema — core tables.
-- Core tables. Money: numeric(14,2). Unit prices: numeric(14,4) so that a
-- back-calculated base price (from an inclusive price) round-trips exactly.
-- Quantities: numeric(14,3) (supports cut lengths / kg as well as pieces).
-- All stock is stored in the product's BASE unit (usually PCS).
-- =============================================================================

-- ---------------------------------------------------------------------------
-- Reference data
-- ---------------------------------------------------------------------------

-- GST slabs are DATA, not an enum: GST 2.0 (22-Sep-2025) moved most goods to
-- 0/5/18/40 and largely retired 12/28. Owner can activate/deactivate slabs.
CREATE TABLE gst_rates (
  rate        numeric(5,2) PRIMARY KEY CHECK (rate >= 0 AND rate <= 100),
  label       text NOT NULL,
  is_active   boolean NOT NULL DEFAULT true,
  note        text
);

CREATE TABLE warehouses (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code        text NOT NULL UNIQUE CHECK (code ~ '^[A-Z0-9]{2,4}$'),  -- prefix of invoice no. (GST caps invoice no. at 16 chars)
  name        text NOT NULL,
  address     text,
  state_code  char(2) NOT NULL CHECK (state_code ~ '^[0-9]{2}$'),
  gstin       text CHECK (app.gstin_valid(gstin)),
  is_active   boolean NOT NULL DEFAULT true,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);

-- One row per staff login. id = auth.users.id (Supabase Auth owns passwords,
-- sessions and refresh-token rotation). login_id is what staff type; the app
-- maps it to the internal e-mail '<login_id>@<LOGIN_EMAIL_DOMAIN>'.
CREATE TABLE users (
  id                    uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  login_id              extensions.citext NOT NULL UNIQUE CHECK (login_id ~ '^[A-Za-z0-9._-]{3,32}$'),
  full_name             text NOT NULL,
  phone                 text CHECK (phone ~ '^[6-9][0-9]{9}$'),
  role                  user_role NOT NULL,
  primary_warehouse_id  uuid REFERENCES warehouses(id),
  is_active             boolean NOT NULL DEFAULT true,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),
  -- An employee MUST be tied to exactly one warehouse.
  CONSTRAINT employee_has_warehouse CHECK (role <> 'EMPLOYEE' OR primary_warehouse_id IS NOT NULL)
);
CREATE INDEX users_warehouse_idx ON users(primary_warehouse_id);

-- Admin Override PINs live in a schema no API role can reach.
CREATE TABLE secure.override_pins (
  user_id     uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  pin_hash    text NOT NULL,                      -- bcrypt via extensions.crypt()
  changed_at  timestamptz NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------------
-- Catalogue: Brand -> Tool Category (tree) -> Specification
-- ---------------------------------------------------------------------------
CREATE TABLE brands (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name       text NOT NULL,
  logo_key   text,
  is_active  boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX brands_name_uq ON brands (lower(name));

CREATE TABLE categories (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  parent_id   uuid REFERENCES categories(id),
  name        text NOT NULL,
  path        text NOT NULL DEFAULT '',   -- 'Power Tools > Drills > Hammer Drills' (trigger-maintained)
  sort_order  int  NOT NULL DEFAULT 0,
  is_active   boolean NOT NULL DEFAULT true,
  CONSTRAINT category_not_own_parent CHECK (parent_id IS DISTINCT FROM id)
);
CREATE UNIQUE INDEX categories_sibling_uq ON categories (coalesce(parent_id, '00000000-0000-0000-0000-000000000000'::uuid), lower(name));
CREATE INDEX categories_parent_idx ON categories(parent_id);

CREATE TABLE products (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  sku_code               text NOT NULL UNIQUE CHECK (sku_code ~ '^[A-Z0-9-]{2,24}$'), -- short typed code (no barcodes)
  name                   text NOT NULL,
  brand_id               uuid REFERENCES brands(id),
  category_id            uuid REFERENCES categories(id),
  specification          text,                       -- e.g. '13mm, 750W, 230V'
  specs                  jsonb NOT NULL DEFAULT '{}'::jsonb,  -- structured: {"chuck_mm":13,"watts":750}
  hsn_code               text CHECK (hsn_code ~ '^[0-9]{4}([0-9]{2}){0,2}$'),
  default_gst_rate       numeric(5,2) NOT NULL REFERENCES gst_rates(rate),
  base_uom               text NOT NULL DEFAULT 'PCS',
  mrp                    numeric(14,2) CHECK (mrp >= 0),
  default_selling_price  numeric(14,4) CHECK (default_selling_price >= 0),  -- excl. GST, per base unit
  default_reorder_level  numeric(14,3) NOT NULL DEFAULT 0 CHECK (default_reorder_level >= 0), -- base units
  search_doc             text NOT NULL DEFAULT '',   -- trigger-maintained: name+brand+category+spec+aliases+sku
  is_active              boolean NOT NULL DEFAULT true,
  created_at             timestamptz NOT NULL DEFAULT now(),
  updated_at             timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX products_brand_idx    ON products(brand_id);
CREATE INDEX products_category_idx ON products(category_id);
CREATE INDEX products_search_trgm  ON products USING gin (search_doc extensions.gin_trgm_ops);

-- Vernacular / local names ("pana" for spanner, "pechkas" for screwdriver ...)
CREATE TABLE product_aliases (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  product_id  uuid NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  alias       text NOT NULL,
  language    text,                                   -- 'hi', 'kn', 'ta', 'mr', 'en-IN' ...
  created_by  uuid REFERENCES users(id),
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX product_aliases_uq ON product_aliases (product_id, lower(alias));
CREATE INDEX product_aliases_trgm ON product_aliases USING gin (alias extensions.gin_trgm_ops);

CREATE TABLE product_images (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  product_id   uuid NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  storage_key  text NOT NULL,                        -- object-storage key; API issues signed URLs
  is_primary   boolean NOT NULL DEFAULT false,
  sort_order   int NOT NULL DEFAULT 0,
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX product_images_one_primary ON product_images(product_id) WHERE is_primary;

-- Packaging hierarchy: CTN (= 10 BOX) -> BOX (= 12 PCS) -> PCS.
-- factor_to_base is always relative to the BASE unit (CTN = 120, BOX = 12, PCS = 1).
CREATE TABLE product_uoms (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  product_id      uuid NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  uom_code        text NOT NULL CHECK (uom_code ~ '^[A-Z]{2,6}$'),   -- PCS, BOX, CTN, MTR, KG, SET
  display_name    text NOT NULL,
  factor_to_base  numeric(14,4) NOT NULL CHECK (factor_to_base > 0),
  is_base         boolean NOT NULL DEFAULT false,
  sort_order      int NOT NULL DEFAULT 0,             -- largest pack first for breakdown display
  UNIQUE (product_id, uom_code),
  CONSTRAINT base_factor_is_one CHECK (NOT is_base OR factor_to_base = 1)
);
CREATE UNIQUE INDEX product_uoms_one_base ON product_uoms(product_id) WHERE is_base;

-- ---------------------------------------------------------------------------
-- Parties
-- ---------------------------------------------------------------------------
CREATE TABLE vendors (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name        text NOT NULL,
  gstin       text UNIQUE CHECK (app.gstin_valid(gstin)),
  state_code  char(2) CHECK (state_code ~ '^[0-9]{2}$'),
  phone       text,
  address     text,
  is_active   boolean NOT NULL DEFAULT true,
  created_by  uuid REFERENCES users(id),
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX vendors_name_trgm ON vendors USING gin (name extensions.gin_trgm_ops);

CREATE TABLE customers (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name        text NOT NULL,
  gstin       text UNIQUE CHECK (app.gstin_valid(gstin)),   -- NULL for unregistered (B2C)
  state_code  char(2) CHECK (state_code ~ '^[0-9]{2}$'),
  phone       text,
  address     text,
  is_dealer   boolean NOT NULL DEFAULT true,
  is_active   boolean NOT NULL DEFAULT true,
  created_by  uuid REFERENCES users(id),
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX customers_name_trgm ON customers USING gin (name extensions.gin_trgm_ops);

-- Sales agents may or may not be app users (field reps often aren't).
CREATE TABLE sales_agents (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name        text NOT NULL,
  phone       text,
  user_id     uuid UNIQUE REFERENCES users(id),
  is_active   boolean NOT NULL DEFAULT true,
  created_at  timestamptz NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------------
-- Inventory: ledger (source of truth) + materialised levels (fast reads)
-- ---------------------------------------------------------------------------

-- Admin override grants: created ONLY by app.request_stock_override() after a
-- correct PIN. Single-use, short-lived, bound to requester + warehouse.
CREATE TABLE stock_overrides (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  warehouse_id  uuid NOT NULL REFERENCES warehouses(id),
  requested_by  uuid NOT NULL REFERENCES users(id),
  approved_by   uuid NOT NULL REFERENCES users(id),
  reason        text NOT NULL CHECK (length(reason) >= 3),
  expires_at    timestamptz NOT NULL,
  consumed_ref  uuid,                                -- dispatch / transfer id that used it
  consumed_at   timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX stock_overrides_requester_idx ON stock_overrides(requested_by, created_at DESC);

CREATE TABLE secure.pin_attempts (
  id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  requested_by  uuid NOT NULL REFERENCES users(id),
  success       boolean NOT NULL,
  attempted_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX pin_attempts_user_time_idx ON secure.pin_attempts(requested_by, attempted_at DESC);

CREATE TABLE inventory_levels (
  warehouse_id   uuid NOT NULL REFERENCES warehouses(id),
  product_id     uuid NOT NULL REFERENCES products(id),
  qty_on_hand    numeric(14,3) NOT NULL DEFAULT 0,    -- base units; may go < 0 only via override
  qty_in_transit numeric(14,3) NOT NULL DEFAULT 0,    -- inbound transfers not yet received
  last_movement_at  timestamptz,
  last_outward_at   timestamptz,                      -- last sale/transfer-out (dead-stock signal)
  updated_at     timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (warehouse_id, product_id)
);
CREATE INDEX inventory_levels_product_idx ON inventory_levels(product_id);

-- Per-warehouse reorder rules (falls back to products.default_reorder_level).
CREATE TABLE reorder_rules (
  warehouse_id      uuid NOT NULL REFERENCES warehouses(id),
  product_id        uuid NOT NULL REFERENCES products(id),
  min_qty_base      numeric(14,3) NOT NULL CHECK (min_qty_base >= 0),
  reorder_qty_base  numeric(14,3) CHECK (reorder_qty_base > 0),
  PRIMARY KEY (warehouse_id, product_id)
);

CREATE TABLE stock_movements (
  id             bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  warehouse_id   uuid NOT NULL REFERENCES warehouses(id),
  product_id     uuid NOT NULL REFERENCES products(id),
  movement       movement_type NOT NULL,
  qty_delta_base numeric(14,3) NOT NULL CHECK (qty_delta_base <> 0),
  ref_table      text NOT NULL,                      -- 'dispatch_items', 'purchase_items', ...
  ref_id         uuid NOT NULL,                      -- line id
  doc_id         uuid NOT NULL,                      -- header id (dispatch / purchase / transfer)
  override_id    uuid REFERENCES stock_overrides(id),
  created_by     uuid NOT NULL REFERENCES users(id),
  created_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX stock_movements_wh_prod_time_idx ON stock_movements(warehouse_id, product_id, created_at DESC);
CREATE INDEX stock_movements_doc_idx ON stock_movements(doc_id);

-- Owner-only manual corrections (damage, loss, audit, opening stock).
CREATE TABLE stock_adjustments (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  warehouse_id   uuid NOT NULL REFERENCES warehouses(id),
  product_id     uuid NOT NULL REFERENCES products(id),
  movement       movement_type NOT NULL CHECK (movement IN ('ADJUST_DAMAGE','ADJUST_LOSS','ADJUST_FOUND','ADJUST_AUDIT','OPENING')),
  qty_delta_base numeric(14,3) NOT NULL CHECK (qty_delta_base <> 0),
  notes          text,
  created_by     uuid NOT NULL REFERENCES users(id),
  created_at     timestamptz NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------------
-- INWARD: purchases (goods receipt)
-- ---------------------------------------------------------------------------
CREATE TABLE purchases (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_txn_id      uuid NOT NULL UNIQUE,            -- idempotency key from the device
  warehouse_id       uuid NOT NULL REFERENCES warehouses(id),
  vendor_id          uuid NOT NULL REFERENCES vendors(id),
  vendor_name        text NOT NULL,                   -- snapshot as printed on the bill
  vendor_gstin       text CHECK (app.gstin_valid(vendor_gstin)),
  vendor_invoice_no  text NOT NULL,
  vendor_invoice_date date NOT NULL,
  received_on        date NOT NULL DEFAULT app.today_ist(),
  lorry_receipt_no   text,
  is_interstate      boolean NOT NULL,                -- IGST vs CGST+SGST (set by trigger from GSTINs)
  freight_amount     numeric(14,2) NOT NULL DEFAULT 0 CHECK (freight_amount >= 0),
  -- totals: maintained by app.finalize_purchase()
  taxable_total      numeric(14,2) NOT NULL DEFAULT 0,
  cgst_total         numeric(14,2) NOT NULL DEFAULT 0,
  sgst_total         numeric(14,2) NOT NULL DEFAULT 0,
  igst_total         numeric(14,2) NOT NULL DEFAULT 0,
  grand_total        numeric(14,2) NOT NULL DEFAULT 0, -- Total Landed Cost incl. GST (+freight)
  status             txn_status NOT NULL DEFAULT 'POSTED',
  cancelled_reason   text,
  created_by         uuid NOT NULL REFERENCES users(id),
  created_at         timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT purchase_vendor_invoice_uq UNIQUE (vendor_id, vendor_invoice_no)
);
CREATE INDEX purchases_wh_created_idx   ON purchases(warehouse_id, created_by, created_at DESC);
CREATE INDEX purchases_vendor_date_idx  ON purchases(vendor_id, vendor_invoice_date DESC);

CREATE TABLE purchase_items (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  purchase_id        uuid NOT NULL REFERENCES purchases(id) ON DELETE CASCADE,
  line_no            int  NOT NULL,
  product_id         uuid NOT NULL REFERENCES products(id),
  uom_code           text NOT NULL,
  conversion_factor  numeric(14,4) NOT NULL CHECK (conversion_factor > 0),  -- snapshot from product_uoms
  qty                numeric(14,3) NOT NULL CHECK (qty > 0),
  qty_base           numeric(14,3) GENERATED ALWAYS AS (round(qty * conversion_factor, 3)) STORED,
  hsn_code           text CHECK (hsn_code ~ '^[0-9]{4}([0-9]{2}){0,2}$'),
  gst_rate           numeric(5,2) NOT NULL REFERENCES gst_rates(rate),
  unit_base_price    numeric(14,4) NOT NULL CHECK (unit_base_price >= 0),  -- excl. GST, per uom_code
  unit_incl_price    numeric(14,4) NOT NULL CHECK (unit_incl_price >= 0),  -- incl. GST, per uom_code
  line_taxable       numeric(14,2) GENERATED ALWAYS AS (round(qty * unit_base_price, 2)) STORED,
  line_tax           numeric(14,2) GENERATED ALWAYS AS (round(round(qty * unit_base_price, 2) * gst_rate / 100, 2)) STORED,
  line_total         numeric(14,2) GENERATED ALWAYS AS (round(qty * unit_base_price, 2) + round(round(qty * unit_base_price, 2) * gst_rate / 100, 2)) STORED,
  UNIQUE (purchase_id, line_no),
  -- base <-> inclusive must agree (the app auto-calculates one from the other).
  CONSTRAINT purchase_gst_consistent CHECK (abs(unit_incl_price - round(unit_base_price * (1 + gst_rate / 100), 2)) <= 0.01)
);
CREATE INDEX purchase_items_product_idx ON purchase_items(product_id);

CREATE TABLE purchase_attachments (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  purchase_id  uuid NOT NULL REFERENCES purchases(id) ON DELETE CASCADE,
  kind         text NOT NULL CHECK (kind IN ('VENDOR_INVOICE','LORRY_RECEIPT','OTHER')),
  storage_key  text NOT NULL,
  mime_type    text NOT NULL CHECK (mime_type IN ('image/jpeg','image/png','image/webp','application/pdf')),
  created_by   uuid NOT NULL REFERENCES users(id),
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX purchase_attachments_purchase_idx ON purchase_attachments(purchase_id);

-- ---------------------------------------------------------------------------
-- OUTWARD: dispatches (sales invoices)
-- ---------------------------------------------------------------------------
CREATE TABLE invoice_series (
  warehouse_id  uuid NOT NULL REFERENCES warehouses(id),
  fy            text NOT NULL,                       -- '26-27'
  next_no       int  NOT NULL DEFAULT 1,
  PRIMARY KEY (warehouse_id, fy)
);

CREATE TABLE dispatches (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_txn_id      uuid NOT NULL UNIQUE,
  warehouse_id       uuid NOT NULL REFERENCES warehouses(id),
  customer_id        uuid NOT NULL REFERENCES customers(id),
  customer_name      text NOT NULL,                  -- snapshot
  customer_gstin     text CHECK (app.gstin_valid(customer_gstin)),
  sales_agent_id     uuid REFERENCES sales_agents(id),
  invoice_no         text NOT NULL CHECK (length(invoice_no) <= 16),   -- GST rule: max 16 chars
  invoice_date       date NOT NULL DEFAULT app.today_ist(),
  fy                 text NOT NULL,
  place_of_supply    char(2) NOT NULL CHECK (place_of_supply ~ '^[0-9]{2}$'),
  is_interstate      boolean NOT NULL,
  transport_mode     transport_mode NOT NULL,
  transporter_name   text,
  vehicle_reg_no     text CHECK (vehicle_reg_no ~ '^([A-Z]{2}[0-9]{1,2}[A-Z]{0,3}[0-9]{4}|[0-9]{2}BH[0-9]{4}[A-Z]{1,2})$'),
  driver_phone       text CHECK (driver_phone ~ '^[6-9][0-9]{9}$'),
  lr_number          text,
  eway_bill_no       text CHECK (eway_bill_no ~ '^[0-9]{12}$'),
  override_id        uuid REFERENCES stock_overrides(id),
  taxable_total      numeric(14,2) NOT NULL DEFAULT 0,  -- Total excl. GST (after discount)
  discount_total     numeric(14,2) NOT NULL DEFAULT 0,
  cgst_total         numeric(14,2) NOT NULL DEFAULT 0,
  sgst_total         numeric(14,2) NOT NULL DEFAULT 0,
  igst_total         numeric(14,2) NOT NULL DEFAULT 0,
  grand_total        numeric(14,2) NOT NULL DEFAULT 0,  -- Total Invoice Value incl. GST
  status             txn_status NOT NULL DEFAULT 'POSTED',
  cancelled_reason   text,
  created_by         uuid NOT NULL REFERENCES users(id),
  created_at         timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT dispatch_invoice_uq UNIQUE (warehouse_id, fy, invoice_no),
  CONSTRAINT dispatch_vehicle_required CHECK (
    transport_mode NOT IN ('OWN_VEHICLE','TRANSPORTER') OR vehicle_reg_no IS NOT NULL)
);
CREATE INDEX dispatches_wh_created_idx    ON dispatches(warehouse_id, created_by, created_at DESC);
CREATE INDEX dispatches_wh_date_idx       ON dispatches(warehouse_id, invoice_date) WHERE status = 'POSTED';
CREATE INDEX dispatches_customer_idx      ON dispatches(customer_id, invoice_date DESC);
CREATE INDEX dispatches_agent_idx         ON dispatches(sales_agent_id, invoice_date);

CREATE TABLE dispatch_items (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  dispatch_id        uuid NOT NULL REFERENCES dispatches(id) ON DELETE CASCADE,
  line_no            int  NOT NULL,
  product_id         uuid NOT NULL REFERENCES products(id),
  uom_code           text NOT NULL,
  conversion_factor  numeric(14,4) NOT NULL CHECK (conversion_factor > 0),
  qty                numeric(14,3) NOT NULL CHECK (qty > 0),
  qty_base           numeric(14,3) GENERATED ALWAYS AS (round(qty * conversion_factor, 3)) STORED,
  hsn_code           text CHECK (hsn_code ~ '^[0-9]{4}([0-9]{2}){0,2}$'),
  gst_rate           numeric(5,2) NOT NULL REFERENCES gst_rates(rate),
  unit_base_price    numeric(14,4) NOT NULL CHECK (unit_base_price >= 0),          -- Base Selling Price excl. GST
  discount_pct       numeric(5,2)  NOT NULL DEFAULT 0 CHECK (discount_pct BETWEEN 0 AND 100),
  unit_final_price   numeric(14,4) GENERATED ALWAYS AS (round(unit_base_price * (1 - discount_pct / 100), 4)) STORED, -- Final Price excl. GST
  line_discount      numeric(14,2) GENERATED ALWAYS AS (round(qty * unit_base_price, 2) - round(qty * round(unit_base_price * (1 - discount_pct / 100), 4), 2)) STORED,
  line_taxable       numeric(14,2) GENERATED ALWAYS AS (round(qty * round(unit_base_price * (1 - discount_pct / 100), 4), 2)) STORED,
  line_tax           numeric(14,2) GENERATED ALWAYS AS (round(round(qty * round(unit_base_price * (1 - discount_pct / 100), 4), 2) * gst_rate / 100, 2)) STORED,
  line_total         numeric(14,2) GENERATED ALWAYS AS (
                       round(qty * round(unit_base_price * (1 - discount_pct / 100), 4), 2)
                     + round(round(qty * round(unit_base_price * (1 - discount_pct / 100), 4), 2) * gst_rate / 100, 2)) STORED,
  UNIQUE (dispatch_id, line_no)
);
CREATE INDEX dispatch_items_product_idx ON dispatch_items(product_id);

-- ---------------------------------------------------------------------------
-- Inter-Warehouse Transfer Notes (the ONLY way stock moves between warehouses)
-- ---------------------------------------------------------------------------
CREATE TABLE transfer_notes (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_txn_id      uuid NOT NULL UNIQUE,
  note_no            text NOT NULL UNIQUE,
  from_warehouse_id  uuid NOT NULL REFERENCES warehouses(id),
  to_warehouse_id    uuid NOT NULL REFERENCES warehouses(id),
  status             transfer_status NOT NULL DEFAULT 'DRAFT',
  vehicle_reg_no     text,
  driver_phone       text,
  eway_bill_no       text,
  remarks            text,
  override_id        uuid REFERENCES stock_overrides(id),
  created_by         uuid NOT NULL REFERENCES users(id),
  created_at         timestamptz NOT NULL DEFAULT now(),
  dispatched_by      uuid REFERENCES users(id),
  dispatched_at      timestamptz,
  received_by        uuid REFERENCES users(id),
  received_at        timestamptz,
  CONSTRAINT transfer_distinct_wh CHECK (from_warehouse_id <> to_warehouse_id)
);
CREATE INDEX transfer_notes_from_idx ON transfer_notes(from_warehouse_id, status);
CREATE INDEX transfer_notes_to_idx   ON transfer_notes(to_warehouse_id, status);

CREATE TABLE transfer_note_items (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  transfer_note_id   uuid NOT NULL REFERENCES transfer_notes(id) ON DELETE CASCADE,
  line_no            int NOT NULL,
  product_id         uuid NOT NULL REFERENCES products(id),
  uom_code           text NOT NULL,
  conversion_factor  numeric(14,4) NOT NULL CHECK (conversion_factor > 0),
  qty                numeric(14,3) NOT NULL CHECK (qty > 0),
  qty_base           numeric(14,3) GENERATED ALWAYS AS (round(qty * conversion_factor, 3)) STORED,
  qty_received_base  numeric(14,3) CHECK (qty_received_base >= 0),
  UNIQUE (transfer_note_id, line_no)
);

-- ---------------------------------------------------------------------------
-- Notifications outbox (WhatsApp) + audit
-- ---------------------------------------------------------------------------
CREATE TABLE notification_outbox (
  id                   bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  event_type           text NOT NULL CHECK (event_type IN ('DISPATCH_ALERT','EOD_DIGEST','LOW_STOCK')),
  aggregate_id         uuid,                         -- dispatch id etc.
  dedupe_key           text NOT NULL UNIQUE,         -- 'dispatch:<id>' / 'eod:2026-11-10'
  payload              jsonb NOT NULL DEFAULT '{}'::jsonb,
  status               outbox_status NOT NULL DEFAULT 'PENDING',
  attempts             int NOT NULL DEFAULT 0,
  next_attempt_at      timestamptz NOT NULL DEFAULT now(),
  last_error           text,
  provider_message_id  text,
  created_at           timestamptz NOT NULL DEFAULT now(),
  sent_at              timestamptz,
  delivered_at         timestamptz
);
CREATE INDEX outbox_pending_idx ON notification_outbox(next_attempt_at) WHERE status IN ('PENDING','FAILED');
CREATE INDEX outbox_provider_idx ON notification_outbox(provider_message_id);

CREATE TABLE audit_log (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  table_name  text NOT NULL,
  row_id      text NOT NULL,
  action      text NOT NULL,
  actor_id    uuid,
  old_data    jsonb,
  new_data    jsonb,
  at          timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX audit_log_row_idx ON audit_log(table_name, row_id);

-- ---------------------------------------------------------------------------
-- fin.* : owner-only financial data
-- ---------------------------------------------------------------------------

-- Additional post-billing discount the owner negotiates with the vendor.
-- Employees never see this table, nor any value derived from it.
CREATE TABLE fin.purchase_discounts (
  purchase_id      uuid PRIMARY KEY REFERENCES purchases(id) ON DELETE CASCADE,
  discount_type    text NOT NULL CHECK (discount_type IN ('PERCENT','AMOUNT')),
  discount_value   numeric(14,4) NOT NULL CHECK (discount_value >= 0),
  reason           text,                              -- 'Quarterly scheme', 'Cash discount 2%'
  entered_by       uuid NOT NULL REFERENCES users(id),
  entered_at       timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT pct_bounds CHECK (discount_type <> 'PERCENT' OR discount_value <= 100)
);

CREATE TABLE fin.customer_payments (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id  uuid NOT NULL REFERENCES customers(id),
  amount       numeric(14,2) NOT NULL CHECK (amount > 0),
  paid_on      date NOT NULL,
  mode         text NOT NULL CHECK (mode IN ('CASH','UPI','NEFT','RTGS','CHEQUE','CREDIT_NOTE')),
  reference    text,
  notes        text,
  entered_by   uuid NOT NULL REFERENCES users(id),
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX customer_payments_customer_idx ON fin.customer_payments(customer_id, paid_on);

CREATE TABLE fin.customer_credit (
  customer_id   uuid PRIMARY KEY REFERENCES customers(id),
  credit_limit  numeric(14,2) NOT NULL CHECK (credit_limit >= 0),
  credit_days   int NOT NULL DEFAULT 30
);

CREATE TABLE fin.purchase_orders (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  po_no         text NOT NULL UNIQUE,
  vendor_id     uuid NOT NULL REFERENCES vendors(id),
  warehouse_id  uuid NOT NULL REFERENCES warehouses(id),
  status        text NOT NULL DEFAULT 'DRAFT' CHECK (status IN ('DRAFT','SENT','PARTIAL','CLOSED','CANCELLED')),
  notes         text,
  created_by    uuid NOT NULL REFERENCES users(id),
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE fin.purchase_order_items (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  purchase_order_id uuid NOT NULL REFERENCES fin.purchase_orders(id) ON DELETE CASCADE,
  product_id        uuid NOT NULL REFERENCES products(id),
  qty_base          numeric(14,3) NOT NULL CHECK (qty_base > 0),
  expected_unit_price numeric(14,4),                 -- last effective price per base unit
  UNIQUE (purchase_order_id, product_id)
);

-- updated_at triggers
CREATE TRIGGER warehouses_touch BEFORE UPDATE ON warehouses FOR EACH ROW EXECUTE FUNCTION app.touch_updated_at();
CREATE TRIGGER users_touch      BEFORE UPDATE ON users      FOR EACH ROW EXECUTE FUNCTION app.touch_updated_at();
CREATE TRIGGER products_touch   BEFORE UPDATE ON products   FOR EACH ROW EXECUTE FUNCTION app.touch_updated_at();

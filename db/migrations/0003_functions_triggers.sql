-- =============================================================================
-- 0003_functions_triggers.sql
-- Session identity helpers, catalogue maintenance, the stock ledger engine,
-- GST/totals finalisation, admin override PIN, transfers, cancellations,
-- outbox enqueueing and audit.
--
-- Custom SQLSTATEs (mapped to HTTP codes by the API):
--   WH001 insufficient stock (409)      WH002 forbidden (403)
--   WH003 PIN locked (429)              WH004 invalid PIN / override (403)
--   WH005 validation (422)
-- =============================================================================

-- ---------------------------------------------------------------------------
-- Session identity. SECURITY DEFINER so policies can read users without
-- recursing into users' own RLS. Wrapped as (SELECT app.fn()) in policies so
-- Postgres evaluates them once per statement, not once per row.
-- ---------------------------------------------------------------------------
CREATE FUNCTION app.current_user_id() RETURNS uuid
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT u.id FROM users u
  WHERE u.id = nullif(current_setting('app.user_id', true), '')::uuid
    AND u.is_active
$$;

CREATE FUNCTION app.current_app_role() RETURNS user_role
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT u.role FROM users u WHERE u.id = app.current_user_id()
$$;

CREATE FUNCTION app.is_owner() RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT coalesce(app.current_app_role() IN ('OWNER','ADMIN','SYSTEM'), false)
$$;

CREATE FUNCTION app.current_warehouse_id() RETURNS uuid
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT u.primary_warehouse_id FROM users u WHERE u.id = app.current_user_id()
$$;

-- Raise unless the caller is an owner/admin.
CREATE FUNCTION app.require_owner() RETURNS void
LANGUAGE plpgsql STABLE AS $$
BEGIN
  IF NOT app.is_owner() THEN
    RAISE EXCEPTION 'Owner/Admin privileges required' USING ERRCODE = 'WH002';
  END IF;
END$$;

-- Raise unless the caller is an owner or works at the given warehouse.
CREATE FUNCTION app.require_warehouse(p_wh uuid) RETURNS void
LANGUAGE plpgsql STABLE AS $$
BEGIN
  IF app.current_user_id() IS NULL THEN
    RAISE EXCEPTION 'No authenticated user in session' USING ERRCODE = 'WH002';
  END IF;
  IF NOT app.is_owner() AND app.current_warehouse_id() IS DISTINCT FROM p_wh THEN
    RAISE EXCEPTION 'Not permitted for this warehouse' USING ERRCODE = 'WH002';
  END IF;
END$$;

-- ---------------------------------------------------------------------------
-- Catalogue maintenance
-- ---------------------------------------------------------------------------
CREATE FUNCTION app.category_path() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE parent_path text;
BEGIN
  IF NEW.parent_id IS NULL THEN
    NEW.path := NEW.name;
  ELSE
    -- cycle guard: the new parent must not be a descendant of this node
    IF TG_OP = 'UPDATE' AND EXISTS (
      WITH RECURSIVE up AS (
        SELECT id, parent_id FROM categories WHERE id = NEW.parent_id
        UNION ALL
        SELECT c.id, c.parent_id FROM categories c JOIN up ON c.id = up.parent_id
      ) SELECT 1 FROM up WHERE id = NEW.id) THEN
      RAISE EXCEPTION 'Category cycle detected' USING ERRCODE = 'WH005';
    END IF;
    SELECT path INTO parent_path FROM categories WHERE id = NEW.parent_id;
    NEW.path := parent_path || ' > ' || NEW.name;
  END IF;
  RETURN NEW;
END$$;
CREATE TRIGGER categories_path BEFORE INSERT OR UPDATE OF name, parent_id ON categories
  FOR EACH ROW EXECUTE FUNCTION app.category_path();

CREATE FUNCTION app.category_cascade() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  IF NEW.path IS DISTINCT FROM OLD.path THEN
    UPDATE categories SET name = name WHERE parent_id = NEW.id;      -- re-fires path trigger
    UPDATE products   SET search_doc = search_doc WHERE category_id = NEW.id;
  END IF;
  RETURN NULL;
END$$;
CREATE TRIGGER categories_cascade AFTER UPDATE ON categories
  FOR EACH ROW EXECUTE FUNCTION app.category_cascade();

-- Normalise text for search: lowercase, strip accents, collapse whitespace.
CREATE FUNCTION app.norm(t text) RETURNS text
LANGUAGE sql STABLE SET search_path = public, pg_temp AS $$
  SELECT regexp_replace(lower(unaccent(coalesce(t, ''))), '\s+', ' ', 'g')
$$;

CREATE FUNCTION app.product_search_doc() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  NEW.search_doc := app.norm(concat_ws(' ',
    NEW.sku_code, NEW.name,
    (SELECT name FROM brands WHERE id = NEW.brand_id),
    (SELECT path FROM categories WHERE id = NEW.category_id),
    NEW.specification,
    (SELECT string_agg(alias, ' ') FROM product_aliases WHERE product_id = NEW.id)));
  RETURN NEW;
END$$;
CREATE TRIGGER products_search_doc BEFORE INSERT OR UPDATE ON products
  FOR EACH ROW EXECUTE FUNCTION app.product_search_doc();

CREATE FUNCTION app.refresh_product_doc() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  IF TG_TABLE_NAME = 'product_aliases' THEN
    UPDATE products SET search_doc = search_doc
     WHERE id IN (coalesce(NEW.product_id, OLD.product_id), coalesce(OLD.product_id, NEW.product_id));
  ELSIF TG_TABLE_NAME = 'brands' THEN
    UPDATE products SET search_doc = search_doc WHERE brand_id = NEW.id;
  END IF;
  RETURN NULL;
END$$;
CREATE TRIGGER product_aliases_refresh AFTER INSERT OR UPDATE OR DELETE ON product_aliases
  FOR EACH ROW EXECUTE FUNCTION app.refresh_product_doc();
CREATE TRIGGER brands_refresh AFTER UPDATE OF name ON brands
  FOR EACH ROW EXECUTE FUNCTION app.refresh_product_doc();

-- Every product automatically gets its base UoM row.
CREATE FUNCTION app.product_base_uom() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  INSERT INTO product_uoms(product_id, uom_code, display_name, factor_to_base, is_base, sort_order)
  VALUES (NEW.id, NEW.base_uom, initcap(NEW.base_uom), 1, true, 999)
  ON CONFLICT (product_id, uom_code) DO NOTHING;
  RETURN NULL;
END$$;
CREATE TRIGGER products_base_uom AFTER INSERT ON products
  FOR EACH ROW EXECUTE FUNCTION app.product_base_uom();

-- High-speed typo-tolerant search over name, brand, category, spec, aliases, SKU.
-- Optional brand / category (whole subtree) filters drive the category-tree UI.
CREATE FUNCTION app.search_products(
  p_q text, p_limit int DEFAULT 25, p_brand uuid DEFAULT NULL, p_category uuid DEFAULT NULL)
RETURNS TABLE (id uuid, sku_code text, name text, brand text, category_path text,
               specification text, hsn_code text, default_gst_rate numeric, score real)
LANGUAGE sql STABLE
SET search_path = public, pg_temp
SET pg_trgm.word_similarity_threshold = 0.35   -- tolerant of typos like 'spaner', 'scrwdriver'
AS $$
  WITH q AS (SELECT app.norm(trim(p_q)) AS t),
  subtree AS (
    WITH RECURSIVE s AS (
      SELECT c.id FROM categories c WHERE c.id = p_category
      UNION ALL
      SELECT c.id FROM categories c JOIN s ON c.parent_id = s.id)
    SELECT id FROM s)
  SELECT p.id, p.sku_code, p.name, b.name, c.path, p.specification, p.hsn_code, p.default_gst_rate,
         CASE WHEN q.t = '' THEN 0 ELSE greatest(similarity(p.search_doc, q.t), word_similarity(q.t, p.search_doc)) END
  FROM products p
  CROSS JOIN q
  LEFT JOIN brands b     ON b.id = p.brand_id
  LEFT JOIN categories c ON c.id = p.category_id
  WHERE p.is_active
    AND (p_brand IS NULL OR p.brand_id = p_brand)
    AND (p_category IS NULL OR p.category_id IN (SELECT id FROM subtree))
    -- every typed word must match (substring or fuzzy), in any order
    AND (q.t = '' OR p.search_doc LIKE '%' || q.t || '%' OR NOT EXISTS (
          SELECT 1 FROM unnest(string_to_array(q.t, ' ')) tok
           WHERE NOT (p.search_doc LIKE '%' || tok || '%' OR tok <% p.search_doc)))
  ORDER BY (upper(trim(p_q)) = p.sku_code) DESC,
           CASE WHEN q.t = '' THEN 0 ELSE greatest(similarity(p.search_doc, q.t), word_similarity(q.t, p.search_doc)) END DESC,
           p.name
  LIMIT least(coalesce(p_limit, 25), 100)
$$;

-- ---------------------------------------------------------------------------
-- Stock ledger engine
-- ---------------------------------------------------------------------------

-- Is this override grant usable by the current user for this warehouse/doc?
CREATE FUNCTION app.consume_override(p_override uuid, p_wh uuid, p_doc uuid) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE ok boolean;
BEGIN
  UPDATE stock_overrides
     SET consumed_ref = p_doc, consumed_at = coalesce(consumed_at, now())
   WHERE id = p_override
     AND warehouse_id = p_wh
     AND requested_by = app.current_user_id()
     AND expires_at > now()
     AND (consumed_ref IS NULL OR consumed_ref = p_doc)
  RETURNING true INTO ok;
  RETURN coalesce(ok, false);
END$$;

-- Single choke-point for every stock change. Row-locks the inventory_levels
-- row (ON CONFLICT DO UPDATE) so concurrent dispatches cannot oversell.
CREATE FUNCTION app.apply_movement(
  p_wh uuid, p_product uuid, p_type movement_type, p_delta numeric,
  p_ref_table text, p_ref_id uuid, p_doc_id uuid,
  p_override uuid DEFAULT NULL, p_allow_negative boolean DEFAULT false)
RETURNS numeric
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_new numeric;
  v_name text;
  v_is_out boolean := p_type IN ('DISPATCH_OUT','TRANSFER_OUT');
BEGIN
  INSERT INTO inventory_levels AS il (warehouse_id, product_id, qty_on_hand, last_movement_at, last_outward_at)
  VALUES (p_wh, p_product, p_delta, now(), CASE WHEN v_is_out THEN now() END)
  ON CONFLICT (warehouse_id, product_id) DO UPDATE
     SET qty_on_hand      = il.qty_on_hand + EXCLUDED.qty_on_hand,
         last_movement_at = now(),
         last_outward_at  = CASE WHEN v_is_out THEN now() ELSE il.last_outward_at END,
         updated_at       = now()
  RETURNING qty_on_hand INTO v_new;

  IF p_delta < 0 AND v_new < 0 AND NOT p_allow_negative THEN
    IF p_override IS NULL OR NOT app.consume_override(p_override, p_wh, p_doc_id) THEN
      SELECT name INTO v_name FROM products WHERE id = p_product;
      RAISE EXCEPTION 'Insufficient stock for %', v_name
        USING ERRCODE = 'WH001',
              DETAIL  = json_build_object('product_id', p_product, 'product_name', v_name,
                                          'available_base', v_new - p_delta,
                                          'requested_base', -p_delta)::text,
              HINT    = 'Provide an Admin Override PIN to dispatch beyond physical stock.';
    END IF;
  END IF;

  INSERT INTO stock_movements(warehouse_id, product_id, movement, qty_delta_base,
                              ref_table, ref_id, doc_id, override_id, created_by)
  VALUES (p_wh, p_product, p_type, p_delta, p_ref_table, p_ref_id, p_doc_id,
          CASE WHEN p_delta < 0 AND v_new < 0 THEN p_override END,
          coalesce(app.current_user_id(), (SELECT id FROM users WHERE role = 'SYSTEM' LIMIT 1)));
  RETURN v_new;
END$$;

-- ---------------------------------------------------------------------------
-- Line-item snapshotting (shared by purchase / dispatch / transfer lines)
-- Server is authoritative for UoM factor and HSN — never trust the device.
-- Lines may only be added in the SAME transaction that created the header,
-- so headers are immutable once committed (corrections = cancel + re-enter).
-- ---------------------------------------------------------------------------
CREATE FUNCTION app.line_snapshot() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_factor numeric;
  v_hsn    text;
  v_gst    numeric;
  v_created timestamptz;
  v_status  text;
BEGIN
  SELECT factor_to_base INTO v_factor FROM product_uoms
   WHERE product_id = NEW.product_id AND uom_code = NEW.uom_code;
  IF v_factor IS NULL THEN
    RAISE EXCEPTION 'Unit % is not defined for this product', NEW.uom_code USING ERRCODE = 'WH005';
  END IF;
  NEW.conversion_factor := v_factor;

  IF TG_TABLE_NAME = 'purchase_items' THEN
    SELECT created_at, status::text INTO v_created, v_status FROM purchases WHERE id = NEW.purchase_id;
  ELSIF TG_TABLE_NAME = 'dispatch_items' THEN
    SELECT created_at, status::text INTO v_created, v_status FROM dispatches WHERE id = NEW.dispatch_id;
  ELSE
    SELECT created_at, status::text INTO v_created, v_status FROM transfer_notes WHERE id = NEW.transfer_note_id;
    IF v_status <> 'DRAFT' THEN
      RAISE EXCEPTION 'Transfer note is no longer editable' USING ERRCODE = 'WH005';
    END IF;
    RETURN NEW;
  END IF;

  IF v_created IS DISTINCT FROM now() THEN
    RAISE EXCEPTION 'Lines can only be added in the transaction that creates the document' USING ERRCODE = 'WH005';
  END IF;

  SELECT hsn_code, default_gst_rate INTO v_hsn, v_gst FROM products WHERE id = NEW.product_id;
  NEW.hsn_code := coalesce(NEW.hsn_code, v_hsn);
  NEW.gst_rate := coalesce(NEW.gst_rate, v_gst);
  RETURN NEW;
END$$;

CREATE TRIGGER purchase_items_snapshot BEFORE INSERT ON purchase_items
  FOR EACH ROW EXECUTE FUNCTION app.line_snapshot();
CREATE TRIGGER dispatch_items_snapshot BEFORE INSERT ON dispatch_items
  FOR EACH ROW EXECUTE FUNCTION app.line_snapshot();
CREATE TRIGGER transfer_items_snapshot BEFORE INSERT ON transfer_note_items
  FOR EACH ROW EXECUTE FUNCTION app.line_snapshot();

-- Post stock for each line as it lands.
CREATE FUNCTION app.post_line_stock() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_wh uuid; v_override uuid;
BEGIN
  IF TG_TABLE_NAME = 'purchase_items' THEN
    SELECT warehouse_id INTO v_wh FROM purchases WHERE id = NEW.purchase_id;
    PERFORM app.apply_movement(v_wh, NEW.product_id, 'PURCHASE_IN', NEW.qty_base,
                               'purchase_items', NEW.id, NEW.purchase_id);
  ELSE
    SELECT warehouse_id, override_id INTO v_wh, v_override FROM dispatches WHERE id = NEW.dispatch_id;
    PERFORM app.apply_movement(v_wh, NEW.product_id, 'DISPATCH_OUT', -NEW.qty_base,
                               'dispatch_items', NEW.id, NEW.dispatch_id, v_override);
  END IF;
  RETURN NULL;
END$$;
CREATE TRIGGER purchase_items_stock AFTER INSERT ON purchase_items
  FOR EACH ROW EXECUTE FUNCTION app.post_line_stock();
CREATE TRIGGER dispatch_items_stock AFTER INSERT ON dispatch_items
  FOR EACH ROW EXECUTE FUNCTION app.post_line_stock();

-- Owner stock adjustments (damage, loss, audit, opening).
CREATE FUNCTION app.post_adjustment() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  PERFORM app.apply_movement(NEW.warehouse_id, NEW.product_id, NEW.movement, NEW.qty_delta_base,
                             'stock_adjustments', NEW.id, NEW.id, NULL, true);
  RETURN NULL;
END$$;
CREATE TRIGGER stock_adjustments_post AFTER INSERT ON stock_adjustments
  FOR EACH ROW EXECUTE FUNCTION app.post_adjustment();

-- ---------------------------------------------------------------------------
-- Header defaults & anti-spoofing (who, when, where, which tax regime)
-- ---------------------------------------------------------------------------
CREATE FUNCTION app.next_invoice_no(p_wh uuid, p_date date) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_fy text := app.fy_label(p_date); v_no int; v_code text;
BEGIN
  INSERT INTO invoice_series AS s (warehouse_id, fy, next_no) VALUES (p_wh, v_fy, 2)
  ON CONFLICT (warehouse_id, fy) DO UPDATE SET next_no = s.next_no + 1
  RETURNING next_no - 1 INTO v_no;
  SELECT code INTO v_code FROM warehouses WHERE id = p_wh;
  RETURN v_code || '/' || v_fy || '/' || lpad(v_no::text, 5, '0');   -- e.g. WHA/26-27/00042
END$$;

CREATE FUNCTION app.header_defaults() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_uid uuid := app.current_user_id();
  v_owner boolean := app.is_owner();
  v_wh_state char(2);
  v_party_gstin text; v_party_state char(2); v_party_name text;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'No authenticated user in session' USING ERRCODE = 'WH002';
  END IF;
  NEW.created_by := v_uid;            -- never trust the client for authorship
  NEW.created_at := now();

  IF TG_TABLE_NAME = 'purchases' THEN
    NEW.status := 'POSTED';
    SELECT state_code INTO v_wh_state FROM warehouses WHERE id = NEW.warehouse_id;
    SELECT name, gstin, state_code INTO v_party_name, v_party_gstin, v_party_state FROM vendors WHERE id = NEW.vendor_id;
    NEW.vendor_name  := coalesce(NEW.vendor_name, v_party_name);
    NEW.vendor_gstin := coalesce(NEW.vendor_gstin, v_party_gstin);
    NEW.is_interstate := coalesce(app.gstin_state(NEW.vendor_gstin), v_party_state, v_wh_state) <> v_wh_state;
    IF NOT v_owner THEN NEW.received_on := app.today_ist(); END IF;
    NEW.taxable_total := 0; NEW.cgst_total := 0; NEW.sgst_total := 0; NEW.igst_total := 0; NEW.grand_total := 0;

  ELSIF TG_TABLE_NAME = 'dispatches' THEN
    NEW.status := 'POSTED';
    SELECT state_code INTO v_wh_state FROM warehouses WHERE id = NEW.warehouse_id;
    SELECT name, gstin, state_code INTO v_party_name, v_party_gstin, v_party_state FROM customers WHERE id = NEW.customer_id;
    NEW.customer_name  := coalesce(NEW.customer_name, v_party_name);
    NEW.customer_gstin := coalesce(NEW.customer_gstin, v_party_gstin);
    IF NOT v_owner THEN NEW.invoice_date := app.today_ist(); END IF;   -- staff cannot back-date
    NEW.fy := app.fy_label(NEW.invoice_date);
    NEW.invoice_no := coalesce(NEW.invoice_no, app.next_invoice_no(NEW.warehouse_id, NEW.invoice_date));
    NEW.place_of_supply := coalesce(NEW.place_of_supply, app.gstin_state(NEW.customer_gstin), v_party_state, v_wh_state);
    NEW.is_interstate := NEW.place_of_supply <> v_wh_state;
    NEW.vehicle_reg_no := nullif(upper(regexp_replace(coalesce(NEW.vehicle_reg_no, ''), '[^A-Za-z0-9]', '', 'g')), '');
    NEW.driver_phone   := nullif(right(regexp_replace(coalesce(NEW.driver_phone, ''), '\D', '', 'g'), 10), '');
    NEW.taxable_total := 0; NEW.discount_total := 0; NEW.cgst_total := 0; NEW.sgst_total := 0; NEW.igst_total := 0; NEW.grand_total := 0;

  ELSIF TG_TABLE_NAME = 'transfer_notes' THEN
    NEW.status := 'DRAFT';
    NEW.note_no := coalesce(NEW.note_no,
      'TN/' || (SELECT code FROM warehouses WHERE id = NEW.from_warehouse_id) || '/' ||
      app.fy_label(app.today_ist()) || '/' || lpad(nextval('transfer_note_seq')::text, 5, '0'));
  END IF;
  RETURN NEW;
END$$;

CREATE SEQUENCE transfer_note_seq;

CREATE TRIGGER purchases_defaults BEFORE INSERT ON purchases
  FOR EACH ROW EXECUTE FUNCTION app.header_defaults();
CREATE TRIGGER dispatches_defaults BEFORE INSERT ON dispatches
  FOR EACH ROW EXECUTE FUNCTION app.header_defaults();
CREATE TRIGGER transfer_notes_defaults BEFORE INSERT ON transfer_notes
  FOR EACH ROW EXECUTE FUNCTION app.header_defaults();

-- created_by stamping for simple tables employees may insert into.
CREATE FUNCTION app.stamp_created_by() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  NEW.created_by := app.current_user_id();
  RETURN NEW;
END$$;
CREATE TRIGGER product_aliases_stamp BEFORE INSERT ON product_aliases FOR EACH ROW EXECUTE FUNCTION app.stamp_created_by();
CREATE TRIGGER vendors_stamp         BEFORE INSERT ON vendors         FOR EACH ROW EXECUTE FUNCTION app.stamp_created_by();
CREATE TRIGGER customers_stamp       BEFORE INSERT ON customers       FOR EACH ROW EXECUTE FUNCTION app.stamp_created_by();
CREATE TRIGGER attachments_stamp     BEFORE INSERT ON purchase_attachments FOR EACH ROW EXECUTE FUNCTION app.stamp_created_by();
CREATE TRIGGER adjustments_stamp     BEFORE INSERT ON stock_adjustments    FOR EACH ROW EXECUTE FUNCTION app.stamp_created_by();

-- ---------------------------------------------------------------------------
-- Finalisation at COMMIT (deferred constraint triggers): totals, GST split,
-- "must have lines", and the WhatsApp dispatch alert enqueue.
-- ---------------------------------------------------------------------------
CREATE FUNCTION app.finalize_document() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_taxable numeric; v_tax numeric; v_disc numeric; v_lines int; v_outbox bigint;
BEGIN
  IF TG_TABLE_NAME = 'purchases' THEN
    SELECT count(*), coalesce(sum(line_taxable),0), coalesce(sum(line_tax),0)
      INTO v_lines, v_taxable, v_tax FROM purchase_items WHERE purchase_id = NEW.id;
    IF v_lines = 0 THEN RAISE EXCEPTION 'A purchase needs at least one item' USING ERRCODE = 'WH005'; END IF;
    UPDATE purchases SET
      taxable_total = v_taxable,
      igst_total = CASE WHEN is_interstate THEN v_tax ELSE 0 END,
      cgst_total = CASE WHEN is_interstate THEN 0 ELSE round(v_tax / 2, 2) END,
      sgst_total = CASE WHEN is_interstate THEN 0 ELSE v_tax - round(v_tax / 2, 2) END,
      grand_total = v_taxable + v_tax + freight_amount
    WHERE id = NEW.id;

  ELSE -- dispatches
    SELECT count(*), coalesce(sum(line_taxable),0), coalesce(sum(line_tax),0), coalesce(sum(line_discount),0)
      INTO v_lines, v_taxable, v_tax, v_disc FROM dispatch_items WHERE dispatch_id = NEW.id;
    IF v_lines = 0 THEN RAISE EXCEPTION 'A dispatch needs at least one item' USING ERRCODE = 'WH005'; END IF;
    UPDATE dispatches SET
      taxable_total = v_taxable,
      discount_total = v_disc,
      igst_total = CASE WHEN is_interstate THEN v_tax ELSE 0 END,
      cgst_total = CASE WHEN is_interstate THEN 0 ELSE round(v_tax / 2, 2) END,
      sgst_total = CASE WHEN is_interstate THEN 0 ELSE v_tax - round(v_tax / 2, 2) END,
      grand_total = v_taxable + v_tax
    WHERE id = NEW.id;

    INSERT INTO notification_outbox(event_type, aggregate_id, dedupe_key)
    VALUES ('DISPATCH_ALERT', NEW.id, 'dispatch:' || NEW.id)
    ON CONFLICT (dedupe_key) DO NOTHING
    RETURNING id INTO v_outbox;
    IF v_outbox IS NOT NULL THEN PERFORM pg_notify('outbox', v_outbox::text); END IF;
  END IF;
  RETURN NULL;
END$$;

CREATE CONSTRAINT TRIGGER purchases_finalize AFTER INSERT ON purchases
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION app.finalize_document();
CREATE CONSTRAINT TRIGGER dispatches_finalize AFTER INSERT ON dispatches
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION app.finalize_document();

-- ---------------------------------------------------------------------------
-- Admin Override PIN
-- ---------------------------------------------------------------------------

-- Owner sets/rotates their own PIN (6–8 digits). Stored as bcrypt.
CREATE FUNCTION app.set_override_pin(p_pin text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, auth, pg_temp AS $$
BEGIN
  PERFORM app.require_owner();
  IF p_pin !~ '^[0-9]{6,8}$' THEN
    RAISE EXCEPTION 'PIN must be 6-8 digits' USING ERRCODE = 'WH005';
  END IF;
  UPDATE auth.credentials SET override_pin_hash = crypt(p_pin, gen_salt('bf', 10))
   WHERE user_id = app.current_user_id();
END$$;

-- Employee (or owner) exchanges a correct PIN for a single-use, 10-minute
-- override grant tied to them + the warehouse. 5 failures / 15 min => locked.
CREATE FUNCTION app.request_stock_override(p_pin text, p_warehouse uuid, p_reason text)
RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, auth, pg_temp AS $$
DECLARE
  v_uid uuid := app.current_user_id();
  v_approver uuid;
  v_fails int;
  v_id uuid;
BEGIN
  PERFORM app.require_warehouse(p_warehouse);

  SELECT count(*) INTO v_fails FROM auth.pin_attempts
   WHERE requested_by = v_uid AND NOT success AND attempted_at > now() - interval '15 minutes';
  IF v_fails >= 5 THEN
    RAISE EXCEPTION 'Too many wrong PIN attempts. Try again later.' USING ERRCODE = 'WH003';
  END IF;

  SELECT c.user_id INTO v_approver
    FROM auth.credentials c JOIN users u ON u.id = c.user_id
   WHERE u.is_active AND u.role IN ('OWNER','ADMIN')
     AND c.override_pin_hash IS NOT NULL
     AND c.override_pin_hash = crypt(p_pin, c.override_pin_hash)
   LIMIT 1;

  INSERT INTO auth.pin_attempts(requested_by, success) VALUES (v_uid, v_approver IS NOT NULL);
  IF v_approver IS NULL THEN
    -- NB: the API must COMMIT this transaction for the failed attempt to count;
    -- it returns the error to the client *after* commit (see overrides.service.ts).
    RETURN NULL;
  END IF;

  INSERT INTO stock_overrides(warehouse_id, requested_by, approved_by, reason, expires_at)
  VALUES (p_warehouse, v_uid, v_approver, p_reason, now() + interval '10 minutes')
  RETURNING id INTO v_id;
  RETURN v_id;
END$$;

-- ---------------------------------------------------------------------------
-- Inter-warehouse transfers
-- ---------------------------------------------------------------------------
CREATE FUNCTION app.dispatch_transfer(p_note uuid, p_override uuid DEFAULT NULL) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE n transfer_notes; r record;
BEGIN
  SELECT * INTO n FROM transfer_notes WHERE id = p_note FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Transfer note not found' USING ERRCODE = 'WH005'; END IF;
  PERFORM app.require_warehouse(n.from_warehouse_id);
  IF n.status <> 'DRAFT' THEN RAISE EXCEPTION 'Transfer already %', n.status USING ERRCODE = 'WH005'; END IF;
  IF NOT EXISTS (SELECT 1 FROM transfer_note_items WHERE transfer_note_id = p_note) THEN
    RAISE EXCEPTION 'Transfer has no items' USING ERRCODE = 'WH005';
  END IF;

  FOR r IN SELECT * FROM transfer_note_items WHERE transfer_note_id = p_note ORDER BY line_no LOOP
    PERFORM app.apply_movement(n.from_warehouse_id, r.product_id, 'TRANSFER_OUT', -r.qty_base,
                               'transfer_note_items', r.id, p_note, p_override);
    INSERT INTO inventory_levels AS il (warehouse_id, product_id, qty_in_transit)
    VALUES (n.to_warehouse_id, r.product_id, r.qty_base)
    ON CONFLICT (warehouse_id, product_id) DO UPDATE SET qty_in_transit = il.qty_in_transit + EXCLUDED.qty_in_transit;
  END LOOP;

  UPDATE transfer_notes SET status = 'IN_TRANSIT', dispatched_by = app.current_user_id(),
         dispatched_at = now(), override_id = p_override WHERE id = p_note;
END$$;

-- p_received: optional [{ "line_no": 1, "qty_received_base": 95 }]; default = full qty.
CREATE FUNCTION app.receive_transfer(p_note uuid, p_received jsonb DEFAULT NULL) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE n transfer_notes; r record; v_qty numeric;
BEGIN
  SELECT * INTO n FROM transfer_notes WHERE id = p_note FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Transfer note not found' USING ERRCODE = 'WH005'; END IF;
  PERFORM app.require_warehouse(n.to_warehouse_id);
  IF n.status <> 'IN_TRANSIT' THEN RAISE EXCEPTION 'Transfer is %', n.status USING ERRCODE = 'WH005'; END IF;

  FOR r IN SELECT * FROM transfer_note_items WHERE transfer_note_id = p_note ORDER BY line_no LOOP
    v_qty := coalesce(
      (SELECT (e->>'qty_received_base')::numeric FROM jsonb_array_elements(p_received) e
        WHERE (e->>'line_no')::int = r.line_no), r.qty_base);
    IF v_qty < 0 OR v_qty > r.qty_base THEN
      RAISE EXCEPTION 'Line %: received qty must be between 0 and %', r.line_no, r.qty_base USING ERRCODE = 'WH005';
    END IF;
    UPDATE transfer_note_items SET qty_received_base = v_qty WHERE id = r.id;
    UPDATE inventory_levels SET qty_in_transit = qty_in_transit - r.qty_base
     WHERE warehouse_id = n.to_warehouse_id AND product_id = r.product_id;
    IF v_qty > 0 THEN
      PERFORM app.apply_movement(n.to_warehouse_id, r.product_id, 'TRANSFER_IN', v_qty,
                                 'transfer_note_items', r.id, p_note);
    END IF;
  END LOOP;

  UPDATE transfer_notes SET status = 'RECEIVED', received_by = app.current_user_id(), received_at = now()
   WHERE id = p_note;
END$$;

-- ---------------------------------------------------------------------------
-- Cancellations (owner only) — post REVERSAL movements, never delete rows.
-- ---------------------------------------------------------------------------
CREATE FUNCTION app.cancel_dispatch(p_id uuid, p_reason text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE d dispatches; r record;
BEGIN
  PERFORM app.require_owner();
  SELECT * INTO d FROM dispatches WHERE id = p_id FOR UPDATE;
  IF d.status <> 'POSTED' THEN RAISE EXCEPTION 'Dispatch is not active' USING ERRCODE = 'WH005'; END IF;
  FOR r IN SELECT * FROM dispatch_items WHERE dispatch_id = p_id LOOP
    PERFORM app.apply_movement(d.warehouse_id, r.product_id, 'REVERSAL', r.qty_base,
                               'dispatch_items', r.id, p_id, NULL, true);
  END LOOP;
  UPDATE dispatches SET status = 'CANCELLED', cancelled_reason = p_reason WHERE id = p_id;
END$$;

CREATE FUNCTION app.cancel_purchase(p_id uuid, p_reason text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE p purchases; r record;
BEGIN
  PERFORM app.require_owner();
  SELECT * INTO p FROM purchases WHERE id = p_id FOR UPDATE;
  IF p.status <> 'POSTED' THEN RAISE EXCEPTION 'Purchase is not active' USING ERRCODE = 'WH005'; END IF;
  FOR r IN SELECT * FROM purchase_items WHERE purchase_id = p_id LOOP
    PERFORM app.apply_movement(p.warehouse_id, r.product_id, 'REVERSAL', -r.qty_base,
                               'purchase_items', r.id, p_id, NULL, true);
  END LOOP;
  UPDATE purchases SET status = 'CANCELLED', cancelled_reason = p_reason WHERE id = p_id;
END$$;

-- ---------------------------------------------------------------------------
-- Audit trail (owner-readable)
-- ---------------------------------------------------------------------------
CREATE FUNCTION app.audit_row() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_id text;
BEGIN
  v_id := coalesce(to_jsonb(NEW)->>'id', to_jsonb(OLD)->>'id',
                   to_jsonb(NEW)->>'purchase_id', to_jsonb(OLD)->>'purchase_id',
                   to_jsonb(NEW)->>'user_id', to_jsonb(OLD)->>'user_id');
  INSERT INTO audit_log(table_name, row_id, action, actor_id, old_data, new_data)
  VALUES (TG_TABLE_SCHEMA || '.' || TG_TABLE_NAME, v_id, TG_OP, app.current_user_id(),
          CASE WHEN TG_OP <> 'INSERT' THEN to_jsonb(OLD) END,
          CASE WHEN TG_OP <> 'DELETE' THEN to_jsonb(NEW) END);
  RETURN NULL;
END$$;

CREATE TRIGGER audit_users        AFTER INSERT OR UPDATE OR DELETE ON users              FOR EACH ROW EXECUTE FUNCTION app.audit_row();
CREATE TRIGGER audit_purchases    AFTER UPDATE OF status ON purchases                    FOR EACH ROW EXECUTE FUNCTION app.audit_row();
CREATE TRIGGER audit_dispatches   AFTER UPDATE OF status ON dispatches                   FOR EACH ROW EXECUTE FUNCTION app.audit_row();
CREATE TRIGGER audit_adjustments  AFTER INSERT ON stock_adjustments                      FOR EACH ROW EXECUTE FUNCTION app.audit_row();
CREATE TRIGGER audit_overrides    AFTER INSERT ON stock_overrides                        FOR EACH ROW EXECUTE FUNCTION app.audit_row();
CREATE TRIGGER audit_discounts    AFTER INSERT OR UPDATE OR DELETE ON fin.purchase_discounts FOR EACH ROW EXECUTE FUNCTION app.audit_row();

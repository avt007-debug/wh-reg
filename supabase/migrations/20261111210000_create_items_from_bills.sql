-- Owner AND employees can add a new company, category or item while entering a sale / purchase.
-- Items added this way get the same pack details as the Tata price lists (std pack → PACK unit,
-- MOQ → CTN unit) and record who created them. Editing existing items stays owner-only.

ALTER TABLE products ADD COLUMN created_by uuid REFERENCES users(id);

-- Company: returns the existing one (any letter case) or creates it. A hidden company is shown again.
CREATE FUNCTION public.add_company(p_name text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, extensions, pg_temp AS $$
DECLARE v_name text := regexp_replace(trim(coalesce(p_name, '')), '\s+', ' ', 'g'); b brands;
BEGIN
  PERFORM app.require_user();
  IF length(v_name) < 2 OR length(v_name) > 60 THEN RAISE EXCEPTION 'Company name: 2–60 characters' USING ERRCODE = 'WH005'; END IF;
  SELECT * INTO b FROM brands WHERE lower(name) = lower(v_name);
  IF FOUND THEN
    IF NOT b.is_active THEN UPDATE brands SET is_active = true WHERE id = b.id; END IF;
    RETURN jsonb_build_object('id', b.id, 'name', b.name, 'created', false);
  END IF;
  INSERT INTO brands(name) VALUES (v_name) RETURNING * INTO b;
  RETURN jsonb_build_object('id', b.id, 'name', b.name, 'created', true);
END$$;

-- Category (optionally under a parent): existing one with the same name is reused.
CREATE FUNCTION public.add_category(p_name text, p_parent uuid DEFAULT NULL) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, extensions, pg_temp AS $$
DECLARE v_name text := regexp_replace(trim(coalesce(p_name, '')), '\s+', ' ', 'g'); c categories;
BEGIN
  PERFORM app.require_user();
  IF length(v_name) < 2 OR length(v_name) > 60 THEN RAISE EXCEPTION 'Category name: 2–60 characters' USING ERRCODE = 'WH005'; END IF;
  IF p_parent IS NOT NULL AND NOT EXISTS (SELECT 1 FROM categories WHERE id = p_parent) THEN
    RAISE EXCEPTION 'Parent category not found' USING ERRCODE = 'WH005';
  END IF;
  SELECT * INTO c FROM categories WHERE parent_id IS NOT DISTINCT FROM p_parent AND lower(name) = lower(v_name);
  IF FOUND THEN
    IF NOT c.is_active THEN UPDATE categories SET is_active = true WHERE id = c.id; END IF;
    RETURN jsonb_build_object('id', c.id, 'name', c.name, 'path', c.path, 'created', false);
  END IF;
  INSERT INTO categories(name, parent_id) VALUES (v_name, p_parent) RETURNING * INTO c;
  RETURN jsonb_build_object('id', c.id, 'name', c.name, 'path', c.path, 'created', true);
END$$;

-- New item from a bill. p: {skuCode, name, brandId, categoryId, specification, hsnCode, gstRate,
--   sellingPrice (per piece, excl. GST), mrp, baseUom, stdPkg, moq}
-- Returns the item in the same shape as find_material, ready to go on the bill.
CREATE FUNCTION public.create_item(p jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, extensions, pg_temp AS $$
DECLARE
  v_uid uuid := app.require_user();
  v_code text := upper(regexp_replace(trim(coalesce(p->>'skuCode', '')), '\s+', '', 'g'));
  v_name text := regexp_replace(trim(coalesce(p->>'name', '')), '\s+', ' ', 'g');
  v_gst numeric := nullif(p->>'gstRate', '')::numeric;
  v_price numeric := nullif(p->>'sellingPrice', '')::numeric;
  v_mrp numeric := nullif(p->>'mrp', '')::numeric;
  v_pkg numeric := nullif(nullif(p->>'stdPkg', '')::numeric, 0);
  v_moq numeric := nullif(nullif(p->>'moq', '')::numeric, 0);
  v_base text := upper(coalesce(nullif(trim(p->>'baseUom'), ''), 'PCS'));
  v_id uuid;
BEGIN
  IF v_code !~ '^[A-Z0-9][A-Z0-9_./-]{1,31}$' THEN
    RAISE EXCEPTION 'Item code: 2–32 letters, digits or - _ . /' USING ERRCODE = 'WH005';
  END IF;
  IF EXISTS (SELECT 1 FROM products WHERE sku_code = v_code) THEN
    RAISE EXCEPTION 'Item code % already exists — type it in the Material No. box to add it', v_code USING ERRCODE = 'WH005';
  END IF;
  IF length(v_name) < 2 THEN RAISE EXCEPTION 'Item name is required' USING ERRCODE = 'WH005'; END IF;
  IF nullif(trim(p->>'hsnCode'), '') !~ '^[0-9]{4}([0-9]{2}){0,2}$' THEN
    RAISE EXCEPTION 'HSN code must be 4, 6 or 8 digits' USING ERRCODE = 'WH005';
  END IF;
  IF v_gst IS NULL OR NOT EXISTS (SELECT 1 FROM gst_rates WHERE rate = v_gst AND is_active) THEN
    RAISE EXCEPTION 'Choose the GST rate' USING ERRCODE = 'WH005';
  END IF;
  IF v_price IS NOT NULL AND v_price < 0 OR v_mrp IS NOT NULL AND v_mrp < 0 THEN
    RAISE EXCEPTION 'Price cannot be negative' USING ERRCODE = 'WH005';
  END IF;
  IF v_pkg IS NOT NULL AND (v_pkg < 1 OR v_pkg <> trunc(v_pkg)) OR v_moq IS NOT NULL AND (v_moq < 1 OR v_moq <> trunc(v_moq)) THEN
    RAISE EXCEPTION 'Std packing and MOQ must be whole numbers of pieces' USING ERRCODE = 'WH005';
  END IF;
  IF v_base !~ '^[A-Z]{2,6}$' THEN RAISE EXCEPTION 'Unit: 2–6 letters, e.g. PCS' USING ERRCODE = 'WH005'; END IF;

  INSERT INTO products(sku_code, name, brand_id, category_id, specification, hsn_code, default_gst_rate, base_uom,
                       mrp, default_selling_price, specs, created_by)
  VALUES (v_code, v_name, nullif(p->>'brandId', '')::uuid, nullif(p->>'categoryId', '')::uuid,
          nullif(concat_ws(' · ', nullif(trim(p->>'specification'), ''),
                 CASE WHEN v_pkg > 1 THEN 'Std pkg ' || v_pkg::text || ' ' || lower(v_base) WHEN v_pkg = 1 THEN 'Sold singly' END,
                 CASE WHEN v_moq IS NOT NULL THEN 'MOQ ' || v_moq::text || ' ' || lower(v_base) END), ''),
          trim(p->>'hsnCode'), v_gst, v_base, round(v_mrp, 2), round(v_price, 2),
          jsonb_strip_nulls(jsonb_build_object('std_pkg', v_pkg, 'moq_pcs', v_moq, 'added_from', 'bill')), v_uid)
  RETURNING id INTO v_id;                                  -- base unit row comes from the trigger

  IF v_pkg > 1 THEN
    INSERT INTO product_uoms(product_id, uom_code, display_name, factor_to_base, is_base, sort_order)
    VALUES (v_id, 'PACK', 'Pack of ' || v_pkg::text, v_pkg, false, 1);
  END IF;
  IF v_moq > 1 AND v_moq IS DISTINCT FROM v_pkg THEN
    INSERT INTO product_uoms(product_id, uom_code, display_name, factor_to_base, is_base, sort_order)
    VALUES (v_id, 'CTN', 'Carton of ' || v_moq::text, v_moq, false, 2);
  END IF;
  RETURN public.find_material(v_code, 1)->0;
END$$;

REVOKE EXECUTE ON FUNCTION public.add_company(text), public.add_category(text, uuid), public.create_item(jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.add_company(text), public.add_category(text, uuid), public.create_item(jsonb) TO authenticated;

-- Price-list catalogue (Tata Agri / Tata Hand Tools Excel) + "type the Material No." lookup for sales.
--  * Material numbers such as HOE007_CENTENARY contain "_" → item codes may now use _ . / as well.
--  * Each item keeps its pack details in specs: std_pkg (pcs per pack), moq_pcs (pcs per carton / MOQ),
--    weight_kg, unit, price_list.  When a pack holds more than 1 pc, a PACK unit is added
--    (and a CTN unit for the carton / MOQ) so sales can be entered in pcs, packs or cartons.
--  * The list price ("Customer purchase price per pcs", excl. GST) becomes the default selling price;
--    it fills in automatically on a sale and stays editable there.

ALTER TABLE products DROP CONSTRAINT products_sku_code_check;
ALTER TABLE products ADD CONSTRAINT products_sku_code_check CHECK (sku_code ~ '^[A-Z0-9][A-Z0-9_./-]{1,31}$');

-- Owner's item editor: same rule.
DO $$
DECLARE d text := pg_get_functiondef('public.owner_save_product(jsonb)'::regprocedure);
BEGIN
  d := replace(d, $r$'^[A-Z0-9-]{2,24}$'$r$, $r$'^[A-Z0-9][A-Z0-9_./-]{1,31}$'$r$);
  d := replace(d, 'Item code: 2–24 letters, digits or -', 'Item code: 2–32 letters, digits or - _ . /');
  EXECUTE d;
END$$;

-- Upsert one price list. rows: [{code, name, hsn, gst, price, stdPkg, moq, weightKg, unit}]
CREATE FUNCTION app.import_catalog(p_brand text, p_list text, p_rows jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, extensions, pg_temp AS $$
DECLARE
  v_brand uuid; r jsonb; v_code text; v_id uuid; v_new int := 0; v_upd int := 0; v_gst numeric; v_pkg numeric; v_moq numeric;
  v_skipped jsonb := '[]';
BEGIN
  SELECT id INTO v_brand FROM brands WHERE lower(name) = lower(trim(p_brand));
  IF v_brand IS NULL THEN INSERT INTO brands(name) VALUES (trim(p_brand)) RETURNING id INTO v_brand; END IF;

  FOR r IN SELECT * FROM jsonb_array_elements(p_rows) LOOP
    v_code := upper(regexp_replace(trim(r->>'code'), '\s+', '', 'g'));
    v_gst := round(coalesce((r->>'gst')::numeric, 0), 2);
    IF v_code !~ '^[A-Z0-9][A-Z0-9_./-]{1,31}$' OR coalesce(trim(r->>'name'), '') = ''
       OR NOT EXISTS (SELECT 1 FROM gst_rates WHERE rate = v_gst) OR (r->>'price') IS NULL THEN
      v_skipped := v_skipped || jsonb_build_object('code', r->>'code', 'name', r->>'name'); CONTINUE;
    END IF;
    v_pkg := nullif((r->>'stdPkg')::numeric, 0);
    v_moq := nullif((r->>'moq')::numeric, 0);

    SELECT id INTO v_id FROM products WHERE sku_code = v_code;
    IF v_id IS NULL THEN
      INSERT INTO products(sku_code, name, brand_id, hsn_code, default_gst_rate, base_uom, default_selling_price, specification, specs)
      VALUES (v_code, regexp_replace(trim(r->>'name'), '\s+', ' ', 'g'), v_brand, nullif(r->>'hsn', ''), v_gst, 'PCS',
              round((r->>'price')::numeric, 2), NULL, '{}')
      RETURNING id INTO v_id;                      -- base PCS unit is added by trigger
      v_new := v_new + 1;
    ELSE
      UPDATE products SET name = regexp_replace(trim(r->>'name'), '\s+', ' ', 'g'), brand_id = v_brand,
             hsn_code = coalesce(nullif(r->>'hsn', ''), hsn_code), default_gst_rate = v_gst,
             default_selling_price = round((r->>'price')::numeric, 2), updated_at = now()
       WHERE id = v_id;
      v_upd := v_upd + 1;
    END IF;

    UPDATE products SET
      specs = specs || jsonb_strip_nulls(jsonb_build_object('std_pkg', v_pkg, 'moq_pcs', v_moq,
                 'weight_kg', nullif((r->>'weightKg')::numeric, 0), 'unit', nullif(r->>'unit', ''), 'price_list', p_list)),
      specification = concat_ws(' · ',
                 CASE WHEN v_pkg > 1 THEN 'Std pkg ' || v_pkg::text || ' pcs' WHEN v_pkg = 1 THEN 'Sold singly' END,
                 CASE WHEN v_moq IS NOT NULL THEN 'MOQ ' || v_moq::text || ' pcs' END,
                 CASE WHEN nullif((r->>'weightKg')::numeric, 0) IS NOT NULL THEN (r->>'weightKg') || ' kg/pc' END)
     WHERE id = v_id;

    -- pack / carton units (only when they hold more than one piece)
    IF v_pkg > 1 THEN
      INSERT INTO product_uoms(product_id, uom_code, display_name, factor_to_base, is_base, sort_order)
      VALUES (v_id, 'PACK', 'Pack of ' || v_pkg::text, v_pkg, false, 1)
      ON CONFLICT (product_id, uom_code) DO UPDATE SET factor_to_base = EXCLUDED.factor_to_base, display_name = EXCLUDED.display_name;
    END IF;
    IF v_moq > 1 AND v_moq IS DISTINCT FROM v_pkg THEN
      INSERT INTO product_uoms(product_id, uom_code, display_name, factor_to_base, is_base, sort_order)
      VALUES (v_id, 'CTN', 'Carton of ' || v_moq::text, v_moq, false, 2)
      ON CONFLICT (product_id, uom_code) DO UPDATE SET factor_to_base = EXCLUDED.factor_to_base, display_name = EXCLUDED.display_name;
    END IF;
  END LOOP;
  RETURN jsonb_build_object('brand', p_brand, 'added', v_new, 'updated', v_upd, 'skipped', v_skipped);
END$$;
REVOKE EXECUTE ON FUNCTION app.import_catalog(text, text, jsonb) FROM PUBLIC, anon, authenticated;

-- Owner can (re)load a price list from the app later.
CREATE FUNCTION public.owner_import_catalog(p_brand text, p_list text, p_rows jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, extensions, pg_temp AS $$
BEGIN
  PERFORM app.require_owner();
  RETURN app.import_catalog(p_brand, p_list, p_rows);
END$$;

-- Sales entry: type a Material No. (or its first letters) → matching items with everything needed
-- to fill the line. Exact code first, then codes starting with what was typed.
CREATE FUNCTION public.find_material(p_code text, lim int DEFAULT 8) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, extensions, pg_temp AS $$
  SELECT coalesce(jsonb_agg(jsonb_build_object(
      'id', p.id, 'sku_code', p.sku_code, 'name', p.name, 'brand', b.name, 'category_path', NULL,
      'specification', p.specification, 'specs', p.specs, 'hsn_code', p.hsn_code, 'default_gst_rate', p.default_gst_rate,
      'default_selling_price', p.default_selling_price, 'mrp', p.mrp, 'image_path', NULL, 'aliases', NULL,
      'uoms', (SELECT jsonb_agg(jsonb_build_object('code', u.uom_code, 'factor', u.factor_to_base, 'displayName', u.display_name)
                               ORDER BY u.factor_to_base DESC) FROM product_uoms u WHERE u.product_id = p.id),
      'qty_on_hand', (SELECT coalesce(sum(il.qty_on_hand), 0) FROM inventory_levels il
                       WHERE il.product_id = p.id
                         AND (app.is_owner() OR il.warehouse_id = app.current_warehouse_id())))
      ORDER BY (p.sku_code = x.c) DESC, p.sku_code), '[]')
    FROM (SELECT upper(regexp_replace(trim(coalesce(p_code, '')), '\s+', '', 'g')) AS c) x
    JOIN LATERAL (SELECT * FROM products p WHERE p.is_active AND x.c <> '' AND p.sku_code LIKE replace(replace(x.c, '%', ''), '_', '\_') || '%'
                   ORDER BY (p.sku_code = x.c) DESC, p.sku_code LIMIT greatest(1, least(lim, 25))) p ON true
    LEFT JOIN brands b ON b.id = p.brand_id
   WHERE app.require_user() IS NOT NULL
$$;
REVOKE EXECUTE ON FUNCTION public.owner_import_catalog(text, text, jsonb), public.find_material(text, int) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.owner_import_catalog(text, text, jsonb), public.find_material(text, int) TO authenticated;

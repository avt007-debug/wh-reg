-- Sales: the person billing chooses which warehouse the goods are dispatched from.
-- Stock is checked and reduced in THAT warehouse, the bill number uses its series (CTR/…, VJA/…),
-- and the owner's reports show which warehouse made the dispatch.
-- Purchases and transfers keep using the employee's own warehouse.
-- Also: old item codes (e.g. SMD501 for SMDI501) can be kept as aliases and typed in the
-- Material No. box, and the box can show stock of a chosen warehouse.

CREATE FUNCTION app.resolve_dispatch_warehouse(p_requested uuid) RETURNS uuid
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, extensions, pg_temp AS $$
BEGIN
  IF app.current_user_id() IS NULL THEN
    RAISE EXCEPTION 'Not signed in or account disabled' USING ERRCODE = 'WH002';
  END IF;
  IF p_requested IS NULL THEN
    RETURN app.resolve_warehouse(NULL);               -- owner: error (required); staff: own warehouse
  END IF;
  IF NOT EXISTS (SELECT 1 FROM warehouses WHERE id = p_requested AND is_active) THEN
    RAISE EXCEPTION 'Warehouse not found or closed' USING ERRCODE = 'WH005';
  END IF;
  RETURN p_requested;
END$$;
REVOKE EXECUTE ON FUNCTION app.resolve_dispatch_warehouse(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION app.resolve_dispatch_warehouse(uuid) TO authenticated;

-- Use it in sale entry, the stock check before saving, and the owner-PIN override for sales.
DO $$
DECLARE f text; d text;
BEGIN
  FOREACH f IN ARRAY ARRAY['public.create_dispatch(jsonb)', 'public.check_dispatch(jsonb)', 'public.request_stock_override(text,text,uuid)'] LOOP
    d := pg_get_functiondef(f::regprocedure);
    IF position('app.resolve_warehouse(' IN d) = 0 THEN RAISE EXCEPTION 'resolve_warehouse not found in %', f; END IF;
    EXECUTE replace(d, 'app.resolve_warehouse(', 'app.resolve_dispatch_warehouse(');
  END LOOP;
  d := pg_get_functiondef('app.request_stock_override(text,uuid,text)'::regprocedure);
  d := replace(d, 'PERFORM app.require_warehouse(p_warehouse);',
    'IF NOT EXISTS (SELECT 1 FROM warehouses WHERE id = p_warehouse AND is_active) THEN RAISE EXCEPTION ''Warehouse not found'' USING ERRCODE = ''WH005''; END IF;');
  EXECUTE d;
END$$;

-- The stock check must see the chosen warehouse's stock even if the employee works elsewhere.
ALTER FUNCTION app.dispatch_shortfalls(uuid, jsonb) SECURITY DEFINER;

-- Row security: employees may bill from any open warehouse; they still only see their own bills.
DROP POLICY staff_insert ON dispatches;
CREATE POLICY staff_insert ON dispatches FOR INSERT TO authenticated
  WITH CHECK (EXISTS (SELECT 1 FROM warehouses w WHERE w.id = warehouse_id AND w.is_active));
DROP POLICY staff_today ON dispatches;
CREATE POLICY staff_today ON dispatches FOR SELECT TO authenticated
  USING (created_by = (SELECT app.current_user_id()) AND created_at >= (SELECT app.today_ist_start()));

-- Material No. lookup: also matches old codes (aliases) and can show a chosen warehouse's stock.
DROP FUNCTION public.find_material(text, int);
CREATE FUNCTION public.find_material(p_code text, lim int DEFAULT 8, p_warehouse uuid DEFAULT NULL) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, extensions, pg_temp AS $$
  SELECT coalesce(jsonb_agg(jsonb_build_object(
      'id', p.id, 'sku_code', p.sku_code, 'name', p.name, 'brand', b.name, 'category_path', NULL,
      'specification', p.specification, 'specs', p.specs, 'hsn_code', p.hsn_code, 'default_gst_rate', p.default_gst_rate,
      'default_selling_price', p.default_selling_price, 'mrp', p.mrp, 'image_path', NULL,
      'aliases', (SELECT jsonb_agg(a.alias) FROM product_aliases a WHERE a.product_id = p.id),
      'uoms', (SELECT jsonb_agg(jsonb_build_object('code', u.uom_code, 'factor', u.factor_to_base, 'displayName', u.display_name)
                               ORDER BY u.factor_to_base DESC) FROM product_uoms u WHERE u.product_id = p.id),
      'qty_on_hand', (SELECT coalesce(sum(il.qty_on_hand), 0) FROM inventory_levels il
                       WHERE il.product_id = p.id
                         AND CASE WHEN p_warehouse IS NOT NULL THEN il.warehouse_id = p_warehouse
                                  ELSE app.is_owner() OR il.warehouse_id = app.current_warehouse_id() END))
      ORDER BY p.exact DESC, p.sku_code), '[]')
    FROM (SELECT upper(regexp_replace(trim(coalesce(p_code, '')), '\s+', '', 'g')) AS c) x
    JOIN LATERAL (
      SELECT pr.*, (pr.sku_code = x.c OR EXISTS (SELECT 1 FROM product_aliases a WHERE a.product_id = pr.id AND upper(a.alias) = x.c)) AS exact
        FROM products pr
       WHERE pr.is_active AND x.c <> ''
         AND (pr.sku_code LIKE replace(replace(x.c, '%', ''), '_', '\_') || '%'
              OR EXISTS (SELECT 1 FROM product_aliases a WHERE a.product_id = pr.id
                          AND upper(a.alias) LIKE replace(replace(x.c, '%', ''), '_', '\_') || '%'))
       ORDER BY exact DESC, pr.sku_code
       LIMIT greatest(1, least(lim, 25))) p ON true
    LEFT JOIN brands b ON b.id = p.brand_id
   WHERE app.require_user() IS NOT NULL
$$;
REVOKE EXECUTE ON FUNCTION public.find_material(text, int, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.find_material(text, int, uuid) TO authenticated;

-- create_item returned find_material(code, 1); keep working with the new signature.
DO $$
DECLARE d text := pg_get_functiondef('public.create_item(jsonb)'::regprocedure);
BEGIN
  EXECUTE replace(d, 'public.find_material(v_code, 1)', 'public.find_material(v_code, 1, NULL)');
END$$;

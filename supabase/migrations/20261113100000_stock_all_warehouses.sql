-- Employees can see how much of each item is in EVERY warehouse (quantities only — no cost or value),
-- so they know where to dispatch from.
CREATE FUNCTION public.stock_all_warehouses(p_q text DEFAULT NULL) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, extensions, pg_temp AS $$
DECLARE v_q text := nullif(upper(trim(coalesce(p_q, ''))), '');
BEGIN
  PERFORM app.require_user();
  RETURN jsonb_build_object(
    'my_warehouse_id', app.current_warehouse_id(),
    'warehouses', (SELECT coalesce(jsonb_agg(jsonb_build_object('id', id, 'code', code, 'name', name) ORDER BY code), '[]')
                     FROM warehouses WHERE is_active),
    'items', (SELECT coalesce(jsonb_agg(x ORDER BY x->>'name'), '[]') FROM (
      SELECT jsonb_build_object(
               'product_id', p.id, 'sku_code', p.sku_code, 'name', p.name, 'brand', b.name, 'specification', p.specification,
               'aliases', (SELECT jsonb_agg(a.alias) FROM product_aliases a WHERE a.product_id = p.id),
               'uoms', (SELECT jsonb_agg(jsonb_build_object('code', u.uom_code, 'factor', u.factor_to_base) ORDER BY u.factor_to_base DESC)
                          FROM product_uoms u WHERE u.product_id = p.id),
               'by_warehouse', (SELECT jsonb_object_agg(il.warehouse_id, il.qty_on_hand) FROM inventory_levels il
                                  JOIN warehouses w ON w.id = il.warehouse_id AND w.is_active
                                 WHERE il.product_id = p.id AND il.qty_on_hand <> 0),
               'in_transit', (SELECT coalesce(sum(il.qty_in_transit), 0) FROM inventory_levels il WHERE il.product_id = p.id),
               'total', s.total) AS x
        FROM products p
        JOIN (SELECT product_id, sum(il.qty_on_hand) AS total FROM inventory_levels il
                JOIN warehouses w ON w.id = il.warehouse_id AND w.is_active
               GROUP BY product_id HAVING bool_or(il.qty_on_hand <> 0)) s ON s.product_id = p.id
        LEFT JOIN brands b ON b.id = p.brand_id
       WHERE p.is_active
         AND (v_q IS NULL OR upper(p.sku_code || ' ' || p.name || ' ' || coalesce(b.name, '')) LIKE '%' || v_q || '%'
              OR EXISTS (SELECT 1 FROM product_aliases a WHERE a.product_id = p.id AND upper(a.alias) LIKE v_q || '%'))) z));
END$$;
REVOKE EXECUTE ON FUNCTION public.stock_all_warehouses(text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.stock_all_warehouses(text) TO authenticated;

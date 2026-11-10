-- =============================================================================
-- owner_stock_list — the owner's Stock page: every active item (including ones
-- with 0 stock, so the owner can set an opening count), filtered by warehouse
-- and/or company (brand). Quantities are in base units; uoms lets the app show
-- "3 CTN + 4 BOX + 2 PCS".
-- =============================================================================

CREATE FUNCTION public.owner_stock_list(p_warehouse uuid DEFAULT NULL, p_brand uuid DEFAULT NULL) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, fin, extensions, pg_temp AS $$
BEGIN
  PERFORM app.require_owner();
  RETURN (SELECT coalesce(jsonb_agg(row_to_json(r)::jsonb ORDER BY r.brand NULLS LAST, r.name), '[]') FROM (
    SELECT p.id AS product_id, p.sku_code, p.name, p.brand_id, b.name AS brand, c.path AS category,
           p.search_doc AS search,
           (SELECT coalesce(u.display_name, p.base_uom) FROM product_uoms u WHERE u.product_id = p.id AND u.is_base) AS base_uom_name,
           (SELECT coalesce(jsonb_agg(jsonb_build_object('code', u.uom_code, 'factor', u.factor_to_base, 'displayName', u.display_name)
                                      ORDER BY u.factor_to_base DESC), '[]')
              FROM product_uoms u WHERE u.product_id = p.id) AS uoms,
           pc.avg_effective_cost_base AS avg_cost,
           coalesce(sum(il.qty_on_hand), 0) AS qty,
           coalesce(sum(il.qty_in_transit), 0) AS in_transit,
           round(coalesce(sum(il.qty_on_hand), 0) * coalesce(pc.avg_effective_cost_base, 0), 2) AS value,
           (SELECT coalesce(jsonb_object_agg(w.code, coalesce(l.qty_on_hand, 0)), '{}')
              FROM warehouses w LEFT JOIN inventory_levels l ON l.warehouse_id = w.id AND l.product_id = p.id
             WHERE w.is_active AND (p_warehouse IS NULL OR w.id = p_warehouse)) AS per_warehouse
      FROM products p
      LEFT JOIN brands b ON b.id = p.brand_id
      LEFT JOIN categories c ON c.id = p.category_id
      LEFT JOIN fin.v_product_cost pc ON pc.product_id = p.id
      LEFT JOIN inventory_levels il ON il.product_id = p.id AND (p_warehouse IS NULL OR il.warehouse_id = p_warehouse)
     WHERE p.is_active AND (p_brand IS NULL OR p.brand_id = p_brand)
     GROUP BY p.id, b.name, c.path, pc.avg_effective_cost_base) r);
END$$;

REVOKE EXECUTE ON FUNCTION public.owner_stock_list(uuid, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.owner_stock_list(uuid, uuid) TO authenticated;

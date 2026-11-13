-- Stock value: items that have no purchase yet (e.g. opening stock entered from a stock list)
-- were valued at ₹0 because value = qty × average purchase cost. They are now valued at the
-- item's list price (price per piece excl. GST) until a purchase gives them a real cost.
-- The owner sees how many items are valued that way, and the value of all stock at list price.

CREATE OR REPLACE VIEW fin.v_stock_overview AS
SELECT il.warehouse_id,
       w.code AS warehouse_code,
       w.name AS warehouse_name,
       p.id AS product_id,
       p.sku_code,
       p.name,
       b.name AS brand,
       c.path AS category_path,
       il.qty_on_hand,
       il.qty_in_transit,
       pc.avg_effective_cost_base,
       round(il.qty_on_hand * coalesce(pc.avg_effective_cost_base, p.default_selling_price, 0), 2) AS valuation,
       CASE WHEN pc.avg_effective_cost_base IS NOT NULL THEN 'COST'
            WHEN p.default_selling_price IS NOT NULL THEN 'LIST' ELSE 'NONE' END AS value_basis,
       round(il.qty_on_hand * coalesce(p.default_selling_price, 0), 2) AS list_value
  FROM inventory_levels il
  JOIN warehouses w ON w.id = il.warehouse_id
  JOIN products p ON p.id = il.product_id
  LEFT JOIN brands b ON b.id = p.brand_id
  LEFT JOIN categories c ON c.id = p.category_id
  LEFT JOIN fin.v_product_cost pc ON pc.product_id = p.id;

CREATE OR REPLACE FUNCTION public.owner_stock_overview(p_warehouse uuid DEFAULT NULL) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, fin, extensions, pg_temp AS $$
BEGIN
  PERFORM app.require_owner();
  RETURN jsonb_build_object(
    'warehouses', (SELECT coalesce(jsonb_agg(row_to_json(w)::jsonb ORDER BY w.warehouse_code), '[]') FROM (
        SELECT warehouse_id, warehouse_code, warehouse_name, sum(valuation) AS valuation,
               sum(list_value) AS list_value,
               sum(qty_on_hand) FILTER (WHERE qty_on_hand > 0) AS units,
               count(*) FILTER (WHERE qty_on_hand > 0) AS skus_in_stock,
               count(*) FILTER (WHERE qty_on_hand > 0 AND value_basis = 'LIST') AS skus_at_list_price,
               count(*) FILTER (WHERE qty_on_hand > 0 AND value_basis = 'NONE') AS skus_without_price
          FROM fin.v_stock_overview GROUP BY 1, 2, 3) w),
    'items', (SELECT coalesce(jsonb_agg(row_to_json(i)::jsonb ORDER BY i.name), '[]') FROM (
        SELECT product_id AS "productId", sku_code AS sku, name, brand, category_path AS category,
               max(avg_effective_cost_base) AS "avgCost", sum(qty_on_hand) AS "totalQty", sum(valuation) AS "totalValue",
               min(value_basis) AS "valueBasis",
               jsonb_object_agg(warehouse_code, qty_on_hand) AS "perWarehouse"
          FROM fin.v_stock_overview
         WHERE p_warehouse IS NULL OR warehouse_id = p_warehouse
         GROUP BY product_id, sku_code, name, brand, category_path) i));
END$$;

-- Owner Stock page: same rule for each item's value.
DO $$
DECLARE d text := pg_get_functiondef('public.owner_stock_list(uuid,uuid)'::regprocedure);
BEGIN
  IF position('coalesce(pc.avg_effective_cost_base, 0), 2) AS value,' IN d) = 0 THEN RAISE EXCEPTION 'owner_stock_list: value expression not found'; END IF;
  d := replace(d, 'coalesce(pc.avg_effective_cost_base, 0), 2) AS value,',
    'coalesce(pc.avg_effective_cost_base, p.default_selling_price, 0), 2) AS value,
           CASE WHEN pc.avg_effective_cost_base IS NOT NULL THEN ''COST'' WHEN p.default_selling_price IS NOT NULL THEN ''LIST'' ELSE ''NONE'' END AS value_basis,');
  EXECUTE d;
END$$;

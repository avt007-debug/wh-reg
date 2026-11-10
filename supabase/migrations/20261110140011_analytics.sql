-- =============================================================================
-- analytics — owner-only views/functions in schema fin (not exposed by the
-- Data API). Owners reach them through the owner_* RPCs, which check
-- app.is_owner() first. Views are security_invoker (Supabase linter-clean).
--
-- Cost basis: margin and valuation use cost EXCLUDING GST (a GST-registered
-- distributor claims input tax credit), net of the owner's private purchase
-- discount, plus freight apportioned by line value. Method: weighted average.
-- =============================================================================

ALTER DEFAULT PRIVILEGES IN SCHEMA fin REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;

-- ---------------------------------------------------------------------------
-- Purchases: billed value vs. value after the owner's extra discount
-- ---------------------------------------------------------------------------
CREATE VIEW fin.v_purchase_net WITH (security_invoker = true) AS
SELECT p.id AS purchase_id, p.warehouse_id, p.vendor_id, p.vendor_name, p.vendor_invoice_no,
       p.vendor_invoice_date, p.taxable_total AS billed_taxable,
       (p.cgst_total + p.sgst_total + p.igst_total) AS billed_tax,
       p.freight_amount, p.grand_total AS billed_total,
       coalesce(CASE d.discount_type
                  WHEN 'PERCENT' THEN round(p.taxable_total * d.discount_value / 100, 2)
                  WHEN 'AMOUNT'  THEN round(d.discount_value, 2) END, 0) AS owner_discount,
       d.discount_type, d.discount_value, d.reason AS discount_reason
FROM purchases p
LEFT JOIN fin.purchase_discounts d ON d.purchase_id = p.id
WHERE p.status = 'POSTED';

CREATE VIEW fin.v_purchase_net_summary WITH (security_invoker = true) AS
SELECT n.*,
       n.billed_taxable - n.owner_discount AS net_taxable,
       n.billed_total   - n.owner_discount AS net_payable,
       CASE WHEN n.billed_taxable > 0 THEN round(100 * n.owner_discount / n.billed_taxable, 2) END AS effective_discount_pct
FROM fin.v_purchase_net n;

-- Per-line effective cost (discount + freight apportioned by line_taxable share).
CREATE VIEW fin.v_purchase_line_cost WITH (security_invoker = true) AS
SELECT pi.id AS purchase_item_id, pi.purchase_id, n.warehouse_id, n.vendor_id, n.vendor_name,
       n.vendor_invoice_date, pi.product_id, pi.qty_base, pi.line_taxable, pi.line_total,
       pi.gst_rate,
       round(pi.line_taxable / nullif(pi.qty_base, 0), 4) AS billed_unit_cost_base,
       CASE WHEN n.billed_taxable > 0
            THEN round((pi.line_taxable
                        - n.owner_discount * pi.line_taxable / n.billed_taxable
                        + n.freight_amount * pi.line_taxable / n.billed_taxable) / nullif(pi.qty_base, 0), 4)
            ELSE 0 END AS effective_unit_cost_base
FROM purchase_items pi
JOIN fin.v_purchase_net n ON n.purchase_id = pi.purchase_id;

-- Weighted-average effective cost + last purchase facts, per product.
CREATE VIEW fin.v_product_cost WITH (security_invoker = true) AS
WITH agg AS (
  SELECT product_id,
         sum(effective_unit_cost_base * qty_base) / nullif(sum(qty_base), 0) AS avg_effective_cost_base,
         sum(line_total) / nullif(sum(qty_base), 0)                          AS avg_landed_incl_gst_base
  FROM fin.v_purchase_line_cost GROUP BY product_id
), last AS (
  SELECT DISTINCT ON (product_id) product_id, vendor_id, vendor_name, vendor_invoice_date,
         billed_unit_cost_base AS last_billed_cost_base, effective_unit_cost_base AS last_effective_cost_base
  FROM fin.v_purchase_line_cost
  ORDER BY product_id, vendor_invoice_date DESC, purchase_item_id
)
SELECT p.id AS product_id, p.sku_code, p.name,
       round(a.avg_effective_cost_base, 4) AS avg_effective_cost_base,
       round(a.avg_landed_incl_gst_base, 4) AS avg_landed_incl_gst_base,
       l.vendor_id AS last_vendor_id, l.vendor_name AS last_vendor_name,
       l.vendor_invoice_date AS last_purchase_date, l.last_billed_cost_base, l.last_effective_cost_base
FROM products p
LEFT JOIN agg a  ON a.product_id = p.id
LEFT JOIN last l ON l.product_id = p.id;

-- ---------------------------------------------------------------------------
-- 1. Multi-warehouse stock overview + valuation at purchase cost
-- ---------------------------------------------------------------------------
CREATE VIEW fin.v_stock_overview WITH (security_invoker = true) AS
SELECT il.warehouse_id, w.code AS warehouse_code, w.name AS warehouse_name,
       p.id AS product_id, p.sku_code, p.name, b.name AS brand, c.path AS category_path,
       il.qty_on_hand, il.qty_in_transit,
       pc.avg_effective_cost_base,
       round(il.qty_on_hand * coalesce(pc.avg_effective_cost_base, 0), 2) AS valuation
FROM inventory_levels il
JOIN warehouses w ON w.id = il.warehouse_id
JOIN products p   ON p.id = il.product_id
LEFT JOIN brands b ON b.id = p.brand_id
LEFT JOIN categories c ON c.id = p.category_id
LEFT JOIN fin.v_product_cost pc ON pc.product_id = p.id;

-- ---------------------------------------------------------------------------
-- 2. Reorder alert engine: Current Stock <= Minimum Reorder Threshold
-- ---------------------------------------------------------------------------
CREATE VIEW fin.v_reorder_alerts WITH (security_invoker = true) AS
WITH candidates AS (
  SELECT w.id AS warehouse_id, p.id AS product_id,
         coalesce(rr.min_qty_base, p.default_reorder_level) AS threshold,
         rr.reorder_qty_base,
         coalesce(il.qty_on_hand, 0) AS qty_on_hand,
         coalesce(il.qty_in_transit, 0) AS qty_in_transit
  FROM warehouses w
  CROSS JOIN products p
  LEFT JOIN reorder_rules rr   ON rr.warehouse_id = w.id AND rr.product_id = p.id
  LEFT JOIN inventory_levels il ON il.warehouse_id = w.id AND il.product_id = p.id
  WHERE w.is_active AND p.is_active
)
SELECT c.warehouse_id, w.code AS warehouse_code, c.product_id, p.sku_code, p.name,
       c.qty_on_hand, c.qty_in_transit, c.threshold,
       coalesce(c.reorder_qty_base, greatest(c.threshold * 2 - c.qty_on_hand, c.threshold)) AS suggested_qty_base,
       pc.last_vendor_id, pc.last_vendor_name, pc.last_purchase_date,
       pc.last_billed_cost_base, pc.last_effective_cost_base
FROM candidates c
JOIN warehouses w ON w.id = c.warehouse_id
JOIN products p   ON p.id = c.product_id
LEFT JOIN fin.v_product_cost pc ON pc.product_id = c.product_id
WHERE c.threshold > 0 AND c.qty_on_hand <= c.threshold;

-- One-click PO: groups selected alerts by last vendor, returns created PO ids.
CREATE FUNCTION fin.create_po_from_reorder(p_warehouse uuid, p_products uuid[])
RETURNS SETOF uuid LANGUAGE plpgsql SET search_path = public, fin, extensions, pg_temp AS $$
DECLARE v record; v_po uuid; v_no int := 0;
BEGIN
  PERFORM app.require_owner();
  FOR v IN SELECT DISTINCT last_vendor_id FROM fin.v_reorder_alerts
            WHERE warehouse_id = p_warehouse AND product_id = ANY(p_products) AND last_vendor_id IS NOT NULL
  LOOP
    v_no := v_no + 1;
    INSERT INTO fin.purchase_orders(po_no, vendor_id, warehouse_id, created_by)
    VALUES ('PO/' || app.fy_label(app.today_ist()) || '/' || to_char(clock_timestamp(), 'MMDDHH24MISS') || '-' || v_no,
            v.last_vendor_id, p_warehouse, app.current_user_id())
    RETURNING id INTO v_po;
    INSERT INTO fin.purchase_order_items(purchase_order_id, product_id, qty_base, expected_unit_price)
    SELECT v_po, product_id, suggested_qty_base, last_effective_cost_base
      FROM fin.v_reorder_alerts
     WHERE warehouse_id = p_warehouse AND product_id = ANY(p_products) AND last_vendor_id = v.last_vendor_id;
    RETURN NEXT v_po;
  END LOOP;
END$$;

-- ---------------------------------------------------------------------------
-- 3. Sales analytics
-- ---------------------------------------------------------------------------
CREATE VIEW fin.v_sales_lines WITH (security_invoker = true) AS
SELECT d.id AS dispatch_id, d.invoice_no, d.invoice_date, d.warehouse_id, w.code AS warehouse_code,
       d.customer_id, d.sales_agent_id, d.created_by, d.override_id IS NOT NULL AS used_override,
       di.product_id, p.sku_code, p.name AS product_name, b.name AS brand,
       p.category_id, c.path AS category_path, split_part(c.path, ' > ', 1) AS top_category,
       di.qty_base, di.line_taxable, di.line_tax, di.line_total, di.line_discount,
       round(di.line_taxable / nullif(di.qty_base, 0), 4) AS realized_unit_price_base,
       pc.avg_effective_cost_base,
       round(di.qty_base * coalesce(pc.avg_effective_cost_base, 0), 2) AS line_cogs
FROM dispatches d
JOIN dispatch_items di ON di.dispatch_id = d.id
JOIN warehouses w ON w.id = d.warehouse_id
JOIN products p ON p.id = di.product_id
LEFT JOIN brands b ON b.id = p.brand_id
LEFT JOIN categories c ON c.id = p.category_id
LEFT JOIN fin.v_product_cost pc ON pc.product_id = di.product_id
WHERE d.status = 'POSTED';

-- Daily revenue & volume by warehouse (roll up to month in the API / chart).
CREATE VIEW fin.v_sales_daily WITH (security_invoker = true) AS
SELECT invoice_date, warehouse_id, warehouse_code,
       count(DISTINCT dispatch_id) AS invoices,
       sum(qty_base)     AS units_base,
       sum(line_taxable) AS revenue_excl_gst,
       sum(line_total)   AS revenue_incl_gst,
       sum(line_taxable - line_cogs) AS gross_margin
FROM fin.v_sales_lines
GROUP BY invoice_date, warehouse_id, warehouse_code;

CREATE FUNCTION fin.top_selling_items(p_from date, p_to date, p_warehouse uuid DEFAULT NULL, p_limit int DEFAULT 20)
RETURNS TABLE (product_id uuid, sku_code text, product_name text, category_path text,
               units_base numeric, revenue_excl_gst numeric, rank_by_volume bigint, rank_by_revenue bigint)
LANGUAGE sql STABLE SET search_path = public, fin, extensions, pg_temp AS $$
  WITH s AS (
    SELECT product_id, sku_code, product_name, category_path,
           sum(qty_base) AS units_base, sum(line_taxable) AS revenue_excl_gst
    FROM fin.v_sales_lines
    WHERE invoice_date BETWEEN p_from AND p_to AND (p_warehouse IS NULL OR warehouse_id = p_warehouse)
    GROUP BY product_id, sku_code, product_name, category_path),
  r AS (
    SELECT s.*, rank() OVER (ORDER BY units_base DESC) AS rv, rank() OVER (ORDER BY revenue_excl_gst DESC) AS rr FROM s)
  SELECT product_id, sku_code, product_name, category_path, units_base, revenue_excl_gst, rv, rr
  FROM r WHERE rv <= p_limit OR rr <= p_limit
  ORDER BY rr, rv
$$;

-- Margin spread: landed (effective) cost vs realised selling price, per category.
CREATE FUNCTION fin.margin_spread(p_from date, p_to date, p_warehouse uuid DEFAULT NULL)
RETURNS TABLE (category text, units_base numeric, revenue_excl_gst numeric, cogs numeric,
               gross_margin numeric, margin_pct numeric,
               avg_cost_per_unit numeric, avg_price_per_unit numeric)
LANGUAGE sql STABLE SET search_path = public, fin, extensions, pg_temp AS $$
  SELECT coalesce(category_path, 'Uncategorised'),
         sum(qty_base), sum(line_taxable), sum(line_cogs),
         sum(line_taxable - line_cogs),
         round(100 * sum(line_taxable - line_cogs) / nullif(sum(line_taxable), 0), 2),
         round(sum(line_cogs) / nullif(sum(qty_base), 0), 2),
         round(sum(line_taxable) / nullif(sum(qty_base), 0), 2)
  FROM fin.v_sales_lines
  WHERE invoice_date BETWEEN p_from AND p_to AND (p_warehouse IS NULL OR warehouse_id = p_warehouse)
  GROUP BY coalesce(category_path, 'Uncategorised')
  ORDER BY 3 DESC
$$;

-- Dead stock: on hand > 0 and no outward movement for N days (default 45).
CREATE FUNCTION fin.dead_stock(p_days int DEFAULT 45, p_warehouse uuid DEFAULT NULL)
RETURNS TABLE (warehouse_id uuid, warehouse_code text, product_id uuid, sku_code text, name text,
               qty_on_hand numeric, valuation numeric, last_outward_at timestamptz, days_idle int)
LANGUAGE sql STABLE SET search_path = public, fin, extensions, pg_temp AS $$
  SELECT so.warehouse_id, so.warehouse_code, so.product_id, so.sku_code, so.name, so.qty_on_hand, so.valuation,
         il.last_outward_at,
         (app.today_ist() - coalesce(il.last_outward_at, first_in.at)::date)::int
  FROM fin.v_stock_overview so
  JOIN inventory_levels il ON il.warehouse_id = so.warehouse_id AND il.product_id = so.product_id
  LEFT JOIN LATERAL (SELECT min(created_at) AS at FROM stock_movements m
                      WHERE m.warehouse_id = so.warehouse_id AND m.product_id = so.product_id) first_in ON true
  WHERE so.qty_on_hand > 0
    AND (p_warehouse IS NULL OR so.warehouse_id = p_warehouse)
    AND coalesce(il.last_outward_at, first_in.at) < now() - make_interval(days => p_days)
  ORDER BY so.valuation DESC
$$;

-- ---------------------------------------------------------------------------
-- 4. Employee / sales-agent performance
-- ---------------------------------------------------------------------------
CREATE FUNCTION fin.employee_performance(p_from date, p_to date)
RETURNS TABLE (user_id uuid, full_name text, warehouse_code text, invoices bigint, units_base numeric,
               revenue_excl_gst numeric, gross_margin numeric, avg_invoice_value numeric,
               overrides_used bigint, inward_entries bigint)
LANGUAGE sql STABLE SET search_path = public, fin, extensions, pg_temp AS $$
  WITH s AS (
    SELECT created_by, count(DISTINCT dispatch_id) AS inv, sum(qty_base) AS units,
           sum(line_taxable) AS rev, sum(line_taxable - line_cogs) AS gm,
           count(DISTINCT dispatch_id) FILTER (WHERE used_override) AS ovr
    FROM fin.v_sales_lines WHERE invoice_date BETWEEN p_from AND p_to GROUP BY created_by),
  pin AS (
    SELECT created_by, count(*) AS n FROM purchases
    WHERE status = 'POSTED' AND received_on BETWEEN p_from AND p_to GROUP BY created_by)
  SELECT u.id, u.full_name, w.code, coalesce(s.inv,0), coalesce(s.units,0), coalesce(s.rev,0),
         coalesce(s.gm,0), round(s.rev / nullif(s.inv,0), 2), coalesce(s.ovr,0), coalesce(pin.n,0)
  FROM users u
  LEFT JOIN warehouses w ON w.id = u.primary_warehouse_id
  LEFT JOIN s   ON s.created_by = u.id
  LEFT JOIN pin ON pin.created_by = u.id
  WHERE u.role IN ('EMPLOYEE','ADMIN','OWNER') AND (s.inv IS NOT NULL OR pin.n IS NOT NULL)
  ORDER BY coalesce(s.rev,0) DESC
$$;

CREATE FUNCTION fin.sales_agent_performance(p_from date, p_to date)
RETURNS TABLE (sales_agent_id uuid, agent_name text, invoices bigint, revenue_excl_gst numeric,
               gross_margin numeric, customers bigint)
LANGUAGE sql STABLE SET search_path = public, fin, extensions, pg_temp AS $$
  SELECT a.id, a.name, count(DISTINCT s.dispatch_id), sum(s.line_taxable),
         sum(s.line_taxable - s.line_cogs), count(DISTINCT s.customer_id)
  FROM fin.v_sales_lines s JOIN sales_agents a ON a.id = s.sales_agent_id
  WHERE s.invoice_date BETWEEN p_from AND p_to
  GROUP BY a.id, a.name ORDER BY 4 DESC
$$;

-- ---------------------------------------------------------------------------
-- 5. Customer ledger (invoices debit, payments credit, running balance)
-- ---------------------------------------------------------------------------
CREATE VIEW fin.v_customer_ledger WITH (security_invoker = true) AS
WITH e AS (
  SELECT customer_id, invoice_date AS entry_date, 'INVOICE' AS kind, invoice_no AS reference,
         grand_total AS debit, 0::numeric AS credit, created_at
  FROM dispatches WHERE status = 'POSTED'
  UNION ALL
  SELECT customer_id, paid_on, 'PAYMENT', coalesce(reference, mode), 0, amount, created_at
  FROM fin.customer_payments)
SELECT e.*, sum(debit - credit) OVER (PARTITION BY customer_id ORDER BY entry_date, created_at
                                      ROWS UNBOUNDED PRECEDING) AS balance
FROM e;

-- ---------------------------------------------------------------------------
-- 6. End-of-day digest payload (consumed by the WhatsApp worker)
-- ---------------------------------------------------------------------------
CREATE FUNCTION fin.eod_digest(p_date date DEFAULT app.today_ist()) RETURNS jsonb
LANGUAGE sql STABLE SET search_path = public, fin, extensions, pg_temp AS $$
  SELECT jsonb_build_object(
    'date', p_date,
    'warehouses', coalesce((
       SELECT jsonb_agg(jsonb_build_object('code', w.code, 'name', w.name,
                 'total_incl_gst', coalesce(sd.revenue_incl_gst, 0),
                 'total_excl_gst', coalesce(sd.revenue_excl_gst, 0),
                 'invoices', coalesce(sd.invoices, 0)) ORDER BY w.code)
       FROM warehouses w
       LEFT JOIN fin.v_sales_daily sd ON sd.warehouse_id = w.id AND sd.invoice_date = p_date
       WHERE w.is_active), '[]'::jsonb),
    'combined_incl_gst', coalesce((SELECT sum(revenue_incl_gst) FROM fin.v_sales_daily WHERE invoice_date = p_date), 0),
    'low_stock', coalesce((
       SELECT jsonb_agg(jsonb_build_object('wh', warehouse_code, 'sku', sku_code, 'name', name,
                                           'qty', qty_on_hand, 'min', threshold)
                        ORDER BY (qty_on_hand / nullif(threshold,0)), sku_code)
       FROM fin.v_reorder_alerts), '[]'::jsonb))
$$;

-- Transit shortages on received transfer notes (sent vs received).
CREATE VIEW fin.v_transfer_shortages WITH (security_invoker = true) AS
SELECT n.id AS transfer_note_id, n.note_no, n.from_warehouse_id, n.to_warehouse_id, n.received_at,
       i.product_id, p.sku_code, p.name, i.qty_base AS sent_base, i.qty_received_base AS received_base,
       i.qty_base - i.qty_received_base AS short_base,
       round((i.qty_base - i.qty_received_base) * coalesce(pc.avg_effective_cost_base, 0), 2) AS short_value
FROM transfer_notes n
JOIN transfer_note_items i ON i.transfer_note_id = n.id
JOIN products p ON p.id = i.product_id
LEFT JOIN fin.v_product_cost pc ON pc.product_id = i.product_id
WHERE n.status = 'RECEIVED' AND i.qty_received_base < i.qty_base;

REVOKE ALL ON ALL TABLES IN SCHEMA fin FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA fin FROM PUBLIC, anon, authenticated;

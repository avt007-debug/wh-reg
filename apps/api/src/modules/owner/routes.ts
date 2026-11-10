/**
 * Owner / Admin executive dashboard API. Double-gated:
 *   1. requireOwner preHandler (JWT role)
 *   2. SET LOCAL ROLE app_owner + RLS policies that re-check users.role in the DB
 * Employees calling these get 403 from (1); even if (1) were removed, fin.* is
 * not visible to app_employee at all.
 */
import argon2 from 'argon2';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  createUserSchema, dateRangeSchema, purchaseDiscountSchema, reorderPoSchema, stockAdjustmentSchema,
} from '@wh/shared';
import { authenticate, requireOwner } from '../../auth/plugin.js';
import { withSession } from '../../db/pool.js';

const idParam = z.object({ id: z.guid() });

export async function ownerRoutes(app: FastifyInstance) {
  app.addHook('preHandler', authenticate);
  app.addHook('preHandler', requireOwner);

  // ---------------------------------------------------------------- 1. stock overview + valuation
  app.get('/owner/stock-overview', async (req) => {
    const { warehouseId } = z.object({ warehouseId: z.guid().optional() }).parse(req.query);
    return withSession(req.auth, async (c) => {
      // One client = one query at a time (pg does not pipeline); keep these sequential.
      const rows = await c.query(`SELECT * FROM fin.v_stock_overview WHERE ($1::uuid IS NULL OR warehouse_id = $1) ORDER BY name, warehouse_code`, [warehouseId ?? null]);
      const totals = await c.query(`SELECT warehouse_id, warehouse_code, warehouse_name, sum(valuation) AS valuation, count(*) FILTER (WHERE qty_on_hand > 0) AS skus_in_stock
                   FROM fin.v_stock_overview GROUP BY 1, 2, 3 ORDER BY 2`);
      // Pivot: one row per item with a column per warehouse — what the owner screen renders.
      const byItem = new Map<string, Record<string, unknown>>();
      for (const r of rows.rows) {
        const item = byItem.get(r.product_id) ?? { productId: r.product_id, sku: r.sku_code, name: r.name, brand: r.brand,
          category: r.category_path, avgCost: r.avg_effective_cost_base, totalQty: 0, totalValue: 0, perWarehouse: {} };
        (item.perWarehouse as Record<string, number>)[r.warehouse_code] = r.qty_on_hand;
        item.totalQty = (item.totalQty as number) + r.qty_on_hand;
        item.totalValue = (item.totalValue as number) + r.valuation;
        byItem.set(r.product_id, item);
      }
      return { warehouses: totals.rows, items: [...byItem.values()] };
    });
  });

  // ---------------------------------------------------------------- 2. reorder engine
  app.get('/owner/reorder-alerts', async (req) =>
    withSession(req.auth, async (c) => (await c.query(
      'SELECT * FROM fin.v_reorder_alerts ORDER BY (qty_on_hand / nullif(threshold, 0)), warehouse_code, name')).rows));

  app.post('/owner/reorder-alerts/purchase-orders', async (req, reply) => {
    const body = reorderPoSchema.parse(req.body);
    const ids = await withSession(req.auth, async (c) =>
      (await c.query('SELECT fin.create_po_from_reorder($1, $2::uuid[]) AS id', [body.warehouseId, body.productIds])).rows.map((r) => r.id));
    return reply.status(201).send({ purchaseOrderIds: ids });
  });

  // ---------------------------------------------------------------- 3. visuals
  app.get('/owner/sales/trend', async (req) => {
    const q = dateRangeSchema.parse(req.query);
    return withSession(req.auth, async (c) => (await c.query(
      `SELECT date_trunc($3, invoice_date)::date AS bucket, warehouse_code,
              sum(invoices) AS invoices, sum(units_base) AS units, sum(revenue_excl_gst) AS revenue_excl_gst,
              sum(revenue_incl_gst) AS revenue_incl_gst, sum(gross_margin) AS gross_margin
         FROM fin.v_sales_daily
        WHERE invoice_date BETWEEN $1 AND $2 AND ($4::uuid IS NULL OR warehouse_id = $4)
        GROUP BY 1, 2 ORDER BY 1, 2`, [q.from, q.to, q.granularity, q.warehouseId ?? null])).rows);
  });

  app.get('/owner/top-items', async (req) => {
    const q = dateRangeSchema.extend({ limit: z.coerce.number().int().min(1).max(100).default(10) }).parse(req.query);
    return withSession(req.auth, async (c) => (await c.query(
      'SELECT * FROM fin.top_selling_items($1, $2, $3, $4)', [q.from, q.to, q.warehouseId ?? null, q.limit])).rows);
  });

  app.get('/owner/margins', async (req) => {
    const q = dateRangeSchema.parse(req.query);
    return withSession(req.auth, async (c) => (await c.query(
      'SELECT * FROM fin.margin_spread($1, $2, $3)', [q.from, q.to, q.warehouseId ?? null])).rows);
  });

  app.get('/owner/dead-stock', async (req) => {
    const q = z.object({ days: z.coerce.number().int().min(1).max(730).default(45), warehouseId: z.guid().optional() }).parse(req.query);
    return withSession(req.auth, async (c) => (await c.query('SELECT * FROM fin.dead_stock($1, $2)', [q.days, q.warehouseId ?? null])).rows);
  });

  app.get('/owner/staff-performance', async (req) => {
    const q = dateRangeSchema.parse(req.query);
    return withSession(req.auth, async (c) => {
      const staff = await c.query('SELECT * FROM fin.employee_performance($1, $2)', [q.from, q.to]);
      const agents = await c.query('SELECT * FROM fin.sales_agent_performance($1, $2)', [q.from, q.to]);
      const daily = await c.query(`SELECT invoice_date, created_by AS user_id, count(DISTINCT dispatch_id) AS invoices, sum(line_taxable) AS revenue
                   FROM fin.v_sales_lines WHERE invoice_date BETWEEN $1 AND $2 GROUP BY 1, 2 ORDER BY 1`, [q.from, q.to]);
      return { staff: staff.rows, salesAgents: agents.rows, dailyByUser: daily.rows };
    });
  });

  app.get('/owner/customers/:id/ledger', async (req) => {
    const { id } = idParam.parse(req.params);
    return withSession(req.auth, async (c) => (await c.query(
      'SELECT * FROM fin.v_customer_ledger WHERE customer_id = $1 ORDER BY entry_date, created_at', [id])).rows);
  });

  // ---------------------------------------------------------------- purchase discount (owner-private)
  app.get('/owner/purchases/net', async (req) => {
    const q = dateRangeSchema.parse(req.query);
    return withSession(req.auth, async (c) => (await c.query(
      `SELECT * FROM fin.v_purchase_net_summary
        WHERE vendor_invoice_date BETWEEN $1 AND $2 AND ($3::uuid IS NULL OR warehouse_id = $3)
        ORDER BY vendor_invoice_date DESC`, [q.from, q.to, q.warehouseId ?? null])).rows);
  });

  app.put('/owner/purchases/:id/discount', async (req) => {
    const { id } = idParam.parse(req.params);
    const d = purchaseDiscountSchema.parse(req.body);
    return withSession(req.auth, async (c) => {
      await c.query(
        `INSERT INTO fin.purchase_discounts(purchase_id, discount_type, discount_value, reason, entered_by)
         VALUES ($1, $2, $3, $4, app.current_user_id())
         ON CONFLICT (purchase_id) DO UPDATE SET discount_type = EXCLUDED.discount_type,
           discount_value = EXCLUDED.discount_value, reason = EXCLUDED.reason, entered_by = EXCLUDED.entered_by, entered_at = now()`,
        [id, d.discountType, d.discountValue, d.reason ?? null]);
      return (await c.query('SELECT * FROM fin.v_purchase_net_summary WHERE purchase_id = $1', [id])).rows[0];
    });
  });

  // ---------------------------------------------------------------- overrides of stock / documents
  app.post('/owner/stock-adjustments', async (req, reply) => {
    const a = stockAdjustmentSchema.parse(req.body);
    const row = await withSession(req.auth, async (c) => (await c.query(
      `INSERT INTO stock_adjustments(warehouse_id, product_id, movement, qty_delta_base, notes)
       VALUES ($1, $2, $3, $4, $5) RETURNING *`, [a.warehouseId, a.productId, a.movement, a.qtyDeltaBase, a.notes ?? null])).rows[0]);
    return reply.status(201).send(row);
  });

  app.post('/owner/dispatches/:id/cancel', async (req) => {
    const { id } = idParam.parse(req.params);
    const { reason } = z.object({ reason: z.string().min(3) }).parse(req.body);
    await withSession(req.auth, (c) => c.query('SELECT app.cancel_dispatch($1, $2)', [id, reason]));
    return { ok: true };
  });

  app.post('/owner/purchases/:id/cancel', async (req) => {
    const { id } = idParam.parse(req.params);
    const { reason } = z.object({ reason: z.string().min(3) }).parse(req.body);
    await withSession(req.auth, (c) => c.query('SELECT app.cancel_purchase($1, $2)', [id, reason]));
    return { ok: true };
  });

  app.put('/owner/override-pin', async (req) => {
    const { pin } = z.object({ pin: z.string().regex(/^[0-9]{6,8}$/) }).parse(req.body);
    await withSession(req.auth, (c) => c.query('SELECT app.set_override_pin($1)', [pin]));
    return { ok: true };
  });

  // ---------------------------------------------------------------- user & role management
  app.get('/owner/users', async (req) =>
    withSession(req.auth, async (c) => (await c.query(
      `SELECT u.id, u.login_id, u.full_name, u.phone, u.role, u.is_active, u.last_login_at, w.code AS warehouse_code
         FROM users u LEFT JOIN warehouses w ON w.id = u.primary_warehouse_id
        WHERE u.role <> 'SYSTEM' ORDER BY u.role, u.full_name`)).rows));

  app.post('/owner/users', async (req, reply) => {
    const u = createUserSchema.parse(req.body);
    const hash = await argon2.hash(u.password, { type: argon2.argon2id });
    const row = await withSession(req.auth, async (c) => {
      const { rows: [created] } = await c.query(
        `INSERT INTO users(login_id, full_name, phone, role, primary_warehouse_id)
         VALUES ($1, $2, $3, $4, $5) RETURNING id, login_id, role, primary_warehouse_id`,
        [u.loginId, u.fullName, u.phone ?? null, u.role, u.primaryWarehouseId ?? null]);
      await c.query('INSERT INTO auth.credentials(user_id, password_hash) VALUES ($1, $2)', [created.id, hash]);
      return created;
    });
    return reply.status(201).send(row);
  });

  app.patch('/owner/users/:id', async (req) => {
    const { id } = idParam.parse(req.params);
    const b = z.object({
      isActive: z.boolean().optional(),
      primaryWarehouseId: z.guid().optional(),
      role: z.enum(['OWNER', 'ADMIN', 'EMPLOYEE']).optional(),
      newPassword: z.string().min(10).optional(),
    }).parse(req.body);
    const hash = b.newPassword ? await argon2.hash(b.newPassword, { type: argon2.argon2id }) : null;
    return withSession(req.auth, async (c) => {
      await c.query(
        `UPDATE users SET is_active = coalesce($2, is_active), primary_warehouse_id = coalesce($3, primary_warehouse_id),
                role = coalesce($4::user_role, role) WHERE id = $1 AND role <> 'SYSTEM'`,
        [id, b.isActive ?? null, b.primaryWarehouseId ?? null, b.role ?? null]);
      if (hash) {
        await c.query(`UPDATE auth.credentials SET password_hash = $2, failed_attempts = 0, locked_until = NULL,
                       password_changed_at = now() WHERE user_id = $1`, [id, hash]);
      }
      if (b.isActive === false || hash) {
        await c.query('UPDATE auth.refresh_tokens SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL', [id]);
      }
      return { ok: true };
    });
  });
}

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { overrideRequestSchema } from '@wh/shared';
import { authenticate } from '../../auth/plugin.js';
import { withSession } from '../../db/pool.js';
import { HttpError } from '../../lib/errors.js';
import { resolveWarehouse } from '../../lib/warehouse.js';

export async function inventoryRoutes(app: FastifyInstance) {
  app.addHook('preHandler', authenticate);

  /**
   * Physical stock counts. Staff: own warehouse (RLS). Owners: ?warehouseId= or all.
   * No cost or value columns here — valuation lives under /owner/stock-overview.
   */
  app.get('/inventory', async (req) => {
    const q = z.object({ warehouseId: z.guid().optional(), lowOnly: z.stringbool().default(false) }).parse(req.query);
    return withSession(req.auth, async (c) => (await c.query(
      `SELECT il.warehouse_id, p.id AS product_id, p.sku_code, p.name, b.name AS brand, c.path AS category_path,
              p.specification, il.qty_on_hand, il.qty_in_transit,
              coalesce(rr.min_qty_base, p.default_reorder_level) AS reorder_level,
              il.qty_on_hand <= coalesce(rr.min_qty_base, p.default_reorder_level) AS is_low,
              (SELECT json_agg(json_build_object('code', u.uom_code, 'factor', u.factor_to_base) ORDER BY u.factor_to_base DESC)
                 FROM product_uoms u WHERE u.product_id = p.id) AS uoms
         FROM inventory_levels il
         JOIN products p ON p.id = il.product_id
         LEFT JOIN brands b ON b.id = p.brand_id
         LEFT JOIN categories c ON c.id = p.category_id
         LEFT JOIN reorder_rules rr ON rr.warehouse_id = il.warehouse_id AND rr.product_id = il.product_id
        WHERE ($1::uuid IS NULL OR il.warehouse_id = $1)
          AND (NOT $2 OR il.qty_on_hand <= coalesce(rr.min_qty_base, p.default_reorder_level))
        ORDER BY p.name`, [q.warehouseId ?? null, q.lowOnly])).rows);
  });

  /**
   * Exchange the Admin Override PIN for a single-use, 10-minute grant.
   * The attempt is COMMITTED before we report a wrong PIN, so brute force is counted.
   */
  app.post('/overrides', { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } }, async (req) => {
    const body = overrideRequestSchema.parse(req.body);
    const overrideId = await withSession(req.auth, async (c) => {
      const wh = await resolveWarehouse(c, req.auth, body.warehouseId);
      const { rows } = await c.query('SELECT app.request_stock_override($1, $2, $3) AS id', [body.pin, wh, body.reason]);
      return rows[0]?.id as string | null;
    });
    if (!overrideId) throw new HttpError(403, 'INVALID_PIN', 'Incorrect override PIN');
    return { overrideId, expiresInSeconds: 600 };
  });
}

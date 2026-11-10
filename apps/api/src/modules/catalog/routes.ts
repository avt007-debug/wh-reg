import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { authenticate } from '../../auth/plugin.js';
import { withSession } from '../../db/pool.js';
import { presignDownload } from '../../lib/storage.js';

const searchQuery = z.object({
  q: z.string().max(80).default(''),
  brandId: z.guid().optional(),
  categoryId: z.guid().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(25),
});

export async function catalogRoutes(app: FastifyInstance) {
  app.addHook('preHandler', authenticate);

  /** High-speed search: name, brand, category, spec, vernacular aliases, SKU — typo tolerant. */
  app.get('/products/search', async (req) => {
    const q = searchQuery.parse(req.query);
    return withSession(req.auth, async (c) => {
      const { rows } = await c.query(
        `SELECT s.*,
                (SELECT storage_key FROM product_images i WHERE i.product_id = s.id AND i.is_primary) AS image_key,
                (SELECT json_agg(json_build_object('code', u.uom_code, 'factor', u.factor_to_base, 'displayName', u.display_name)
                                 ORDER BY u.factor_to_base DESC)
                   FROM product_uoms u WHERE u.product_id = s.id) AS uoms,
                (SELECT array_agg(alias) FROM product_aliases a WHERE a.product_id = s.id) AS aliases,
                coalesce(il.qty_on_hand, 0) AS qty_on_hand,
                pr.default_selling_price, pr.mrp        -- list prices only; never purchase cost
           FROM app.search_products($1, $2, $3, $4) s
           JOIN products pr ON pr.id = s.id
           LEFT JOIN inventory_levels il ON il.product_id = s.id AND il.warehouse_id = app.current_warehouse_id()`,
        [q.q, q.limit, q.brandId ?? null, q.categoryId ?? null]);
      return Promise.all(rows.map(async (r) => ({ ...r, image_url: r.image_key ? await presignDownload(r.image_key) : null })));
    });
  });

  /** Brand → Category tree → (products via search with categoryId). */
  app.get('/catalog/tree', async (req) =>
    withSession(req.auth, async (c) => {
      const brands = await c.query('SELECT id, name, logo_key FROM brands WHERE is_active ORDER BY name');
      const categories = await c.query('SELECT id, parent_id, name, path, sort_order FROM categories WHERE is_active ORDER BY sort_order, name');
      return { brands: brands.rows, categories: categories.rows };
    }));

  /** Floor staff can teach the system local names ("pana", "pechkas"). */
  app.post('/products/:id/aliases', async (req) => {
    const { id } = z.object({ id: z.guid() }).parse(req.params);
    const body = z.object({ alias: z.string().trim().min(2).max(60), language: z.string().max(10).optional() }).parse(req.body);
    return withSession(req.auth, async (c) => {
      await c.query(
        `INSERT INTO product_aliases(product_id, alias, language) VALUES ($1, $2, $3)
         ON CONFLICT (product_id, lower(alias)) DO NOTHING`, [id, body.alias, body.language ?? null]);
      return { ok: true };
    });
  });

  app.get('/gst-rates', async (req) =>
    withSession(req.auth, async (c) => (await c.query('SELECT rate, label FROM gst_rates WHERE is_active ORDER BY rate')).rows));

  app.get('/warehouses', async (req) =>
    withSession(req.auth, async (c) => (await c.query('SELECT id, code, name, state_code FROM warehouses WHERE is_active ORDER BY code')).rows));

  app.get('/sales-agents', async (req) =>
    withSession(req.auth, async (c) => (await c.query('SELECT id, name FROM sales_agents WHERE is_active ORDER BY name')).rows));

  for (const table of ['customers', 'vendors'] as const) {
    app.get(`/${table}`, async (req) => {
      const { q } = z.object({ q: z.string().max(60).default('') }).parse(req.query);
      return withSession(req.auth, async (c) => (await c.query(
        `SELECT id, name, gstin, state_code, phone FROM ${table}
          WHERE is_active AND ($1 = '' OR name ILIKE '%' || $1 || '%' OR gstin = upper($1))
          ORDER BY similarity(name, $1) DESC, name LIMIT 30`, [q])).rows);
    });
    app.post(`/${table}`, async (req, reply) => {
      const body = z.object({
        name: z.string().trim().min(2).max(120),
        gstin: z.string().trim().toUpperCase().optional(),
        stateCode: z.string().regex(/^[0-9]{2}$/).optional(),
        phone: z.string().optional(),
        address: z.string().max(300).optional(),
      }).parse(req.body);
      const row = await withSession(req.auth, async (c) => (await c.query(
        `INSERT INTO ${table}(name, gstin, state_code, phone, address)
         VALUES ($1, $2, coalesce($3, app.gstin_state($2)), $4, $5) RETURNING id, name, gstin, state_code`,
        [body.name, body.gstin ?? null, body.stateCode ?? null, body.phone ?? null, body.address ?? null])).rows[0]);
      return reply.status(201).send(row);
    });
  }
}

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { createDispatchSchema, dispatchLineSchema, type CreateDispatchInput, type StockShortfall } from '@wh/shared';
import { authenticate } from '../../auth/plugin.js';
import { flushDeferred, withSession, type Db } from '../../db/pool.js';
import { HttpError } from '../../lib/errors.js';
import { resolveWarehouse } from '../../lib/warehouse.js';

const HEADER_COLS = `id, invoice_no, invoice_date, warehouse_id, customer_name, customer_gstin, is_interstate,
  transport_mode, transporter_name, vehicle_reg_no, driver_phone, taxable_total, discount_total,
  cgst_total, sgst_total, igst_total, grand_total, status, override_id IS NOT NULL AS used_override, created_at`;

/** Report ALL shortfalls up-front (DB trigger is still the final guard, under row locks). */
async function shortfalls(c: Db, wh: string, lines: CreateDispatchInput['lines']): Promise<StockShortfall[]> {
  const { rows } = await c.query(
    `WITH req AS (
       SELECT l."productId" AS product_id, sum(l.qty * u.factor_to_base) AS requested
         FROM jsonb_to_recordset($2::jsonb) AS l("productId" uuid, "uomCode" text, qty numeric)
         JOIN product_uoms u ON u.product_id = l."productId" AND u.uom_code = l."uomCode"
        GROUP BY 1)
     SELECT r.product_id, p.name, coalesce(il.qty_on_hand, 0) AS available, r.requested
       FROM req r JOIN products p ON p.id = r.product_id
       LEFT JOIN inventory_levels il ON il.warehouse_id = $1 AND il.product_id = r.product_id
      WHERE r.requested > coalesce(il.qty_on_hand, 0)`, [wh, JSON.stringify(lines)]);
  return rows.map((r) => ({ productId: r.product_id, productName: r.name, availableBase: r.available, requestedBase: r.requested }));
}

export async function dispatchRoutes(app: FastifyInstance) {
  app.addHook('preHandler', authenticate);

  /** Dry-run: live stock check while the user is still building the invoice. */
  app.post('/dispatches/check', async (req) => {
    const body = z.object({ warehouseId: z.guid().optional(), lines: z.array(dispatchLineSchema).min(1).max(200) }).parse(req.body);
    return withSession(req.auth, async (c) => ({ shortfalls: await shortfalls(c, await resolveWarehouse(c, req.auth, body.warehouseId), body.lines) }));
  });

  /**
   * OUTWARD (Sales / Dispatch).
   * 409 INSUFFICIENT_STOCK (details = shortfalls) → app asks for Admin PIN → POST /overrides
   * → resubmit with overrideId. WhatsApp alert is queued atomically at COMMIT.
   */
  app.post('/dispatches', async (req, reply) => {
    const body: CreateDispatchInput = createDispatchSchema.parse(req.body);
    const result = await withSession(req.auth, async (c) => {
      const { rows: [replay] } = await c.query(`SELECT ${HEADER_COLS} FROM dispatches WHERE client_txn_id = $1`, [body.clientTxnId]);
      if (replay) return { replayed: true, dispatch: replay };

      const wh = await resolveWarehouse(c, req.auth, body.warehouseId);
      if (!body.overrideId) {
        const short = await shortfalls(c, wh, body.lines);
        if (short.length) throw new HttpError(409, 'INSUFFICIENT_STOCK', 'Quantity exceeds physical stock in this warehouse', short);
      }

      const { rows: [h] } = await c.query(
        `INSERT INTO dispatches(client_txn_id, warehouse_id, customer_id, sales_agent_id, invoice_no, invoice_date, fy,
                                place_of_supply, is_interstate, transport_mode, transporter_name, vehicle_reg_no,
                                driver_phone, lr_number, eway_bill_no, override_id)
         VALUES ($1, $2, $3, $4, NULL, coalesce($5::date, app.today_ist()), '', NULL, false, $6, $7, $8, $9, $10, $11, $12)
         RETURNING id`, // invoice_no, fy, place_of_supply, is_interstate, created_by: set by DB trigger
        [body.clientTxnId, wh, body.customerId, body.salesAgentId ?? null, body.invoiceDate ?? null, body.transportMode,
         body.transporterName ?? null, body.vehicleRegNo ?? null, body.driverPhone ?? null, body.lrNumber ?? null,
         body.ewayBillNo ?? null, body.overrideId ?? null]);

      await c.query(
        `INSERT INTO dispatch_items(dispatch_id, line_no, product_id, uom_code, conversion_factor, qty,
                                    unit_base_price, discount_pct, gst_rate)
         SELECT $1, e.ord, (e.j->>'productId')::uuid, e.j->>'uomCode', 1, (e.j->>'qty')::numeric,
                (e.j->>'unitBasePrice')::numeric, coalesce((e.j->>'discountPct')::numeric, 0), (e.j->>'gstRate')::numeric
           FROM jsonb_array_elements($2::jsonb) WITH ORDINALITY AS e(j, ord)`,
        [h.id, JSON.stringify(body.lines)]);

      await flushDeferred(c);
      const { rows: [d] } = await c.query(`SELECT ${HEADER_COLS} FROM dispatches WHERE id = $1`, [h.id]);
      return { replayed: false, dispatch: d };
    });
    return reply.status(result.replayed ? 200 : 201).send(result);
  });

  /** "My transactions today" for staff; full list for owners. */
  app.get('/dispatches', async (req) => {
    const q = z.object({ from: z.iso.date().optional(), to: z.iso.date().optional(), warehouseId: z.guid().optional() }).parse(req.query);
    return withSession(req.auth, async (c) => (await c.query(
      `SELECT ${HEADER_COLS},
              (SELECT json_agg(json_build_object('line_no', i.line_no, 'name', p.name, 'uom', i.uom_code, 'qty', i.qty,
                         'unit_final_price', i.unit_final_price, 'line_total', i.line_total) ORDER BY i.line_no)
                 FROM dispatch_items i JOIN products p ON p.id = i.product_id WHERE i.dispatch_id = dispatches.id) AS lines
         FROM dispatches
        WHERE ($1::date IS NULL OR invoice_date >= $1) AND ($2::date IS NULL OR invoice_date <= $2)
          AND ($3::uuid IS NULL OR warehouse_id = $3)
        ORDER BY created_at DESC LIMIT 200`, [q.from ?? null, q.to ?? null, q.warehouseId ?? null])).rows);
  });
}

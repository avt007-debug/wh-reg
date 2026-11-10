import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { createTransferSchema, receiveTransferSchema } from '@wh/shared';
import { authenticate } from '../../auth/plugin.js';
import { withSession } from '../../db/pool.js';
import { resolveWarehouse } from '../../lib/warehouse.js';

/** Inter-Warehouse Transfer Notes — the only path for stock between warehouses. */
export async function transferRoutes(app: FastifyInstance) {
  app.addHook('preHandler', authenticate);

  app.post('/transfers', async (req, reply) => {
    const body = createTransferSchema.parse(req.body);
    const note = await withSession(req.auth, async (c) => {
      const { rows: [replay] } = await c.query('SELECT id, note_no, status FROM transfer_notes WHERE client_txn_id = $1', [body.clientTxnId]);
      if (replay) return replay;
      const from = await resolveWarehouse(c, req.auth, body.fromWarehouseId);
      const { rows: [n] } = await c.query(
        `INSERT INTO transfer_notes(client_txn_id, note_no, from_warehouse_id, to_warehouse_id, vehicle_reg_no, driver_phone, eway_bill_no, remarks)
         VALUES ($1, NULL, $2, $3, $4, $5, $6, $7) RETURNING id, note_no`,
        [body.clientTxnId, from, body.toWarehouseId, body.vehicleRegNo ?? null, body.driverPhone ?? null, body.ewayBillNo ?? null, body.remarks ?? null]);
      await c.query(
        `INSERT INTO transfer_note_items(transfer_note_id, line_no, product_id, uom_code, conversion_factor, qty)
         SELECT $1, e.ord, (e.j->>'productId')::uuid, e.j->>'uomCode', 1, (e.j->>'qty')::numeric
           FROM jsonb_array_elements($2::jsonb) WITH ORDINALITY AS e(j, ord)`,
        [n.id, JSON.stringify(body.lines)]);
      if (body.dispatchNow) await c.query('SELECT app.dispatch_transfer($1, $2)', [n.id, body.overrideId ?? null]);
      return (await c.query('SELECT id, note_no, status FROM transfer_notes WHERE id = $1', [n.id])).rows[0];
    });
    return reply.status(201).send(note);
  });

  app.post('/transfers/:id/dispatch', async (req) => {
    const { id } = z.object({ id: z.guid() }).parse(req.params);
    const { overrideId } = z.object({ overrideId: z.guid().optional() }).parse(req.body ?? {});
    await withSession(req.auth, (c) => c.query('SELECT app.dispatch_transfer($1, $2)', [id, overrideId ?? null]));
    return { ok: true };
  });

  app.post('/transfers/:id/receive', async (req) => {
    const { id } = z.object({ id: z.guid() }).parse(req.params);
    const body = receiveTransferSchema.parse(req.body ?? {});
    const received = body.lines?.map((l) => ({ line_no: l.lineNo, qty_received_base: l.qtyReceivedBase })) ?? null;
    await withSession(req.auth, (c) => c.query('SELECT app.receive_transfer($1, $2::jsonb)', [id, received ? JSON.stringify(received) : null]));
    return { ok: true };
  });

  /** Inbound + outbound notes for the user's warehouse (RLS: either end). */
  app.get('/transfers', async (req) => {
    const { status } = z.object({ status: z.enum(['DRAFT', 'IN_TRANSIT', 'RECEIVED', 'CANCELLED']).optional() }).parse(req.query);
    return withSession(req.auth, async (c) => (await c.query(
      `SELECT n.id, n.note_no, n.status, n.from_warehouse_id, fw.code AS from_code, n.to_warehouse_id, tw.code AS to_code,
              n.vehicle_reg_no, n.created_at, n.dispatched_at, n.received_at,
              (SELECT json_agg(json_build_object('line_no', i.line_no, 'product_id', i.product_id, 'name', p.name,
                         'uom', i.uom_code, 'qty', i.qty, 'qty_base', i.qty_base, 'qty_received_base', i.qty_received_base)
                         ORDER BY i.line_no)
                 FROM transfer_note_items i JOIN products p ON p.id = i.product_id WHERE i.transfer_note_id = n.id) AS lines
         FROM transfer_notes n
         JOIN warehouses fw ON fw.id = n.from_warehouse_id
         JOIN warehouses tw ON tw.id = n.to_warehouse_id
        WHERE ($1::transfer_status IS NULL OR n.status = $1)
        ORDER BY n.created_at DESC LIMIT 100`, [status ?? null])).rows);
  });
}

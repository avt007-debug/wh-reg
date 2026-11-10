import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { createPurchaseSchema, type CreatePurchaseInput } from '@wh/shared';
import { authenticate } from '../../auth/plugin.js';
import { flushDeferred, withSession, type Db } from '../../db/pool.js';
import { presignUpload } from '../../lib/storage.js';
import { resolveWarehouse } from '../../lib/warehouse.js';

const HEADER_COLS = `id, warehouse_id, vendor_name, vendor_gstin, vendor_invoice_no, vendor_invoice_date, received_on,
  is_interstate, taxable_total, cgst_total, sgst_total, igst_total, freight_amount, grand_total, status, created_at`;

async function findByClientTxn(c: Db, clientTxnId: string) {
  const { rows } = await c.query(`SELECT ${HEADER_COLS} FROM purchases WHERE client_txn_id = $1`, [clientTxnId]);
  return rows[0];
}

export async function purchaseRoutes(app: FastifyInstance) {
  app.addHook('preHandler', authenticate);

  /** Presigned upload for the lorry receipt / vendor invoice photo (before submitting the inward). */
  app.post('/purchases/attachments/presign', async (req) => {
    const { mimeType } = z.object({ mimeType: z.enum(['image/jpeg', 'image/png', 'image/webp', 'application/pdf']) }).parse(req.body);
    const wh = req.auth.warehouseId ?? 'owner';
    return presignUpload(`purchases/${wh}`, mimeType);
  });

  /** INWARD (Goods Receipt). One transaction: header + lines + attachments → stock posted by triggers. */
  app.post('/purchases', async (req, reply) => {
    const body: CreatePurchaseInput = createPurchaseSchema.parse(req.body);
    const result = await withSession(req.auth, async (c) => {
      const replay = await findByClientTxn(c, body.clientTxnId);       // idempotent retry from a flaky network
      if (replay) return { replayed: true, purchase: replay };

      const wh = await resolveWarehouse(c, req.auth, body.warehouseId);
      const { rows: [h] } = await c.query(
        `INSERT INTO purchases(client_txn_id, warehouse_id, vendor_id, vendor_name, vendor_invoice_no,
                               vendor_invoice_date, lorry_receipt_no, freight_amount, is_interstate)
         VALUES ($1, $2, $3, NULL, $4, $5, $6, $7, false)      -- vendor snapshot + is_interstate set by trigger
         RETURNING id`,
        [body.clientTxnId, wh, body.vendorId, body.vendorInvoiceNo, body.vendorInvoiceDate,
         body.lorryReceiptNo ?? null, body.freightAmount]);

      await c.query(
        `INSERT INTO purchase_items(purchase_id, line_no, product_id, uom_code, conversion_factor, qty,
                                    hsn_code, gst_rate, unit_base_price, unit_incl_price)
         SELECT $1, e.ord, (e.j->>'productId')::uuid, e.j->>'uomCode', 1, (e.j->>'qty')::numeric, e.j->>'hsnCode',
                (e.j->>'gstRate')::numeric, (e.j->>'unitBasePrice')::numeric, (e.j->>'unitInclPrice')::numeric
           FROM jsonb_array_elements($2::jsonb) WITH ORDINALITY AS e(j, ord)`,
        [h.id, JSON.stringify(body.lines)]);

      for (const a of body.attachmentKeys) {
        await c.query('INSERT INTO purchase_attachments(purchase_id, kind, storage_key, mime_type) VALUES ($1, $2, $3, $4)',
          [h.id, a.kind, a.storageKey, a.mimeType]);
      }
      await flushDeferred(c);                                         // compute totals now
      const { rows: [p] } = await c.query(`SELECT ${HEADER_COLS} FROM purchases WHERE id = $1`, [h.id]);
      return { replayed: false, purchase: p };
    });
    return reply.status(result.replayed ? 200 : 201).send(result);
  });

  /** Staff: own entries today (RLS). Owners: everything, filterable. */
  app.get('/purchases', async (req) => {
    const q = z.object({ from: z.iso.date().optional(), to: z.iso.date().optional(), warehouseId: z.guid().optional() }).parse(req.query);
    return withSession(req.auth, async (c) => (await c.query(
      `SELECT ${HEADER_COLS},
              (SELECT json_agg(json_build_object('line_no', i.line_no, 'product_id', i.product_id, 'name', p.name,
                         'uom', i.uom_code, 'qty', i.qty, 'gst_rate', i.gst_rate,
                         'unit_base_price', i.unit_base_price, 'line_total', i.line_total) ORDER BY i.line_no)
                 FROM purchase_items i JOIN products p ON p.id = i.product_id WHERE i.purchase_id = purchases.id) AS lines
         FROM purchases
        WHERE ($1::date IS NULL OR received_on >= $1) AND ($2::date IS NULL OR received_on <= $2)
          AND ($3::uuid IS NULL OR warehouse_id = $3)
        ORDER BY created_at DESC LIMIT 200`, [q.from ?? null, q.to ?? null, q.warehouseId ?? null])).rows);
  });
}

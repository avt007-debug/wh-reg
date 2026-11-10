// deno test supabase/functions/tests
import { strict as a } from 'node:assert';
import {
  clean, dispatchAlertParams, eodDigestParams, itemsSummary, sendTemplate, validSignature, WhatsAppError,
} from '../_shared/whatsapp.ts';

Deno.test('clean() strips characters Meta rejects', () => {
  a.equal(clean('Sri\nHardware\t  &     Sanitary'), 'Sri Hardware & Sanitary');
  a.equal(clean(''), '-');
});

Deno.test('dispatch alert has the 9 template variables', () => {
  const p = dispatchAlertParams({
    warehouse_name: 'Warehouse A – Bengaluru', customer_name: 'Sri Hardware & Sanitary', invoice_no: 'WHA/26-27/00001',
    customer_gstin: '29AABCS5678L1ZM', agent_name: 'Manjunath (Field)',
    items: [{ name: 'Impact Drill GSB 13 RE', qty: 40, uom: 'PCS' }, { name: 'Nylon Wall Plug SX 8x40', qty: 1, uom: 'CTN' }],
    taxable_total: 125200, grand_total: 147736, transport_mode: 'TRANSPORTER',
    transporter_name: 'VRL Logistics', vehicle_reg_no: 'KA01AB1234', driver_phone: '9845012345',
  });
  a.equal(p.length, 9);
  a.equal(p[5], 'Impact Drill GSB 13 RE x40 PCS; Nylon Wall Plug SX 8x40 x1 CTN');
  a.equal(p[6], '₹1,25,200.00');
  a.equal(p[7], '₹1,47,736.00');
  a.equal(p[8], 'VRL Logistics · KA01AB1234 · Driver 9845012345');
});

Deno.test('long item lists are truncated with "+N more"', () => {
  const items = Array.from({ length: 40 }, (_, i) => ({ name: `Heavy Duty Item Number ${i}`, qty: i + 1, uom: 'PCS' }));
  const s = itemsSummary(items);
  a.ok(s.length <= 380);
  a.match(s, /\+\d+ more$/);
});

Deno.test('EOD digest covers any number of warehouses', () => {
  const p = eodDigestParams({
    date: '2026-11-10', combined_incl_gst: 165294.4,
    warehouses: [{ code: 'WHA', name: 'Warehouse A', total_incl_gst: 165294.4, invoices: 2 },
                 { code: 'WHB', name: 'Warehouse B', total_incl_gst: 0, invoices: 0 }],
    low_stock: [{ wh: 'WHB', sku: 'STN-CS-1724', name: 'Spanner set', qty: 0, min: 20 }],
  });
  a.equal(p[1], 'Warehouse A Total: ₹1,65,294.40 | Warehouse B Total: ₹0.00');
  a.equal(p[3], 'WHB:STN-CS-1724 x0 (min 20)');
});

Deno.test('webhook signature: valid accepted, tampered rejected', async () => {
  const body = '{"entry":[]}';
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode('test-secret'), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const hex = Array.from(new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(body))),
    (b) => b.toString(16).padStart(2, '0')).join('');
  a.equal(await validSignature(body, `sha256=${hex}`, 'test-secret'), true);
  a.equal(await validSignature('{"entry":[1]}', `sha256=${hex}`, 'test-secret'), false);
  a.equal(await validSignature(body, null, 'test-secret'), false);
});

Deno.test('Graph API errors are classified retryable / permanent', async () => {
  const cfg = { graphVersion: 'v24.0', phoneNumberId: '1', accessToken: 't', language: 'en', dryRun: false };
  const fake = (status: number, code: number) => () =>
    Promise.resolve(new Response(JSON.stringify({ error: { message: 'x', code } }), { status }));
  await a.rejects(sendTemplate(cfg, '91', 't', [], fake(400, 130429)), (e: WhatsAppError) => e.retryable === true);
  await a.rejects(sendTemplate(cfg, '91', 't', [], fake(400, 132000)), (e: WhatsAppError) => e.retryable === false);
  const ok = () => Promise.resolve(new Response(JSON.stringify({ messages: [{ id: 'wamid.1' }] }), { status: 200 }));
  a.equal((await sendTemplate(cfg, '91', 't', ['a'], ok)).messageId, 'wamid.1');
});

import { createHmac } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';

vi.mock('../../config.js', () => ({ config: { WA_APP_SECRET: 'test-secret' } }));
vi.mock('../../db/pool.js', () => ({ withSystem: vi.fn() }));

const { clean, dispatchAlertParams, eodDigestParams, itemsSummary } = await import('./templates.js');
const { validSignature } = await import('./webhook.js');

describe('template params', () => {
  it('strips characters Meta rejects', () => {
    expect(clean('Sri\nHardware\t  &     Sanitary')).toBe('Sri Hardware & Sanitary');
    expect(clean('')).toBe('-');
  });

  it('builds the 9 dispatch-alert variables', () => {
    const p = dispatchAlertParams({
      warehouse_name: 'Warehouse A – Bengaluru', customer_name: 'Sri Hardware & Sanitary', invoice_no: 'WHA/26-27/00001',
      customer_gstin: '29AABCS5678L1ZM', agent_name: 'Manjunath (Field)',
      items: [{ name: 'Impact Drill GSB 13 RE', qty: 40, uom: 'PCS' }, { name: 'Nylon Wall Plug SX 8x40', qty: 1, uom: 'CTN' }],
      taxable_total: 125200, grand_total: 147736, transport_mode: 'TRANSPORTER',
      transporter_name: 'VRL Logistics', vehicle_reg_no: 'KA01AB1234', driver_phone: '9845012345',
    });
    expect(p).toHaveLength(9);
    expect(p[5]).toBe('Impact Drill GSB 13 RE x40 PCS; Nylon Wall Plug SX 8x40 x1 CTN');
    expect(p[6]).toBe('₹1,25,200.00');
    expect(p[7]).toBe('₹1,47,736.00');
    expect(p[8]).toBe('VRL Logistics · KA01AB1234 · Driver 9845012345');
    expect(p.every((v) => !/[\n\t]| {4,}/.test(v))).toBe(true);
  });

  it('truncates long item lists with a "+N more" tail', () => {
    const items = Array.from({ length: 40 }, (_, i) => ({ name: `Heavy Duty Item Number ${i}`, qty: i + 1, uom: 'PCS' }));
    const s = itemsSummary(items);
    expect(s.length).toBeLessThanOrEqual(380);
    expect(s).toMatch(/\+\d+ more$/);
  });

  it('builds the EOD digest for any number of warehouses', () => {
    const p = eodDigestParams({
      date: '2026-11-10', combined_incl_gst: 165294.4,
      warehouses: [{ code: 'WHA', name: 'Warehouse A', total_incl_gst: 165294.4, invoices: 2 },
                   { code: 'WHB', name: 'Warehouse B', total_incl_gst: 0, invoices: 0 }],
      low_stock: [{ wh: 'WHB', sku: 'STN-CS-1724', name: 'Spanner set', qty: 0, min: 20 }],
    });
    expect(p[1]).toBe('Warehouse A Total: ₹1,65,294.40 | Warehouse B Total: ₹0.00');
    expect(p[3]).toBe('WHB:STN-CS-1724 x0 (min 20)');
  });
});

describe('webhook signature', () => {
  const body = Buffer.from('{"entry":[]}');
  const sig = 'sha256=' + createHmac('sha256', 'test-secret').update(body).digest('hex');
  it('accepts a valid signature and rejects tampering', () => {
    expect(validSignature(body, sig)).toBe(true);
    expect(validSignature(Buffer.from('{"entry":[1]}'), sig)).toBe(false);
    expect(validSignature(body, undefined)).toBe(false);
  });
});

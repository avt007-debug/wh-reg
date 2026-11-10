import { describe, expect, it } from 'vitest';
import {
  breakdown, createDispatchSchema, documentTotals, formatBreakdown, formatINR, fromBase, fromInclusive,
  isConsistent, isValidGstin, isValidVehicleNo, purchaseLine, round, saleLine, splitTax,
} from './index.js';

// Numbers here are deliberately the SAME as db/tests/rls_and_rules_test.sql,
// proving the app preview equals what Postgres stores.

describe('rounding', () => {
  it('rounds half away from zero without float artefacts', () => {
    expect(round(1.005, 2)).toBe(1.01);
    expect(round(2.675, 2)).toBe(2.68);
    expect(round(-1.005, 2)).toBe(-1.01);
    expect(round(0.1 + 0.2, 2)).toBe(0.3);
  });
});

describe('GST base ⇄ inclusive', () => {
  it('derives inclusive from base', () => {
    expect(fromBase(3500, 18)).toEqual({ base: 3500, inclusive: 4130, tax: 630 });
  });
  it('back-calculates base from inclusive and stays DB-consistent', () => {
    const p = fromInclusive(3200, 18);
    expect(p.base).toBe(2711.8644);
    expect(isConsistent(p.base, p.inclusive, 18)).toBe(true);
  });
  it('round-trips for every slab and many prices', () => {
    for (const rate of [0, 5, 12, 18, 28, 40]) {
      for (let incl = 0.5; incl < 50000; incl = round(incl * 1.37 + 0.13, 2)) {
        const p = fromInclusive(incl, rate);
        expect(isConsistent(p.base, incl, rate)).toBe(true);
      }
    }
  });
});

describe('line & document totals (mirror SQL generated columns)', () => {
  it('purchase: 10 BOX × ₹3,500 @18% intra-state', () => {
    const l = purchaseLine(10, 3500, 18);
    const t = documentTotals([l], false);
    expect([t.taxable, t.cgst, t.sgst, t.igst, t.grandTotal]).toEqual([35000, 3150, 3150, 0, 41300]);
  });
  it('purchase: inter-state 5 × inclusive ₹3,200', () => {
    const t = documentTotals([purchaseLine(5, fromInclusive(3200, 18).base, 18)], true);
    expect([t.igst, t.grandTotal]).toEqual([2440.68, 16000]);
  });
  it('dispatch: 40 drills @ ₹3,200 less 5% + 1 CTN plugs @ ₹3,600', () => {
    const lines = [saleLine(40, 3200, 5, 18), saleLine(1, 3600, 0, 18)];
    const t = documentTotals(lines, false);
    expect(lines[0]!.unitFinal).toBe(3040);
    expect([t.taxable, t.discount, t.cgst, t.sgst, t.grandTotal]).toEqual([125200, 6400, 11268, 11268, 147736]);
  });
  it('odd paisa goes to SGST', () => {
    expect(splitTax(10.01, false)).toEqual({ cgst: 5.01, sgst: 5, igst: 0 });
  });
  it('formats Indian grouping', () => {
    expect(formatINR(147736)).toBe('₹1,47,736.00');
  });
});

describe('units of measure', () => {
  const plugs = [{ code: 'CTN', factor: 2000 }, { code: 'BOX', factor: 100 }, { code: 'PCS', factor: 1 }];
  it('breaks base qty into packs', () => {
    expect(breakdown(4325, plugs)).toEqual([{ code: 'CTN', qty: 2 }, { code: 'BOX', qty: 3 }, { code: 'PCS', qty: 25 }]);
    expect(formatBreakdown(8000, plugs)).toBe('4 CTN');
    expect(formatBreakdown(0, plugs)).toBe('0 PCS');
    expect(formatBreakdown(-10, plugs)).toBe('-10 PCS');
  });
});

describe('India identifiers', () => {
  it('validates GSTIN checksum', () => {
    expect(isValidGstin('27AAPFU0939F1ZV')).toBe(true);
    expect(isValidGstin('27AAPFU0939F1ZX')).toBe(false);
    expect(isValidGstin('29AAHCW5544N1ZJ')).toBe(true);
  });
  it('validates vehicle numbers incl. BH series', () => {
    expect(isValidVehicleNo('ka-01 ab 1234')).toBe(true);
    expect(isValidVehicleNo('22BH1234AB')).toBe(true);
    expect(isValidVehicleNo('KA1')).toBe(false);
  });
});

describe('dispatch contract', () => {
  const base = {
    clientTxnId: '0b9f3c1e-8a2d-4c55-9a51-3e3b2f6f7a10',
    customerId: '0b9f3c1e-8a2d-4c55-9a51-3e3b2f6f7a11',
    lines: [{ productId: '0b9f3c1e-8a2d-4c55-9a51-3e3b2f6f7a12', uomCode: 'PCS', qty: 1, unitBasePrice: 10 }],
  };
  it('requires a vehicle for road transport', () => {
    expect(createDispatchSchema.safeParse({ ...base, transportMode: 'TRANSPORTER' }).success).toBe(false);
    const ok = createDispatchSchema.parse({ ...base, transportMode: 'TRANSPORTER', vehicleRegNo: 'ka 01 ab 1234', driverPhone: '+91 98450 12345' });
    expect(ok.vehicleRegNo).toBe('KA01AB1234');
    expect(ok.driverPhone).toBe('9845012345');
  });
});

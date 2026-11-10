/**
 * Packaging / unit-of-measure helpers.
 * Every product has one BASE unit (factor 1, usually PCS). Larger packs carry a
 * factor relative to the base: CTN = 2000, BOX = 100, PCS = 1.
 * Stock is always stored in base units; these helpers convert for display/entry.
 */
import { round } from './gst.js';

export interface Uom {
  code: string;          // 'CTN' | 'BOX' | 'PCS' | 'MTR' ...
  factor: number;        // factor_to_base
  displayName?: string;
}

export const toBaseQty = (qty: number, factor: number) => round(qty * factor, 3);
export const fromBaseQty = (qtyBase: number, factor: number) => round(qtyBase / factor, 3);

export interface BreakdownPart { code: string; qty: number }

/**
 * Greedy breakdown of a base quantity into packs, largest first.
 * 4325 pcs with CTN=2000, BOX=100 → [2 CTN, 3 BOX, 25 PCS]
 */
export function breakdown(qtyBase: number, uoms: Uom[]): BreakdownPart[] {
  const sign = qtyBase < 0 ? -1 : 1;
  let rest = Math.abs(qtyBase);
  const sorted = [...uoms].sort((a, b) => b.factor - a.factor);
  const base = sorted.find((u) => u.factor === 1);
  const parts: BreakdownPart[] = [];
  for (const u of sorted) {
    if (u.factor === 1) continue;
    const n = Math.floor(round(rest / u.factor, 6));
    if (n > 0) {
      parts.push({ code: u.code, qty: sign * n });
      rest = round(rest - n * u.factor, 3);
    }
  }
  if (rest > 0 || parts.length === 0) parts.push({ code: base?.code ?? 'PCS', qty: sign * rest });
  return parts;
}

export function formatBreakdown(qtyBase: number, uoms: Uom[]): string {
  return breakdown(qtyBase, uoms).map((p) => `${p.qty} ${p.code}`).join(' + ');
}

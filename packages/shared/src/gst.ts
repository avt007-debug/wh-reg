/**
 * GST arithmetic shared by the mobile app (live preview) and the API (pre-checks).
 *
 * The DATABASE is the source of truth: these functions replicate the exact
 * rounding of the generated columns in purchase_items / dispatch_items so the
 * totals the user sees before saving equal what Postgres stores.
 *
 *   unit prices  -> 4 decimals   (so a base price back-calculated from an
 *                                 inclusive price round-trips exactly)
 *   amounts      -> 2 decimals, half-away-from-zero (Postgres numeric round)
 */

/** Slabs offered by default. Real list comes from GET /gst-rates (owner can toggle). */
export const DEFAULT_GST_SLABS = [0, 5, 12, 18, 28] as const;

/** Postgres-compatible round (half away from zero) without binary-float surprises. */
export function round(x: number, dp: number): number {
  if (!Number.isFinite(x)) throw new RangeError(`Cannot round ${x}`);
  const sign = x < 0 ? -1 : 1;
  const scaled = Number((Math.abs(x) * 10 ** dp).toPrecision(15));
  return (sign * Math.round(scaled)) / 10 ** dp;
}
export const round2 = (x: number) => round(x, 2);
export const round4 = (x: number) => round(x, 4);

export interface UnitPrice {
  /** price excluding GST, per selected unit (4 dp) */
  base: number;
  /** price including GST, per selected unit (2 dp) */
  inclusive: number;
  /** GST amount per unit (2 dp, informational) */
  tax: number;
}

/** User typed the BASE price → derive the inclusive price. */
export function fromBase(base: number, gstRate: number): UnitPrice {
  assertNonNegative(base, 'base price');
  const b = round4(base);
  const inclusive = round2(b * (1 + gstRate / 100));
  return { base: b, inclusive, tax: round2(inclusive - b) };
}

/** User typed the INCLUSIVE price → back-calculate the base price. */
export function fromInclusive(inclusive: number, gstRate: number): UnitPrice {
  assertNonNegative(inclusive, 'inclusive price');
  const base = round4(inclusive / (1 + gstRate / 100));
  return { base, inclusive: round2(inclusive), tax: round2(inclusive - base) };
}

/** Same tolerance as the DB CHECK constraint purchase_gst_consistent. */
export function isConsistent(base: number, inclusive: number, gstRate: number): boolean {
  return Math.abs(inclusive - round2(base * (1 + gstRate / 100))) <= 0.01;
}

export interface LineAmounts {
  gross: number;      // qty × base price, before discount
  discount: number;   // gross − taxable
  unitFinal: number;  // final price excl. GST per unit (after discount)
  taxable: number;    // Final Price (excl. GST) × qty
  tax: number;
  total: number;      // incl. GST
}

/** Purchase line: no line discount (owner's private discount is applied separately). */
export function purchaseLine(qty: number, unitBase: number, gstRate: number): LineAmounts {
  return saleLine(qty, unitBase, 0, gstRate);
}

/** Dispatch line — mirrors dispatch_items generated columns exactly. */
export function saleLine(qty: number, unitBase: number, discountPct: number, gstRate: number): LineAmounts {
  assertNonNegative(qty, 'quantity');
  if (discountPct < 0 || discountPct > 100) throw new RangeError('discount % must be 0–100');
  const unitFinal = round4(unitBase * (1 - discountPct / 100));
  const gross = round2(qty * unitBase);
  const taxable = round2(qty * unitFinal);
  const tax = round2((taxable * gstRate) / 100);
  return { gross, discount: round2(gross - taxable), unitFinal, taxable, tax, total: round2(taxable + tax) };
}

export interface TaxSplit { cgst: number; sgst: number; igst: number }

/** Intra-state → CGST + SGST (half each, odd paisa to SGST). Inter-state → IGST. */
export function splitTax(totalTax: number, interstate: boolean): TaxSplit {
  if (interstate) return { cgst: 0, sgst: 0, igst: round2(totalTax) };
  const cgst = round2(totalTax / 2);
  return { cgst, sgst: round2(totalTax - cgst), igst: 0 };
}

export interface DocumentTotals extends TaxSplit {
  gross: number; discount: number; taxable: number; tax: number; freight: number; grandTotal: number;
}

export function documentTotals(lines: LineAmounts[], interstate: boolean, freight = 0): DocumentTotals {
  const sum = (k: keyof LineAmounts) => round2(lines.reduce((a, l) => a + l[k], 0));
  const taxable = sum('taxable');
  const tax = sum('tax');
  return {
    gross: sum('gross'), discount: sum('discount'), taxable, tax, freight: round2(freight),
    ...splitTax(tax, interstate),
    grandTotal: round2(taxable + tax + freight),
  };
}

/** Indian digit grouping: 147736 → "₹1,47,736.00" */
export function formatINR(amount: number, withSymbol = true): string {
  const s = new Intl.NumberFormat('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(amount);
  return withSymbol ? `₹${s}` : s;
}

function assertNonNegative(v: number, what: string) {
  if (!Number.isFinite(v) || v < 0) throw new RangeError(`${what} must be a non-negative number`);
}

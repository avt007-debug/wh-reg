/**
 * Builds template parameters. Meta rejects parameters containing newlines,
 * tabs or more than 4 consecutive spaces, and caps a template body at 1024
 * characters — so every value is sanitised and the item list is truncated.
 */
import { formatINR } from '@wh/shared';

export const clean = (s: string | null | undefined, max = 120) => {
  const v = (s ?? '').replace(/\s+/g, ' ').trim();   // newlines/tabs/runs of spaces -> one space
  return (v.length > max ? `${v.slice(0, max - 1)}…` : v) || '-';
};

export interface DispatchAlertData {
  warehouse_name: string;
  customer_name: string;
  invoice_no: string;
  customer_gstin: string | null;
  agent_name: string | null;
  items: { name: string; qty: number; uom: string }[];
  taxable_total: number;
  grand_total: number;
  transport_mode: string;
  transporter_name: string | null;
  vehicle_reg_no: string | null;
  driver_phone: string | null;
}

export function itemsSummary(items: DispatchAlertData['items'], max = 380): string {
  const parts: string[] = [];
  let len = 0;
  for (let i = 0; i < items.length; i++) {
    const it = items[i]!;
    const p = `${it.name} x${it.qty} ${it.uom}`;
    const more = items.length - i - 1;
    if (len + p.length + 2 > max - (more ? 12 : 0)) {
      parts.push(`+${items.length - i} more`);
      break;
    }
    parts.push(p);
    len += p.length + 2;
  }
  return parts.join('; ');
}

/**
 * Template `dispatch_alert` (UTILITY), 9 variables:
 * Dispatch Alert - {{1}} | Customer: {{2}} | Invoice #: {{3}} | Customer GSTIN: {{4}} | Sales Agent: {{5}}
 * | Items: {{6}} | Total Excl. GST: {{7}} | Total Incl. GST: {{8}} | Transport: {{9}} | Sent automatically by WH Reg.
 */
export function dispatchAlertParams(d: DispatchAlertData): string[] {
  const transport = [d.transporter_name ?? d.transport_mode.replaceAll('_', ' '), d.vehicle_reg_no,
    d.driver_phone ? `Driver ${d.driver_phone}` : null].filter(Boolean).join(' · ');
  return [
    clean(d.warehouse_name, 60),
    clean(d.customer_name, 80),
    clean(d.invoice_no, 20),
    clean(d.customer_gstin ?? 'Unregistered', 20),
    clean(d.agent_name ?? 'Counter', 60),
    clean(itemsSummary(d.items), 400),
    formatINR(d.taxable_total),
    formatINR(d.grand_total),
    clean(transport, 100),
  ];
}

export interface EodData {
  date: string;
  warehouses: { code: string; name: string; total_incl_gst: number; invoices: number }[];
  combined_incl_gst: number;
  low_stock: { wh: string; sku: string; name: string; qty: number; min: number }[];
}

/**
 * Template `eod_digest` (UTILITY), 4 variables — supports any number of warehouses:
 * EOD Warehouse Digest ({{1}}) | {{2}} | Combined Sales: {{3}} | Critical Low Stock SKUs: {{4}} | Sent automatically by WH Reg.
 */
export function eodDigestParams(d: EodData): string[] {
  const perWh = d.warehouses.map((w) => `${w.name} Total: ${formatINR(w.total_incl_gst)}`).join(' | ');
  const low = d.low_stock.length
    ? itemsSummary(d.low_stock.map((l) => ({ name: `${l.wh}:${l.sku}`, qty: l.qty, uom: `(min ${l.min})` })), 400)
    : 'None';
  return [clean(d.date, 12), clean(perWh, 400), formatINR(d.combined_incl_gst), clean(low, 420)];
}

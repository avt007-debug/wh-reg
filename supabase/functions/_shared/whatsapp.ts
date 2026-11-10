/**
 * Meta WhatsApp Business Cloud API — template messages + parameter builders.
 * Pure TypeScript (Web APIs only) so it runs in Deno Edge Functions and unit tests.
 *
 * Business-initiated messages outside a 24 h customer-service window must be
 * pre-approved templates. Both alerts are UTILITY templates (template texts in
 * docs/WHATSAPP.md). Meta rejects parameters with newlines/tabs or long runs of
 * spaces, and caps a template body at 1024 chars — everything is sanitised and
 * the item list is truncated with "+N more".
 */

export const formatINR = (n: number) =>
  '₹' + new Intl.NumberFormat('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(Number(n));

export const clean = (s: string | null | undefined, max = 120) => {
  const v = (s ?? '').replace(/\s+/g, ' ').trim();          // newlines/tabs/runs of spaces → one space
  return (v.length > max ? `${v.slice(0, max - 1)}…` : v) || '-';
};

export interface DispatchAlertData {
  warehouse_name: string; customer_name: string; invoice_no: string; customer_gstin: string | null;
  agent_name: string | null; items: { name: string; qty: number; uom: string }[];
  taxable_total: number; grand_total: number; transport_mode: string;
  transporter_name: string | null; vehicle_reg_no: string | null; driver_phone: string | null;
}

export function itemsSummary(items: { name: string; qty: number; uom: string }[], max = 380): string {
  const parts: string[] = [];
  let len = 0;
  for (let i = 0; i < items.length; i++) {
    const it = items[i]!;
    const p = `${it.name} x${Number(it.qty)} ${it.uom}`;
    const more = items.length - i - 1;
    if (len + p.length + 2 > max - (more ? 12 : 0)) { parts.push(`+${items.length - i} more`); break; }
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
    clean(d.warehouse_name, 60), clean(d.customer_name, 80), clean(d.invoice_no, 20),
    clean(d.customer_gstin ?? 'Unregistered', 20), clean(d.agent_name ?? 'Counter', 60),
    clean(itemsSummary(d.items), 400), formatINR(d.taxable_total), formatINR(d.grand_total), clean(transport, 100),
  ];
}

export interface EodData {
  date: string;
  warehouses: { code: string; name: string; total_incl_gst: number; invoices: number }[];
  combined_incl_gst: number;
  low_stock: { wh: string; sku: string; name: string; qty: number; min: number }[];
}

/**
 * Template `eod_digest` (UTILITY), 4 variables — any number of warehouses:
 * EOD Warehouse Digest ({{1}}) | {{2}} | Combined Sales: {{3}} | Critical Low Stock SKUs: {{4}} | Sent automatically by WH Reg.
 */
export function eodDigestParams(d: EodData): string[] {
  const perWh = d.warehouses.map((w) => `${w.name} Total: ${formatINR(w.total_incl_gst)}`).join(' | ');
  const low = d.low_stock.length
    ? itemsSummary(d.low_stock.map((l) => ({ name: `${l.wh}:${l.sku}`, qty: l.qty, uom: `(min ${Number(l.min)})` })), 400)
    : 'None';
  return [clean(d.date, 12), clean(perWh, 400), formatINR(d.combined_incl_gst), clean(low, 420)];
}

export class WhatsAppError extends Error {
  constructor(message: string, public code: number | undefined, public retryable: boolean) { super(message); }
}

// Meta error codes worth retrying: throughput / pair-rate limits and transient service errors.
const RETRYABLE = new Set([1, 2, 4, 80007, 130429, 131000, 131016, 131056, 133004]);

export interface WaConfig {
  graphVersion: string; phoneNumberId: string; accessToken: string; language: string; dryRun: boolean;
}

export function waConfigFromEnv(get: (k: string) => string | undefined): WaConfig {
  return {
    graphVersion: get('WA_GRAPH_VERSION') ?? 'v24.0',
    phoneNumberId: get('WA_PHONE_NUMBER_ID') ?? '',
    accessToken: get('WA_ACCESS_TOKEN') ?? '',
    language: get('WA_TEMPLATE_LANG') ?? 'en',
    dryRun: (get('WA_DRY_RUN') ?? 'true') !== 'false',
  };
}

export async function sendTemplate(cfg: WaConfig, to: string, template: string, params: string[], fetchImpl = fetch) {
  if (cfg.dryRun) {
    console.log(`[whatsapp:dry-run] → ${to} ${template}`, JSON.stringify(params));
    return { messageId: `dry-run-${crypto.randomUUID()}` };
  }
  const res = await fetchImpl(`https://graph.facebook.com/${cfg.graphVersion}/${cfg.phoneNumberId}/messages`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${cfg.accessToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      messaging_product: 'whatsapp', recipient_type: 'individual', to, type: 'template',
      template: { name: template, language: { code: cfg.language },
                  components: [{ type: 'body', parameters: params.map((text) => ({ type: 'text', text })) }] },
    }),
    signal: AbortSignal.timeout(15_000),
  });
  const body = await res.json().catch(() => ({})) as { messages?: { id: string }[]; error?: { message?: string; code?: number } };
  if (!res.ok || !body.messages?.[0]) {
    const code = body.error?.code;
    throw new WhatsAppError(body.error?.message ?? `HTTP ${res.status}`, code,
      res.status >= 500 || res.status === 429 || (code !== undefined && RETRYABLE.has(code)));
  }
  return { messageId: body.messages[0].id };
}

/** X-Hub-Signature-256 = 'sha256=' + hex(HMAC-SHA256(app secret, raw body)). */
export async function validSignature(raw: string, header: string | null, secret: string): Promise<boolean> {
  if (!header?.startsWith('sha256=') || !secret) return false;
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const mac = new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(raw)));
  const hex = Array.from(mac, (b) => b.toString(16).padStart(2, '0')).join('');
  const got = header.slice(7);
  if (got.length !== hex.length) return false;
  let diff = 0;
  for (let i = 0; i < hex.length; i++) diff |= hex.charCodeAt(i) ^ got.charCodeAt(i);
  return diff === 0;
}

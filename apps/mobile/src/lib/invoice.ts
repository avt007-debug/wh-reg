/**
 * Tax invoice: printable page (→ "Save as PDF" in the print window), WhatsApp text, and the JSON files
 * the government portals accept — e-way bill (bulk upload) and e-invoice (IRP, schema 1.1).
 * Check the JSON in the portal before submitting: pincodes and distance come from what is saved here.
 */
import { formatINR } from '@wh/shared';
import { dmy } from './dates';

export interface InvLine {
  id: string; line_no: number; product_id: string; sku_code: string; name: string; hsn_code: string | null; uom: string; qty: number;
  mrp: number | null; unit_base_price: number; discount_pct: number; discount_amount: number; line_discount: number;
  line_taxable: number; gst_rate: number; line_tax: number; line_total: number;
}
export interface InvBill {
  id: string; invoice_no: string; invoice_date: string; warehouse_id: string; warehouse_name: string; customer_id: string; customer_name: string;
  customer_gstin: string | null; customer_phone: string | null; is_interstate: boolean; place_of_supply: string | null;
  taxable_total: number; discount_total: number; cgst_total: number; sgst_total: number; igst_total: number; grand_total: number;
  loading_charges: number; transport_charges: number; other_charges: number; status: string; cancelled_reason: string | null;
  entered_by: string; entered_at: string; lines: InvLine[];
}
export interface Business { name?: string; address?: string; phone?: string; email?: string; bank_name?: string; bank_account?: string; bank_ifsc?: string; upi_id?: string; terms?: string }
export interface InvoiceData {
  bill: InvBill; business: Business;
  seller: { code: string; name: string; address: string | null; state_code: string; gstin: string | null };
  buyer: { name: string; gstin: string | null; phone: string | null; address: string | null; state_code: string | null } | null;
  balance: number | null;
  transport: { mode: string; transporter: string | null; vehicle: string | null; lr: string | null; eway: string | null; place_of_supply: string | null };
  returns: { return_no: string; return_date: string; total: number }[];
}

const n = (x: unknown) => Number(x ?? 0);
const r2 = (x: number) => Math.round(x * 100) / 100;
const esc = (s: unknown) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

export const STATES: Record<string, string> = {
  '01': 'Jammu & Kashmir', '02': 'Himachal Pradesh', '03': 'Punjab', '04': 'Chandigarh', '05': 'Uttarakhand', '06': 'Haryana', '07': 'Delhi',
  '08': 'Rajasthan', '09': 'Uttar Pradesh', '10': 'Bihar', '11': 'Sikkim', '12': 'Arunachal Pradesh', '13': 'Nagaland', '14': 'Manipur',
  '15': 'Mizoram', '16': 'Tripura', '17': 'Meghalaya', '18': 'Assam', '19': 'West Bengal', '20': 'Jharkhand', '21': 'Odisha', '22': 'Chhattisgarh',
  '23': 'Madhya Pradesh', '24': 'Gujarat', '26': 'Dadra & Nagar Haveli and Daman & Diu', '27': 'Maharashtra', '29': 'Karnataka', '30': 'Goa',
  '31': 'Lakshadweep', '32': 'Kerala', '33': 'Tamil Nadu', '34': 'Puducherry', '35': 'Andaman & Nicobar', '36': 'Telangana', '37': 'Andhra Pradesh',
  '38': 'Ladakh', '97': 'Other Territory',
};

/** 123456.5 → "Rupees One Lakh Twenty Three Thousand Four Hundred Fifty Six and Fifty Paise Only" */
export function rupeesInWords(amount: number): string {
  const ones = ['', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine', 'Ten', 'Eleven', 'Twelve', 'Thirteen', 'Fourteen',
    'Fifteen', 'Sixteen', 'Seventeen', 'Eighteen', 'Nineteen'];
  const tens = ['', '', 'Twenty', 'Thirty', 'Forty', 'Fifty', 'Sixty', 'Seventy', 'Eighty', 'Ninety'];
  const two = (x: number) => (x < 20 ? ones[x]! : `${tens[Math.floor(x / 10)]}${x % 10 ? ` ${ones[x % 10]}` : ''}`);
  const three = (x: number) => [x >= 100 ? `${ones[Math.floor(x / 100)]} Hundred` : '', x % 100 ? two(x % 100) : ''].filter(Boolean).join(' ');
  const words = (x: number): string => {
    if (x === 0) return 'Zero';
    const parts: string[] = [];
    const crore = Math.floor(x / 1e7); x %= 1e7;
    const lakh = Math.floor(x / 1e5); x %= 1e5;
    const thousand = Math.floor(x / 1e3); x %= 1e3;
    if (crore) parts.push(`${words(crore)} Crore`);
    if (lakh) parts.push(`${two(lakh)} Lakh`);
    if (thousand) parts.push(`${two(thousand)} Thousand`);
    if (x) parts.push(three(x));
    return parts.join(' ');
  };
  const abs = Math.abs(r2(amount));
  const rupees = Math.floor(abs);
  const paise = Math.round((abs - rupees) * 100);
  return `Rupees ${words(rupees)}${paise ? ` and ${two(paise)} Paise` : ''} Only`;
}

export function invoiceHtml(d: InvoiceData): string {
  const b = d.bill; const biz = d.business ?? {};
  const inter = b.is_interstate;
  const charges = n(b.loading_charges) + n(b.transport_charges) + n(b.other_charges);
  const rates = new Map<number, { taxable: number; tax: number }>();
  b.lines.forEach((l) => { const x = rates.get(n(l.gst_rate)) ?? { taxable: 0, tax: 0 }; x.taxable += n(l.line_taxable); x.tax += n(l.line_tax); rates.set(n(l.gst_rate), x); });
  const pos = b.place_of_supply ?? d.transport.place_of_supply;
  const rows = b.lines.map((l) => `<tr>
      <td>${l.line_no}</td><td><b>${esc(l.name)}</b><br><span class="m">${esc(l.sku_code)}</span></td><td>${esc(l.hsn_code)}</td>
      <td class="r">${n(l.qty)} ${esc(l.uom)}</td><td class="r">${formatINR(n(l.unit_base_price))}</td>
      <td class="r">${n(l.line_discount) ? formatINR(n(l.line_discount)) : ''}${n(l.discount_pct) ? `<br><span class="m">${n(l.discount_pct)}%</span>` : ''}</td>
      <td class="r">${formatINR(n(l.line_taxable))}</td><td class="r">${n(l.gst_rate)}%</td><td class="r">${formatINR(n(l.line_tax))}</td>
      <td class="r"><b>${formatINR(n(l.line_total))}</b></td></tr>`).join('');
  const taxRows = [...rates.entries()].sort((a, c) => a[0] - c[0]).map(([rt, x]) => inter
    ? `<tr><td>${rt}%</td><td class="r">${formatINR(r2(x.taxable))}</td><td class="r">${formatINR(r2(x.tax))}</td></tr>`
    : `<tr><td>${rt}%</td><td class="r">${formatINR(r2(x.taxable))}</td><td class="r">${formatINR(r2(x.tax / 2))}</td><td class="r">${formatINR(r2(x.tax - r2(x.tax / 2)))}</td></tr>`).join('');
  const bank = [biz.bank_name && `Bank: ${esc(biz.bank_name)}`, biz.bank_account && `A/c: ${esc(biz.bank_account)}`, biz.bank_ifsc && `IFSC: ${esc(biz.bank_ifsc)}`,
    biz.upi_id && `UPI: ${esc(biz.upi_id)}`].filter(Boolean).join(' · ');
  return `<!doctype html><html><head><meta charset="utf-8"><title>Invoice ${esc(b.invoice_no)}</title>
<style>
  *{box-sizing:border-box} body{font:12px/1.4 -apple-system,Segoe UI,Roboto,Arial,sans-serif;color:#111;margin:0;padding:18px}
  .top{display:flex;justify-content:space-between;gap:16px;border-bottom:3px solid #D40000;padding-bottom:10px}
  h1{margin:0;font-size:20px;color:#D40000} .t{font-size:16px;font-weight:800;text-align:right} .m{color:#666;font-size:11px}
  .grid{display:grid;grid-template-columns:1fr 1fr;gap:12px;margin:12px 0} .box{border:1px solid #ccc;border-radius:6px;padding:8px}
  table{width:100%;border-collapse:collapse;margin-top:8px} th,td{border:1px solid #ccc;padding:5px;vertical-align:top} th{background:#FFF4CC;text-align:left}
  .r{text-align:right;white-space:nowrap} .tot td{font-weight:700} .big{font-size:15px}
  .foot{display:flex;justify-content:space-between;gap:16px;margin-top:14px} .sign{text-align:right;min-width:200px;padding-top:40px}
  .cancel{color:#D40000;font-weight:800;font-size:16px;border:2px solid #D40000;padding:6px;text-align:center;margin:8px 0}
  @media print{body{padding:0} @page{size:A4;margin:12mm}}
</style></head><body>
<div class="top"><div><h1>${esc(biz.name || d.seller.name)}</h1>
  <div>${esc(d.seller.address || biz.address || '')}</div>
  <div>${d.seller.gstin ? `GSTIN: <b>${esc(d.seller.gstin)}</b> · ` : ''}State: ${esc(STATES[d.seller.state_code] ?? d.seller.state_code)} (${esc(d.seller.state_code)})</div>
  <div class="m">${[biz.phone && `Ph: ${esc(biz.phone)}`, biz.email && esc(biz.email)].filter(Boolean).join(' · ')}</div></div>
  <div class="t">TAX INVOICE<div class="m">Original for recipient</div>
  <div style="font-size:13px;margin-top:6px">No. <b>${esc(b.invoice_no)}</b><br>Date: <b>${dmy(b.invoice_date)}</b></div></div></div>
${b.status !== 'POSTED' ? `<div class="cancel">CANCELLED${b.cancelled_reason ? ` — ${esc(b.cancelled_reason)}` : ''}</div>` : ''}
<div class="grid"><div class="box"><div class="m">Bill to</div><b class="big">${esc(b.customer_name)}</b>
  ${d.buyer?.address ? `<div>${esc(d.buyer.address)}</div>` : ''}
  <div>${b.customer_gstin ? `GSTIN: <b>${esc(b.customer_gstin)}</b>` : 'Unregistered'}${d.buyer?.phone ? ` · Ph: ${esc(d.buyer.phone)}` : ''}</div>
  <div>Place of supply: ${esc(STATES[pos ?? ''] ?? pos ?? '')} (${esc(pos)})</div></div>
  <div class="box"><div class="m">Dispatch</div>From: ${esc(d.seller.name)} (${esc(d.seller.code)})
  ${d.transport.vehicle ? `<br>Vehicle: ${esc(d.transport.vehicle)}` : ''}${d.transport.transporter ? `<br>Transporter: ${esc(d.transport.transporter)}` : ''}
  ${d.transport.lr ? `<br>LR no: ${esc(d.transport.lr)}` : ''}${d.transport.eway ? `<br>E-way bill: ${esc(d.transport.eway)}` : ''}</div></div>
<table><thead><tr><th>#</th><th>Item</th><th>HSN</th><th class="r">Qty</th><th class="r">Rate</th><th class="r">Disc.</th><th class="r">Taxable</th><th class="r">GST</th><th class="r">GST ₹</th><th class="r">Amount</th></tr></thead>
<tbody>${rows}
<tr class="tot"><td colspan="6">Total</td><td class="r">${formatINR(n(b.taxable_total))}</td><td></td><td class="r">${formatINR(n(b.cgst_total) + n(b.sgst_total) + n(b.igst_total))}</td><td class="r">${formatINR(r2(n(b.grand_total) - charges))}</td></tr>
</tbody></table>
<div class="foot"><div style="flex:1">
  <table><thead><tr><th>GST rate</th><th class="r">Taxable</th>${inter ? '<th class="r">IGST</th>' : '<th class="r">CGST</th><th class="r">SGST</th>'}</tr></thead><tbody>${taxRows}</tbody></table>
  <p><b>${rupeesInWords(n(b.grand_total))}</b></p>
  ${bank ? `<p>${bank}</p>` : ''}
  ${biz.terms ? `<p class="m">${esc(biz.terms)}</p>` : ''}
</div><div style="min-width:240px"><table>
  <tr><td>Taxable value</td><td class="r">${formatINR(n(b.taxable_total))}</td></tr>
  ${inter ? `<tr><td>IGST</td><td class="r">${formatINR(n(b.igst_total))}</td></tr>` : `<tr><td>CGST</td><td class="r">${formatINR(n(b.cgst_total))}</td></tr><tr><td>SGST</td><td class="r">${formatINR(n(b.sgst_total))}</td></tr>`}
  ${n(b.loading_charges) ? `<tr><td>Loading</td><td class="r">${formatINR(n(b.loading_charges))}</td></tr>` : ''}
  ${n(b.transport_charges) ? `<tr><td>Transport</td><td class="r">${formatINR(n(b.transport_charges))}</td></tr>` : ''}
  ${n(b.other_charges) ? `<tr><td>Other charges</td><td class="r">${formatINR(n(b.other_charges))}</td></tr>` : ''}
  <tr class="tot big"><td>Invoice total</td><td class="r">${formatINR(n(b.grand_total))}</td></tr>
  ${d.returns.length ? d.returns.map((r) => `<tr><td>Credit note ${esc(r.return_no)}</td><td class="r">−${formatINR(n(r.total))}</td></tr>`).join('') : ''}
  </table><div class="sign">For ${esc(biz.name || d.seller.name)}<br><br><br>Authorised signatory</div></div></div>
<p class="m">Prepared by ${esc(b.entered_by)} · Computer-generated invoice</p>
</body></html>`;
}

export function invoiceWhatsAppText(d: InvoiceData): string {
  const b = d.bill; const biz = d.business ?? {};
  const lines = b.lines.slice(0, 15).map((l) => `• ${l.name} — ${n(l.qty)} ${l.uom} = ${formatINR(n(l.line_total))}`);
  if (b.lines.length > 15) lines.push(`• …and ${b.lines.length - 15} more item(s)`);
  return [
    `*${biz.name || d.seller.name}*`,
    `Invoice *${b.invoice_no}* dated ${dmy(b.invoice_date)}`,
    `To: ${b.customer_name}${b.customer_gstin ? ` (GSTIN ${b.customer_gstin})` : ''}`,
    '', ...lines, '',
    `Taxable ${formatINR(n(b.taxable_total))} + GST ${formatINR(n(b.cgst_total) + n(b.sgst_total) + n(b.igst_total))}`
      + (n(b.loading_charges) + n(b.transport_charges) + n(b.other_charges) ? ` + charges ${formatINR(n(b.loading_charges) + n(b.transport_charges) + n(b.other_charges))}` : ''),
    `*Total: ${formatINR(n(b.grand_total))}*`,
    d.balance != null && n(d.balance) > 0 ? `Your total balance with us: ${formatINR(n(d.balance))}` : '',
    biz.upi_id ? `Pay by UPI: ${biz.upi_id}` : '',
    biz.bank_account ? `Bank: ${biz.bank_name ?? ''} A/c ${biz.bank_account} IFSC ${biz.bank_ifsc ?? ''}` : '',
    'Thank you for your business!',
  ].filter((x) => x !== '').join('\n');
}

const pin = (addr: string | null | undefined) => Number(addr?.match(/\b([1-9][0-9]{5})\b/)?.[1] ?? 0);
const place = (addr: string | null | undefined) => (addr ?? '').split(/[,\n]/).map((s) => s.trim()).filter(Boolean).slice(-2)[0] ?? '';
const ddmmyyyy = (iso: string, sep = '/') => `${iso.slice(8, 10)}${sep}${iso.slice(5, 7)}${sep}${iso.slice(0, 4)}`;

/** Problems to fix before the portal will accept the file. */
export function portalProblems(d: InvoiceData, kind: 'eway' | 'einvoice'): string[] {
  const p: string[] = [];
  if (!d.seller.gstin) p.push(`Add the GSTIN of the ${d.seller.name} warehouse (Settings → Warehouses).`);
  if (!pin(d.seller.address)) p.push(`Add a 6-digit pincode to the ${d.seller.name} warehouse address.`);
  if (!pin(d.buyer?.address)) p.push('Add the customer address with a 6-digit pincode (Customers page).');
  if (kind === 'einvoice' && !d.bill.customer_gstin) p.push('E-invoice is only for customers with a GSTIN (B2B).');
  if (d.bill.lines.some((l) => !l.hsn_code)) p.push('Every item needs an HSN code.');
  return p;
}

/** E-way bill bulk-upload JSON (one bill). Distance in km is required by the portal. */
export function ewayJson(d: InvoiceData, distanceKm: number) {
  const b = d.bill; const inter = b.is_interstate;
  return {
    version: '1.0.0621',
    billLists: [{
      userGstin: d.seller.gstin, supplyType: 'O', subSupplyType: 1, subSupplyDesc: '', docType: 'INV',
      docNo: b.invoice_no, docDate: ddmmyyyy(b.invoice_date), transType: 1,
      fromGstin: d.seller.gstin, fromTrdName: d.business?.name || d.seller.name, fromAddr1: (d.seller.address ?? '').slice(0, 120), fromAddr2: '',
      fromPlace: place(d.seller.address), fromPincode: pin(d.seller.address), fromStateCode: Number(d.seller.state_code), actualFromStateCode: Number(d.seller.state_code),
      toGstin: b.customer_gstin ?? 'URP', toTrdName: b.customer_name, toAddr1: (d.buyer?.address ?? '').slice(0, 120), toAddr2: '',
      toPlace: place(d.buyer?.address), toPincode: pin(d.buyer?.address),
      toStateCode: Number(b.place_of_supply ?? d.buyer?.state_code ?? d.seller.state_code), actualToStateCode: Number(b.place_of_supply ?? d.buyer?.state_code ?? d.seller.state_code),
      totalValue: n(b.taxable_total), cgstValue: n(b.cgst_total), sgstValue: n(b.sgst_total), igstValue: n(b.igst_total), cessValue: 0, cessNonAdvolValue: 0,
      otherValue: r2(n(b.loading_charges) + n(b.transport_charges) + n(b.other_charges)), totInvValue: n(b.grand_total),
      transMode: 1, transDistance: String(Math.round(distanceKm)), transporterName: d.transport.transporter ?? '', transporterId: '',
      transDocNo: d.transport.lr ?? '', transDocDate: d.transport.lr ? ddmmyyyy(b.invoice_date) : '',
      vehicleNo: d.transport.vehicle ?? '', vehicleType: 'R',
      itemList: b.lines.map((l) => ({
        itemNo: l.line_no, productName: l.name.slice(0, 100), productDesc: l.name.slice(0, 100), hsnCode: Number(l.hsn_code ?? 0),
        quantity: n(l.qty), qtyUnit: 'NOS', taxableAmount: n(l.line_taxable),
        sgstRate: inter ? 0 : n(l.gst_rate) / 2, cgstRate: inter ? 0 : n(l.gst_rate) / 2, igstRate: inter ? n(l.gst_rate) : 0, cessRate: 0, cessNonAdvol: 0,
      })),
    }],
  };
}

/** E-invoice (IRN) JSON, schema 1.1 — for B2B invoices when your turnover makes e-invoicing compulsory. */
export function einvoiceJson(d: InvoiceData) {
  const b = d.bill; const inter = b.is_interstate;
  const pos = b.place_of_supply ?? d.buyer?.state_code ?? d.seller.state_code;
  return [{
    Version: '1.1',
    TranDtls: { TaxSch: 'GST', SupTyp: 'B2B', RegRev: 'N', IgstOnIntra: 'N' },
    DocDtls: { Typ: 'INV', No: b.invoice_no, Dt: ddmmyyyy(b.invoice_date) },
    SellerDtls: { Gstin: d.seller.gstin, LglNm: d.business?.name || d.seller.name, Addr1: (d.seller.address ?? '').slice(0, 100) || d.seller.name,
      Loc: place(d.seller.address) || d.seller.name, Pin: pin(d.seller.address), Stcd: d.seller.state_code },
    BuyerDtls: { Gstin: b.customer_gstin, LglNm: b.customer_name, Pos: pos, Addr1: (d.buyer?.address ?? '').slice(0, 100) || b.customer_name,
      Loc: place(d.buyer?.address) || '-', Pin: pin(d.buyer?.address), Stcd: (b.customer_gstin ?? '').slice(0, 2) || pos,
      ...(d.buyer?.phone ? { Ph: d.buyer.phone } : {}) },
    ItemList: b.lines.map((l) => {
      const gross = r2(n(l.qty) * n(l.unit_base_price));
      return {
        SlNo: String(l.line_no), PrdDesc: l.name.slice(0, 300), IsServc: 'N', HsnCd: l.hsn_code ?? '', Qty: n(l.qty), Unit: 'NOS',
        UnitPrice: n(l.unit_base_price), TotAmt: gross, Discount: n(l.line_discount), AssAmt: n(l.line_taxable), GstRt: n(l.gst_rate),
        IgstAmt: inter ? n(l.line_tax) : 0, CgstAmt: inter ? 0 : r2(n(l.line_tax) / 2), SgstAmt: inter ? 0 : r2(n(l.line_tax) - r2(n(l.line_tax) / 2)),
        CesRt: 0, CesAmt: 0, CesNonAdvlAmt: 0, StateCesRt: 0, StateCesAmt: 0, StateCesNonAdvlAmt: 0, OthChrg: 0, TotItemVal: n(l.line_total),
      };
    }),
    ValDtls: { AssVal: n(b.taxable_total), CgstVal: n(b.cgst_total), SgstVal: n(b.sgst_total), IgstVal: n(b.igst_total), CesVal: 0, StCesVal: 0,
      Discount: 0, OthChrg: r2(n(b.loading_charges) + n(b.transport_charges) + n(b.other_charges)), RndOffAmt: 0, TotInvVal: n(b.grand_total) },
  }];
}

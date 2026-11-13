/**
 * GST reports for a month: GSTR-1 (B2B, B2C, credit notes, HSN, documents), GSTR-3B summary (output tax, ITC),
 * purchases for matching with GSTR-2B. Download as Excel or as the GSTR-1 JSON for the GST portal / offline tool.
 */
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { Text, View } from 'react-native';
import { formatINR } from '@wh/shared';
import { rpc } from '../../src/api/client';
import { Card, Chips, Label, Notice, Row, Screen, SmallButton, Stat, Toolbar } from '../../src/components/ui';
import { monthLong, monthStart } from '../../src/lib/dates';
import { notify } from '../../src/lib/dialogs';
import { saveTextFile } from '../../src/lib/download';
import { exportXlsx } from '../../src/lib/exportFile';
import { STATES } from '../../src/lib/invoice';
import { fileStamp, useWarehouses } from '../../src/lib/warehouse';
import { useTheme } from '../../src/theme';

const n = (x: unknown) => Number(x ?? 0);
const r2 = (x: number) => Math.round(x * 100) / 100;
type Rates = { rate: number; taxable: number; tax: number }[];
interface Gst {
  period: { from: string; to: string; fp: string }; gstins: { gstin: string | null; warehouse: string; state_code: string }[];
  b2b: { gstin: string; customer: string; invoice_no: string; invoice_date: string; value: number; pos: string; inter: boolean; rates: Rates }[];
  b2cl: { invoice_no: string; invoice_date: string; value: number; pos: string; rates: Rates }[];
  b2cs: { pos: string; inter: boolean; rate: number; taxable: number; tax: number }[];
  cdnr: { gstin: string; customer: string; note_no: string; note_date: string; invoice_no: string; invoice_date: string; value: number; pos: string; inter: boolean; rates: Rates }[];
  nil: { intra_b2b: number; intra_b2c: number; inter_b2b: number; inter_b2c: number };
  hsn: { b2b: boolean; hsn: string; description: string; rate: number; qty: number; value: number; taxable: number; igst: number; cgst: number; sgst: number }[];
  docs: { invoices: { warehouse: string; from: string; to: string; total: number; cancelled: number }[]; credit_notes: { from: string | null; to: string | null; total: number; cancelled: number } };
  gstr3b: { outward: { taxable: number; igst: number; cgst: number; sgst: number }; nil_exempt: number;
    inter_unregistered: { pos: string; taxable: number; igst: number }[]; itc: { igst: number; cgst: number; sgst: number; bills: number } };
  purchases: { gstin: string; vendor: string; invoice_no: string; invoice_date: string; taxable: number; igst: number; cgst: number; sgst: number; total: number }[];
}
const ddmmyyyy = (iso: string) => `${iso.slice(8, 10)}-${iso.slice(5, 7)}-${iso.slice(0, 4)}`;
const split = (tax: number, inter: boolean) => (inter ? { iamt: r2(tax), camt: 0, samt: 0 } : { iamt: 0, camt: r2(tax / 2), samt: r2(tax - r2(tax / 2)) });

export default function GstPage() {
  const t = useTheme();
  const whs = useWarehouses();
  const [back, setBack] = useState(1);
  const [wh, setWh] = useState<string>('');
  const month = monthStart(back);
  const q = useQuery({ queryKey: ['gst', month, wh], queryFn: () => rpc<Gst>('owner_gst_report', { p_month: month, p_warehouse: wh || null }) });
  const d = q.data;
  const gstin = d?.gstins.find((g) => g.gstin)?.gstin ?? null;
  const multi = new Set(d?.gstins.map((g) => g.gstin)).size > 1;
  const out = d?.gstr3b.outward;
  const outTax = out ? n(out.igst) + n(out.cgst) + n(out.sgst) : 0;
  const itc = d ? n(d.gstr3b.itc.igst) + n(d.gstr3b.itc.cgst) + n(d.gstr3b.itc.sgst) : 0;

  const gstr1Json = () => {
    if (!d) return;
    if (!gstin) { notify('Add your GSTIN first', 'Settings → Warehouses → Edit → GSTIN.'); return; }
    if (multi) { notify('Pick one warehouse', 'Your warehouses have different GSTINs — file each separately. Pick a warehouse above.'); return; }
    const byCtin = new Map<string, Gst['b2b']>();
    d.b2b.forEach((i) => byCtin.set(i.gstin, [...(byCtin.get(i.gstin) ?? []), i]));
    const json = {
      gstin, fp: d.period.fp, version: 'GST3.2.1', hash: 'hash',
      b2b: [...byCtin.entries()].map(([ctin, invs]) => ({ ctin, inv: invs.map((i) => ({
        inum: i.invoice_no, idt: ddmmyyyy(i.invoice_date), val: n(i.value), pos: i.pos, rchrg: 'N', inv_typ: 'R',
        itms: i.rates.map((r, k) => ({ num: k + 1, itm_det: { txval: r2(n(r.taxable)), rt: n(r.rate), ...split(n(r.tax), i.inter), csamt: 0 } })) })) })),
      b2cl: Object.values(d.b2cl.reduce<Record<string, { pos: string; inv: object[] }>>((a, i) => {
        (a[i.pos] ??= { pos: i.pos, inv: [] }).inv.push({ inum: i.invoice_no, idt: ddmmyyyy(i.invoice_date), val: n(i.value),
          itms: i.rates.map((r, k) => ({ num: k + 1, itm_det: { txval: r2(n(r.taxable)), rt: n(r.rate), iamt: r2(n(r.tax)), csamt: 0 } })) });
        return a; }, {})),
      b2cs: d.b2cs.map((x) => ({ sply_ty: x.inter ? 'INTER' : 'INTRA', pos: x.pos, typ: 'OE', txval: r2(n(x.taxable)), rt: n(x.rate), ...split(n(x.tax), x.inter), csamt: 0 })),
      cdnr: Object.values(d.cdnr.reduce<Record<string, { ctin: string; nt: object[] }>>((a, c) => {
        (a[c.gstin] ??= { ctin: c.gstin, nt: [] }).nt.push({ ntty: 'C', nt_num: c.note_no, nt_dt: ddmmyyyy(c.note_date), val: n(c.value), pos: c.pos, rchrg: 'N', inv_typ: 'R',
          itms: c.rates.map((r, k) => ({ num: k + 1, itm_det: { txval: r2(n(r.taxable)), rt: n(r.rate), ...split(n(r.tax), c.inter), csamt: 0 } })) });
        return a; }, {})),
      nil: { inv: [
        { sply_ty: 'INTRB2B', nil_amt: r2(n(d.nil.inter_b2b)), expt_amt: 0, ngsup_amt: 0 }, { sply_ty: 'INTRAB2B', nil_amt: r2(n(d.nil.intra_b2b)), expt_amt: 0, ngsup_amt: 0 },
        { sply_ty: 'INTRB2C', nil_amt: r2(n(d.nil.inter_b2c)), expt_amt: 0, ngsup_amt: 0 }, { sply_ty: 'INTRAB2C', nil_amt: r2(n(d.nil.intra_b2c)), expt_amt: 0, ngsup_amt: 0 }] },
      hsn: {
        hsn_b2b: d.hsn.filter((h) => h.b2b).map((h, k) => ({ num: k + 1, hsn_sc: h.hsn, desc: h.description.slice(0, 30), uqc: 'NOS', qty: n(h.qty), rt: n(h.rate),
          txval: r2(n(h.taxable)), iamt: r2(n(h.igst)), camt: r2(n(h.cgst)), samt: r2(n(h.sgst)), csamt: 0 })),
        hsn_b2c: d.hsn.filter((h) => !h.b2b).map((h, k) => ({ num: k + 1, hsn_sc: h.hsn, desc: h.description.slice(0, 30), uqc: 'NOS', qty: n(h.qty), rt: n(h.rate),
          txval: r2(n(h.taxable)), iamt: r2(n(h.igst)), camt: r2(n(h.cgst)), samt: r2(n(h.sgst)), csamt: 0 })),
      },
      doc_issue: { doc_det: [
        { doc_num: 1, docs: d.docs.invoices.map((x, k) => ({ num: k + 1, from: x.from, to: x.to, totnum: x.total, cancel: x.cancelled, net_issue: x.total - x.cancelled })) },
        ...(d.docs.credit_notes.total ? [{ doc_num: 5, docs: [{ num: 1, from: d.docs.credit_notes.from, to: d.docs.credit_notes.to, totnum: d.docs.credit_notes.total,
          cancel: d.docs.credit_notes.cancelled, net_issue: d.docs.credit_notes.total - d.docs.credit_notes.cancelled }] }] : [])] },
    };
    void saveTextFile(`GSTR1_${gstin}_${d.period.fp}.json`, JSON.stringify(json, null, 1)).then(() =>
      notify('GSTR-1 file saved', 'Upload it on gst.gov.in → Returns → GSTR-1 → Prepare offline → Upload. Check every table before you submit.'));
  };

  const excel = () => d && exportXlsx(`GST_${d.period.fp}_${fileStamp()}`, [
    { name: 'B2B', columns: [{ header: 'GSTIN', width: 17 }, { header: 'Customer', width: 26 }, { header: 'Invoice no', width: 15 }, { header: 'Date', kind: 'date', width: 11 },
        { header: 'Invoice value', kind: 'money', width: 13 }, { header: 'Place of supply', width: 16 }, { header: 'Rate %', kind: 'number', width: 7 },
        { header: 'Taxable', kind: 'money', width: 13 }, { header: 'IGST', kind: 'money', width: 11 }, { header: 'CGST', kind: 'money', width: 11 }, { header: 'SGST', kind: 'money', width: 11 }],
      rows: d.b2b.flatMap((i) => i.rates.map((r) => { const s = split(n(r.tax), i.inter); return [i.gstin, i.customer, i.invoice_no, i.invoice_date, n(i.value),
        `${i.pos}-${STATES[i.pos] ?? ''}`, n(r.rate), n(r.taxable), s.iamt, s.camt, s.samt]; })) },
    { name: 'B2C large', columns: [{ header: 'Invoice no', width: 15 }, { header: 'Date', kind: 'date', width: 11 }, { header: 'Value', kind: 'money', width: 13 },
        { header: 'Place of supply', width: 16 }, { header: 'Rate %', kind: 'number', width: 7 }, { header: 'Taxable', kind: 'money', width: 13 }, { header: 'IGST', kind: 'money', width: 11 }],
      rows: d.b2cl.flatMap((i) => i.rates.map((r) => [i.invoice_no, i.invoice_date, n(i.value), `${i.pos}-${STATES[i.pos] ?? ''}`, n(r.rate), n(r.taxable), n(r.tax)])) },
    { name: 'B2C small', columns: [{ header: 'Place of supply', width: 18 }, { header: 'Type', width: 8 }, { header: 'Rate %', kind: 'number', width: 7 },
        { header: 'Taxable', kind: 'money', width: 13 }, { header: 'IGST', kind: 'money', width: 11 }, { header: 'CGST', kind: 'money', width: 11 }, { header: 'SGST', kind: 'money', width: 11 }],
      rows: d.b2cs.map((x) => { const s = split(n(x.tax), x.inter); return [`${x.pos}-${STATES[x.pos] ?? ''}`, x.inter ? 'Inter' : 'Intra', n(x.rate), n(x.taxable), s.iamt, s.camt, s.samt]; }) },
    { name: 'Credit notes', columns: [{ header: 'GSTIN', width: 17 }, { header: 'Customer', width: 24 }, { header: 'Note no', width: 20 }, { header: 'Note date', kind: 'date', width: 11 },
        { header: 'Against invoice', width: 15 }, { header: 'Rate %', kind: 'number', width: 7 }, { header: 'Taxable', kind: 'money', width: 12 }, { header: 'Tax', kind: 'money', width: 11 }],
      rows: d.cdnr.flatMap((c) => c.rates.map((r) => [c.gstin, c.customer, c.note_no, c.note_date, c.invoice_no, n(r.rate), n(r.taxable), n(r.tax)])) },
    { name: 'HSN', columns: [{ header: 'B2B / B2C', width: 9 }, { header: 'HSN', width: 10 }, { header: 'Description', width: 28 }, { header: 'UQC', width: 6 },
        { header: 'Qty', kind: 'number', width: 9 }, { header: 'Rate %', kind: 'number', width: 7 }, { header: 'Taxable', kind: 'money', width: 13 },
        { header: 'IGST', kind: 'money', width: 11 }, { header: 'CGST', kind: 'money', width: 11 }, { header: 'SGST', kind: 'money', width: 11 }, { header: 'Total', kind: 'money', width: 13 }],
      rows: d.hsn.map((h) => [h.b2b ? 'B2B' : 'B2C', h.hsn, h.description, 'NOS', n(h.qty), n(h.rate), n(h.taxable), n(h.igst), n(h.cgst), n(h.sgst), n(h.value)]) },
    { name: 'Documents', columns: [{ header: 'Document', width: 14 }, { header: 'Series', width: 8 }, { header: 'From', width: 18 }, { header: 'To', width: 18 },
        { header: 'Total', kind: 'number', width: 8 }, { header: 'Cancelled', kind: 'number', width: 10 }],
      rows: [...d.docs.invoices.map((x) => ['Invoices', x.warehouse, x.from, x.to, x.total, x.cancelled]),
        ...(d.docs.credit_notes.total ? [['Credit notes', '', d.docs.credit_notes.from, d.docs.credit_notes.to, d.docs.credit_notes.total, d.docs.credit_notes.cancelled]] : [])] },
    { name: 'GSTR-3B', columns: [{ header: 'Section', width: 46 }, { header: 'Taxable', kind: 'money', width: 14 }, { header: 'IGST', kind: 'money', width: 12 },
        { header: 'CGST', kind: 'money', width: 12 }, { header: 'SGST', kind: 'money', width: 12 }],
      rows: [['3.1(a) Outward taxable supplies', n(out?.taxable), n(out?.igst), n(out?.cgst), n(out?.sgst)],
        ['3.1(c) Nil rated / exempt', n(d.gstr3b.nil_exempt), 0, 0, 0],
        ...d.gstr3b.inter_unregistered.map((x) => [`3.2 Inter-state to unregistered · ${x.pos}-${STATES[x.pos] ?? ''}`, n(x.taxable), n(x.igst), 0, 0]),
        ['4(A)(5) ITC from purchases (net of returns)', null, n(d.gstr3b.itc.igst), n(d.gstr3b.itc.cgst), n(d.gstr3b.itc.sgst)]] },
    { name: 'Purchases (2B check)', columns: [{ header: 'Supplier GSTIN', width: 17 }, { header: 'Supplier', width: 26 }, { header: 'Invoice no', width: 15 },
        { header: 'Date', kind: 'date', width: 11 }, { header: 'Taxable', kind: 'money', width: 13 }, { header: 'IGST', kind: 'money', width: 11 },
        { header: 'CGST', kind: 'money', width: 11 }, { header: 'SGST', kind: 'money', width: 11 }, { header: 'Total', kind: 'money', width: 13 }],
      rows: d.purchases.map((p) => [p.gstin, p.vendor, p.invoice_no, p.invoice_date, n(p.taxable), n(p.igst), n(p.cgst), n(p.sgst), n(p.total)]) },
  ]);

  return (
    <Screen>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
        <SmallButton title="‹ Prev" onPress={() => setBack((b) => b + 1)} />
        <Text style={{ flex: 1, textAlign: 'center', color: t.text, fontSize: 18, fontWeight: '700' }}>{monthLong(month)}</Text>
        <SmallButton title="Next ›" onPress={() => setBack((b) => Math.max(0, b - 1))} disabled={back === 0} />
      </View>
      <Chips options={['', ...(whs.data ?? []).map((w) => w.id)]} value={wh} onChange={setWh}
        format={(v) => (v ? `${whs.data?.find((w) => w.id === v)?.name} · ${whs.data?.find((w) => w.id === v)?.gstin ?? 'no GSTIN'}` : 'All warehouses')} />
      {d && !gstin ? <Notice tone="warning">Add your GSTIN to each warehouse (Settings → Warehouses) so the reports and files carry it.</Notice> : null}
      {d ? (
        <>
          <View style={{ flexDirection: 'row', gap: 10, flexWrap: 'wrap' }}>
            <Stat label="Output GST" value={formatINR(outTax)} sub={`on ${formatINR(n(out?.taxable))} taxable`} icon="arrow-up-circle" />
            <Stat label="Input tax credit" value={formatINR(itc)} sub={`${d.gstr3b.itc.bills} purchase bill(s)`} icon="arrow-down-circle" />
            <Stat label="Approx. GST to pay" value={formatINR(Math.max(0, outTax - itc))} sub="before set-off rules" tone="warning" icon="calculator" />
          </View>
          <Toolbar>
            <SmallButton title="Export all GST tables to Excel" onPress={() => void excel()} />
            <SmallButton icon="cloud-upload-outline" title="GSTR-1 file for the portal" onPress={gstr1Json} />
          </Toolbar>
          <Card title="GSTR-1" subtitle="Sales of the month">
            <Row left="B2B invoices (customers with GSTIN)" right={String(d.b2b.length)} sub={formatINR(d.b2b.reduce((a, i) => a + n(i.value), 0))} />
            <Row left="B2C large (other state, above ₹1 lakh)" right={String(d.b2cl.length)} />
            <Row left="B2C small — rows by state & rate" right={String(d.b2cs.length)} sub={formatINR(d.b2cs.reduce((a, x) => a + n(x.taxable), 0)) + ' taxable'} />
            <Row left="Credit notes to registered customers" right={String(d.cdnr.length)} />
            <Row left="HSN summary rows" right={String(d.hsn.length)} />
            <Row left="Nil-rated (0% GST) sales" right={formatINR(n(d.nil.intra_b2b) + n(d.nil.intra_b2c) + n(d.nil.inter_b2b) + n(d.nil.inter_b2c))} />
            {d.docs.invoices.map((x) => <Row key={x.warehouse} left={`Invoices ${x.warehouse}: ${x.from} → ${x.to}`} right={`${x.total}${x.cancelled ? ` (${x.cancelled} cancelled)` : ''}`} />)}
          </Card>
          <Card title="GSTR-3B summary">
            <Row left="3.1(a) Outward taxable" right={formatINR(n(out?.taxable))} sub={`IGST ${formatINR(n(out?.igst))} · CGST ${formatINR(n(out?.cgst))} · SGST ${formatINR(n(out?.sgst))}`} />
            <Row left="3.1(c) Nil rated" right={formatINR(n(d.gstr3b.nil_exempt))} />
            <Row left="4 Eligible ITC" right={formatINR(itc)} sub={`IGST ${formatINR(n(d.gstr3b.itc.igst))} · CGST ${formatINR(n(d.gstr3b.itc.cgst))} · SGST ${formatINR(n(d.gstr3b.itc.sgst))}`} />
          </Card>
          <Notice icon="shield-checkmark-outline">These numbers come straight from your bills. Match the purchase list with GSTR-2B on the portal before claiming ITC, and have your accountant check before filing.</Notice>
        </>
      ) : <Label muted>Loading…</Label>}
    </Screen>
  );
}

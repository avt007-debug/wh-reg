/**
 * Owner purchases, month by month:
 *   • every invoice of the month (sorted by invoice date / number) with the
 *     items bought on it
 *   • edit a saved purchase (invoice no/date, LR no, freight, items, qty, rate)
 *     — stock is re-posted automatically, the old version stays in the audit log
 *   • extra discount the owner received, per item and/or per bill — owner only;
 *     staff have no screen, table or API that shows these numbers
 *   • export the month to Excel
 *   • purchases entered by staff wait here for approval; stock is added only
 *     when the owner approves
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { Modal, Pressable, ScrollView, Text, View } from 'react-native';
import { formatINR, fromBase, splitByGst, type UnitPrice } from '@wh/shared';
import { q, rpc } from '../../src/api/client';
import type { ProductHit } from '../../src/api/types';
import { BillForm } from '../../src/components/BillForm';
import { CreditNotes } from '../../src/components/CreditNotes';
import { GstSplitRows, GstTag } from '../../src/components/GstSplit';
import { ItemPicker } from '../../src/components/ItemPicker';
import { PriceGstField } from '../../src/components/PriceGstField';
import { Button, Card, Chips, Field, Label, Row, Screen, SmallButton, Toolbar } from '../../src/components/ui';
import { useSelectedWarehouseName, WarehouseSwitch } from '../../src/components/WarehouseSwitch';
import { dateTimeIST, dmy, monthLong, monthStart } from '../../src/lib/dates';
import { askText, notify } from '../../src/lib/dialogs';
import { exportXlsx } from '../../src/lib/exportFile';
import { supabase } from '../../src/lib/supabase';
import { fileStamp, useOwnerWarehouse } from '../../src/lib/warehouse';
import { useTheme } from '../../src/theme';

type DiscType = 'PERCENT' | 'AMOUNT';
interface Line {
  id: string; line_no: number; product_id: string; sku_code: string; name: string; uom: string; qty: number; qty_base: number;
  hsn_code: string | null; gst_rate: number; unit_base_price: number; unit_incl_price: number; line_taxable: number; line_total: number;
  discount_amount: number; discount_pct: number; mrp: number | null; credit_pct: number | null; credit_value: number;
  item_discount_type: DiscType | null; item_discount_value: number | null; item_discount_amount: number; effective_unit_cost_base: number | null;
}
interface Purchase {
  id: string; warehouse_id: string; warehouse_code: string; warehouse_name: string; vendor_name: string; vendor_gstin: string | null;
  vendor_invoice_no: string; vendor_invoice_date: string; received_on: string | null; lorry_receipt_no: string | null;
  freight_amount: number; loading_charges: number; other_charges: number; credit_total: number; taxable_total: number; tax_total: number; grand_total: number;
  bill_discount_type: DiscType | null; bill_discount_value: number | null; bill_discount_reason: string | null; bill_discount_amount: number;
  total_discount: number; net_taxable: number; net_payable: number; lines: Line[];
  status: 'PENDING' | 'POSTED' | 'CANCELLED'; entered_by: string; entered_by_role: string; entered_at: string;
  approved_by: string | null; approved_at: string | null;
}

const n = (x: unknown) => Number(x ?? 0);
const discLabel = (t: DiscType | null, v: number | null) => (!t || !v ? '' : t === 'PERCENT' ? `${n(v)}%` : formatINR(n(v)));

export default function OwnerPurchases() {
  const t = useTheme();
  const wh = useOwnerWarehouse((s) => s.id);
  const whName = useSelectedWarehouseName();
  const [back, setBack] = useState(0);              // 0 = this month, 1 = last month …
  const [search, setSearch] = useState('');
  const [edit, setEdit] = useState<Purchase | null>(null);
  const [view, setView] = useState<'Bills' | 'Credit notes'>('Bills');
  const [adding, setAdding] = useState(false);
  const month = monthStart(back);

  const qc = useQueryClient();
  const list = useQuery({
    queryKey: ['purchases-month', month, wh],
    queryFn: () => rpc<Purchase[]>('owner_purchases_month', { p_month: month, p_warehouse: wh }),
  });
  const pending = useQuery({ queryKey: ['pending-purchases'], queryFn: () => rpc<Purchase[]>('owner_pending_purchases') });
  const pendingRows = (pending.data ?? []).filter((p) => !wh || p.warehouse_id === wh);
  const refreshAll = () => {
    for (const k of ['purchases-month', 'pending-purchases', 'stock-overview', 'owner-stock', 'reorder']) void qc.invalidateQueries({ queryKey: [k] });
  };
  const approve = useMutation({
    mutationFn: (p: Purchase) => rpc<Purchase>('owner_approve_purchase', { p_id: p.id }),
    onSuccess: (p) => { refreshAll(); notify('Approved', `Invoice ${p.vendor_invoice_no}: ${p.lines.length} item(s) added to ${p.warehouse_name} stock.`); },
    onError: (e) => notify('Not approved', e instanceof Error ? e.message : String(e)),
  });
  const reject = async (p: Purchase) => {
    const reason = (await askText(`Reject invoice ${p.vendor_invoice_no}?`, `Entered by ${p.entered_by}. Nothing is added to stock. Reason:`))?.trim();
    if (!reason) return;
    rpc('owner_reject_purchase', { p_id: p.id, p_reason: reason }).then(() => { refreshAll(); notify('Rejected'); },
      (e) => notify('Not rejected', e instanceof Error ? e.message : String(e)));
  };

  const needle = search.trim().toLowerCase();
  // pending ones are shown in the approval box above, not twice
  const rows = (list.data ?? []).filter((p) => p.status !== 'PENDING').filter((p) => !needle
    || `${p.vendor_invoice_no} ${p.vendor_name} ${p.lines.map((l) => `${l.sku_code} ${l.name}`).join(' ')}`.toLowerCase().includes(needle));
  const approved = rows.filter((p) => p.status === 'POSTED');
  const billed = approved.reduce((a, p) => a + n(p.grand_total), 0);
  const disc = approved.reduce((a, p) => a + n(p.total_discount), 0);
  const net = approved.reduce((a, p) => a + n(p.net_payable), 0);

  const doExport = () => exportXlsx(`Purchases_${month.slice(0, 7)}_${whName.replace(/\s+/g, '-')}_${fileStamp()}`, [
    {
      name: 'Invoices',
      columns: [
        { header: 'Invoice date', kind: 'date', width: 13 }, { header: 'Invoice no', width: 18 }, { header: 'Vendor', width: 28 },
        { header: 'Vendor GSTIN', width: 18 }, { header: 'Warehouse', width: 14 }, { header: 'LR no', width: 14 },
        { header: 'Items', kind: 'number', width: 8 }, { header: 'Taxable', kind: 'money', width: 14 }, { header: 'GST', kind: 'money', width: 12 },
        { header: 'Extra charges', kind: 'money', width: 13 }, { header: 'Billed total', kind: 'money', width: 14 }, { header: 'Credit note ₹', kind: 'money', width: 13 },
        { header: 'Bill discount', width: 14 }, { header: 'Total extra discount', kind: 'money', width: 18 }, { header: 'Net payable', kind: 'money', width: 14 },
        { header: 'Status', width: 12 }, { header: 'Entered by', width: 22 }, { header: 'Approved by', width: 18 },
        { header: 'GST billed (incl. GST)', kind: 'money', width: 20 }, { header: 'Non-GST billed', kind: 'money', width: 16 },
      ],
      rows: rows.map((p) => [
        p.vendor_invoice_date, p.vendor_invoice_no, p.vendor_name, p.vendor_gstin, p.warehouse_name, p.lorry_receipt_no,
        p.lines.length, n(p.taxable_total), n(p.tax_total), n(p.freight_amount) + n(p.loading_charges) + n(p.other_charges), n(p.grand_total), n(p.credit_total),
        discLabel(p.bill_discount_type, p.bill_discount_value), n(p.total_discount), n(p.net_payable),
        p.status === 'PENDING' ? 'Waiting' : 'Approved', p.entered_by, p.approved_by,
        splitByGst(p.lines).gst.total, splitByGst(p.lines).nonGst.total,
      ]),
    },
    {
      name: 'Items',
      columns: [
        { header: 'Invoice date', kind: 'date', width: 13 }, { header: 'Invoice no', width: 18 }, { header: 'Vendor', width: 26 },
        { header: 'Warehouse', width: 14 }, { header: 'Item code', width: 16 }, { header: 'Item name', width: 34 },
        { header: 'Qty', kind: 'number', width: 8 }, { header: 'Unit', width: 7 }, { header: 'Rate excl. GST', kind: 'money', width: 14 },
        { header: 'GST %', kind: 'number', width: 7 }, { header: 'Taxable', kind: 'money', width: 13 }, { header: 'Line total', kind: 'money', width: 13 },
        { header: 'Billed as', width: 10 }, { header: 'HSN', width: 9 }, { header: 'Discount %', kind: 'number', width: 10 },
        { header: 'Discount ₹', kind: 'money', width: 11 }, { header: 'Credit note %', kind: 'number', width: 12 },
        { header: 'Credit note ₹', kind: 'money', width: 12 },
        { header: 'Your extra discount', width: 16 }, { header: 'Your extra discount ₹', kind: 'money', width: 18 },
        { header: 'Net cost / base unit', kind: 'money', width: 18 },
      ],
      rows: rows.flatMap((p) => p.lines.map((l) => [
        p.vendor_invoice_date, p.vendor_invoice_no, p.vendor_name, p.warehouse_name, l.sku_code, l.name,
        n(l.qty), l.uom, n(l.unit_base_price), n(l.gst_rate), n(l.line_taxable), n(l.line_total),
        n(l.gst_rate) > 0 ? 'GST' : 'Non-GST', l.hsn_code, n(l.discount_pct), n(l.discount_amount), n(l.credit_pct), n(l.credit_value),
        discLabel(l.item_discount_type, l.item_discount_value), n(l.item_discount_amount),
        l.effective_unit_cost_base != null ? n(l.effective_unit_cost_base) : null,
      ])),
    },
  ]).catch((e) => notify('Export failed', e instanceof Error ? e.message : String(e)));

  return (
    <Screen>
      <WarehouseSwitch />
      <Chips options={['Bills', 'Credit notes'] as const} value={view} onChange={setView}
        format={(v) => (v === 'Bills' ? 'Purchase bills' : 'Credit notes available')} />
      <Toolbar>
        <SmallButton title="＋ New purchase" kind="primary" onPress={() => setAdding(true)} />
      </Toolbar>
      {view === 'Credit notes' ? <CreditNotes /> : (
        <>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
          <SmallButton title="‹ Prev" onPress={() => setBack((b) => b + 1)} />
          <Text style={{ flex: 1, textAlign: 'center', color: t.text, fontSize: 18, fontWeight: '700' }}>{monthLong(month)}</Text>
          <SmallButton title="Next ›" onPress={() => setBack((b) => Math.max(0, b - 1))} disabled={back === 0} />
        </View>

        {pendingRows.length ? (
          <Card title={`Waiting for your approval (${pendingRows.length})`} subtitle="Entered by employees. Stock is added only after you approve — you can edit first." tone="warning">
            {pendingRows.map((p) => (
              <InvoiceCard key={p.id} p={p} onEdit={() => setEdit(p)} actions={
                <View style={{ flexDirection: 'row', gap: 8, flexWrap: 'wrap' }}>
                  <SmallButton title="✓ Approve & add to stock" kind="primary" onPress={() => approve.mutate(p)} disabled={approve.isPending} />
                  <SmallButton title="✕ Reject" kind="danger" onPress={() => void reject(p)} />
                </View>} />
            ))}
          </Card>
        ) : null}

        <Card title={`${whName} · ${approved.length} approved invoice(s)`} subtitle="Grouped by supplier invoice — tap Edit to change discounts, credit % or charges">
          <GstSplitRows {...splitByGst(approved.flatMap((p) => p.lines))} />
          <Row left="Billed (incl. GST + freight)" right={formatINR(billed)} />
          <Row left="Your extra discounts" right={formatINR(disc)} sub="per-item + per-bill · only you can see this" />
          <Row left="Net payable after discount" right={formatINR(net)} />
        </Card>

        <Field label="Search invoice no, vendor or item" value={search} onChangeText={setSearch} autoCapitalize="none" />
        <Toolbar>
          <SmallButton icon="⬇" title="Export month to Excel" onPress={doExport} disabled={!rows.length} />
        </Toolbar>

        {rows.map((p) => <InvoiceCard key={p.id} p={p} onEdit={() => setEdit(p)} />)}
        {!rows.length ? <Label muted>{list.isLoading ? 'Loading…' : `No purchases in ${monthLong(month)}`}</Label> : null}
        </>
      )}

      <Modal visible={adding} animationType="slide" onRequestClose={() => setAdding(false)}>
        <ScrollView style={{ flex: 1, backgroundColor: t.surface }} keyboardShouldPersistTaps="handled"
          contentContainerStyle={{ padding: 16, gap: 12, paddingTop: 40, width: '100%', maxWidth: 760, alignSelf: 'center' }}>
          <View style={{ flexDirection: 'row', alignItems: 'center' }}>
            <Text style={{ flex: 1, color: t.text, fontSize: 20, fontWeight: '700' }}>New purchase</Text>
            <SmallButton title="Close" onPress={() => setAdding(false)} />
          </View>
          <BillForm kind="purchase" owner onSaved={() => setAdding(false)} />
        </ScrollView>
      </Modal>
      <PurchaseEditor purchase={edit} onClose={() => setEdit(null)} />
    </Screen>
  );
}

function InvoiceCard({ p, onEdit, actions }: { p: Purchase; onEdit: () => void; actions?: ReactNode }) {
  const t = useTheme();
  return (
    <Card>
      <View style={{ flexDirection: 'row', gap: 8, alignItems: 'flex-start' }}>
        <View style={{ flex: 1, gap: 2 }}>
          <Text style={{ color: t.text, fontSize: 16, fontWeight: '700' }}>
            Invoice {p.vendor_invoice_no}{p.status === 'PENDING' ? '  ·  ⏳ waiting for approval' : ''}
          </Text>
          <Label>{dmy(p.vendor_invoice_date)} · {p.vendor_name} · {p.warehouse_name}{p.lorry_receipt_no ? ` · LR ${p.lorry_receipt_no}` : ''}</Label>
          <Text style={{ color: t.textSecondary, fontSize: 12 }}>
            Entered by {p.entered_by} · {dateTimeIST(p.entered_at)}
            {p.status === 'POSTED' && p.approved_by && p.entered_by_role === 'EMPLOYEE' ? ` · approved by ${p.approved_by} ${dateTimeIST(p.approved_at)}` : ''}
          </Text>
        </View>
        <SmallButton title="Edit" onPress={onEdit} />
      </View>

      {p.lines.map((l) => (
        <View key={l.id} style={{ flexDirection: 'row', gap: 8, paddingVertical: 6, borderBottomWidth: 0.5, borderColor: t.border }}>
          <View style={{ flex: 1 }}>
            <Text style={{ color: t.text }}>{l.name}</Text>
            <Text style={{ color: t.textMuted, fontSize: 12 }}>
              {l.sku_code}{l.hsn_code ? ` · HSN ${l.hsn_code}` : ''} · {n(l.qty)} {l.uom} × {formatINR(n(l.unit_base_price))}
              {n(l.discount_pct) ? ` − ${n(l.discount_pct)}%` : n(l.discount_amount) ? ` − ${formatINR(n(l.discount_amount))} disc.` : ''} + {n(l.gst_rate)}% GST
              {n(l.credit_value) ? ` · credit ${n(l.credit_pct)}% = ${formatINR(n(l.credit_value))}` : ''}
            </Text>
            <GstTag rate={l.gst_rate} />
            {n(l.item_discount_amount) > 0 ? (
              <Text style={{ color: t.good, fontSize: 12 }}>
                Extra discount {discLabel(l.item_discount_type, l.item_discount_value)} = −{formatINR(n(l.item_discount_amount))}
              </Text>
            ) : null}
          </View>
          <Text style={{ color: t.text, fontVariant: ['tabular-nums'], fontWeight: '600' }}>{formatINR(n(l.line_total))}</Text>
        </View>
      ))}

      <GstSplitRows {...splitByGst(p.lines)} />
      <Row left="Billed total" right={formatINR(n(p.grand_total))}
        sub={`taxable ${formatINR(n(p.taxable_total))} · GST ${formatINR(n(p.tax_total))}${n(p.freight_amount) + n(p.loading_charges) + n(p.other_charges) ? ` · extra charges ${formatINR(n(p.freight_amount) + n(p.loading_charges) + n(p.other_charges))}` : ''}`} />
      {n(p.credit_total) > 0 ? <Row left="Credit note earned" sub="for future purchases · not deducted from this bill" right={formatINR(n(p.credit_total))} /> : null}
      {n(p.total_discount) > 0 ? (
        <Row left="Net after your discounts" right={formatINR(n(p.net_payable))}
          sub={`−${formatINR(n(p.total_discount))}${n(p.bill_discount_amount) ? ` (bill ${discLabel(p.bill_discount_type, p.bill_discount_value)})` : ''}`} />
      ) : <Label muted>No extra discount recorded · tap Edit to add one</Label>}
      {actions}
    </Card>
  );
}

// ---------------------------------------------------------------------------- editor

interface EdLine {
  key: string; id?: string; productId: string; sku: string; name: string;
  uoms: { code: string; factor: number; displayName?: string }[];
  uom: string; qty: string; gstRate: number; price: UnitPrice | null; hsn: string | null;
  discType: DiscType | null; discValue: string; discReason: string;
  discPct: string; creditPct: string;
  orig?: { uom: string; qty: number; base: number; gst: number; discType: DiscType | null; discValue: number; discPct: number; creditPct: number; hsn: string | null };
}

const toIsoDate = (d: string) => {
  const m = d.trim().match(/^(\d{1,2})[-/.](\d{1,2})[-/.](\d{4})$/);
  return m ? `${m[3]}-${m[2]!.padStart(2, '0')}-${m[1]!.padStart(2, '0')}` : /^\d{4}-\d{2}-\d{2}$/.test(d.trim()) ? d.trim() : null;
};

function PurchaseEditor({ purchase: p, onClose }: { purchase: Purchase | null; onClose: () => void }) {
  const t = useTheme();
  const qc = useQueryClient();
  const slabs = useQuery({ queryKey: ['gst'], queryFn: () => q<{ rate: number }[]>(supabase.from('gst_rates').select('rate').eq('is_active', true).order('rate')), staleTime: 3600_000 });
  const ids = useMemo(() => [...new Set(p?.lines.map((l) => l.product_id) ?? [])], [p]);
  const uomQ = useQuery({
    queryKey: ['uoms', ids],
    enabled: ids.length > 0,
    queryFn: () => q<{ product_id: string; uom_code: string; factor_to_base: number; display_name: string }[]>(
      supabase.from('product_uoms').select('product_id, uom_code, factor_to_base, display_name').in('product_id', ids)),
  });

  const [invNo, setInvNo] = useState('');
  const [invDate, setInvDate] = useState('');
  const [lr, setLr] = useState('');
  const [freight, setFreight] = useState('');
  const [loadingC, setLoadingC] = useState('');
  const [otherC, setOtherC] = useState('');
  const [billType, setBillType] = useState<DiscType | 'NONE'>('NONE');
  const [billValue, setBillValue] = useState('');
  const [billReason, setBillReason] = useState('');
  const [lines, setLines] = useState<EdLine[]>([]);
  const [picker, setPicker] = useState(false);

  useEffect(() => {
    if (!p) return;
    setInvNo(p.vendor_invoice_no); setInvDate(dmy(p.vendor_invoice_date)); setLr(p.lorry_receipt_no ?? '');
    setFreight(String(n(p.freight_amount))); setLoadingC(String(n(p.loading_charges))); setOtherC(String(n(p.other_charges)));
    setBillType(p.bill_discount_type ?? 'NONE'); setBillValue(p.bill_discount_value ? String(n(p.bill_discount_value)) : '');
    setBillReason(p.bill_discount_reason ?? '');
    setLines(p.lines.map((l) => ({
      key: l.id, id: l.id, productId: l.product_id, sku: l.sku_code, name: l.name, uoms: [{ code: l.uom, factor: 1 }],
      uom: l.uom, qty: String(n(l.qty)), gstRate: n(l.gst_rate), hsn: l.hsn_code,
      price: { base: n(l.unit_base_price), inclusive: n(l.unit_incl_price), tax: n(l.unit_incl_price) - n(l.unit_base_price) },
      discType: l.item_discount_type, discValue: l.item_discount_value ? String(n(l.item_discount_value)) : '', discReason: '',
      discPct: n(l.discount_pct) ? String(n(l.discount_pct)) : '', creditPct: l.credit_pct ? String(n(l.credit_pct)) : '',
      orig: { uom: l.uom, qty: n(l.qty), base: n(l.unit_base_price), gst: n(l.gst_rate), discType: l.item_discount_type, discValue: n(l.item_discount_value),
              discPct: n(l.discount_pct), creditPct: n(l.credit_pct), hsn: l.hsn_code },
    })));
  }, [p]);

  // pack sizes (CTN / BOX / PCS) for items already on the bill
  const uomsOf = (l: EdLine) => {
    const u = (uomQ.data ?? []).filter((x) => x.product_id === l.productId)
      .map((x) => ({ code: x.uom_code, factor: n(x.factor_to_base), displayName: x.display_name }));
    return u.length ? u : l.uoms;
  };

  const upd = (i: number, patch: Partial<EdLine>) => setLines((ls) => ls.map((l, j) => (j === i ? { ...l, ...patch } : l)));

  const addItem = (h: ProductHit) => {
    const base = h.uoms.find((u) => u.factor === 1)?.code ?? h.uoms[0]?.code ?? 'PCS';
    setLines((ls) => [...ls, {
      key: `new-${Date.now()}`, productId: h.id, sku: h.sku_code, name: h.name, uoms: h.uoms, uom: base, qty: '',
      gstRate: n(h.default_gst_rate), hsn: h.hsn_code, price: null, discType: null, discValue: '', discReason: '',
      discPct: '', creditPct: '',
    }]);
  };

  const structural = !!p && (lines.length !== p.lines.length || lines.some((l) => !l.orig
    || l.orig.uom !== l.uom || l.orig.qty !== Number(l.qty) || l.orig.gst !== l.gstRate || l.orig.base !== (l.price?.base ?? -1)
    || l.orig.discPct !== (Number(l.discPct) || 0) || (l.orig.hsn ?? '') !== (l.hsn ?? '')));
  const creditChanged = lines.some((l) => !l.orig || l.orig.creditPct !== (Number(l.creditPct) || 0));
  const lineDiscChanged = (l: EdLine) => !!l.orig
    && ((l.discType ?? null) !== (l.orig.discType ?? null) || Number(l.discValue || 0) !== l.orig.discValue);

  const linesValid = lines.length > 0 && lines.every((l) => Number(l.qty) > 0 && l.price && l.price.base >= 0);
  const isoDate = toIsoDate(invDate);
  const preview = lines.reduce((a, l) => {
    const gross = Math.round(Number(l.qty || 0) * (l.price?.base ?? 0) * 100) / 100;
    const taxable = gross - Math.round(gross * (Number(l.discPct) || 0)) / 100;
    const tax = Math.round(taxable * l.gstRate) / 100;
    const d = l.discType === 'PERCENT' ? taxable * Number(l.discValue || 0) / 100 : l.discType === 'AMOUNT' ? Math.min(Number(l.discValue || 0), taxable) : 0;
    return { taxable: a.taxable + taxable, tax: a.tax + tax, disc: a.disc + d };
  }, { taxable: 0, tax: 0, disc: 0 });

  const save = useMutation({
    mutationFn: async () => {
      if (!p) return;
      const header = { vendorInvoiceNo: invNo.trim(), vendorInvoiceDate: isoDate, lorryReceiptNo: lr.trim(), freightAmount: Number(freight || 0),
        loadingCharges: Number(loadingC || 0), otherCharges: Number(otherC || 0) };
      const payload: Record<string, unknown> = { ...header };
      if (structural) {
        payload.lines = lines.map((l) => ({
          productId: l.productId, uomCode: l.uom, qty: Number(l.qty), hsnCode: l.hsn, gstRate: l.gstRate,
          unitBasePrice: l.price!.base, unitInclPrice: l.price!.inclusive, discountPct: Number(l.discPct) || 0, creditPct: Number(l.creditPct) || 0,
          discountType: l.discType, discountValue: Number(l.discValue || 0), discountReason: l.discReason || null,
        }));
      }
      const after = await rpc<Purchase>('owner_update_purchase', { p_id: p.id, p: payload });
      if (!structural && creditChanged) {
        await rpc('owner_set_purchase_credits', { p_purchase: p.id, p_lines: lines.map((l, i) => ({ lineNo: i + 1, pct: Number(l.creditPct) || 0 })) });
      }
      if (!structural) {
        for (const l of lines.filter(lineDiscChanged)) {
          await rpc('owner_set_item_discount', { p_item: l.id, p_type: l.discType ?? 'AMOUNT', p_value: l.discType ? Number(l.discValue || 0) : 0, p_reason: l.discReason || null });
        }
      }
      const billChanged = (billType === 'NONE' ? null : billType) !== (p.bill_discount_type ?? null)
        || Number(billValue || 0) !== n(p.bill_discount_value) || (billReason || '') !== (p.bill_discount_reason ?? '');
      if (billChanged) {
        await rpc('owner_set_purchase_discount', {
          p_purchase: after.id, p_type: billType === 'NONE' ? 'AMOUNT' : billType,
          p_value: billType === 'NONE' ? 0 : Number(billValue || 0), p_reason: billReason || null,
        });
      }
    },
    onSuccess: () => {
      for (const k of ['purchases-month', 'pending-purchases', 'purchases-net', 'stock-overview', 'owner-stock', 'reorder']) void qc.invalidateQueries({ queryKey: [k] });
      notify('Purchase saved', structural && p?.status === 'POSTED' ? 'Items changed — stock has been updated.' : undefined);
      onClose();
    },
    onError: (e) => notify('Not saved', e instanceof Error ? e.message : String(e)),
  });

  if (!p) return null;
  const rates = (slabs.data ?? []).map((s) => n(s.rate));

  return (
    <Modal visible animationType="slide" onRequestClose={onClose}>
      <ScrollView style={{ flex: 1, backgroundColor: t.surface }} keyboardShouldPersistTaps="handled"
        contentContainerStyle={{ padding: 16, gap: 12, paddingTop: 40, width: '100%', maxWidth: 760, alignSelf: 'center' }}>
        <Text style={{ color: t.text, fontSize: 20, fontWeight: '700' }}>Edit purchase</Text>
        <Label>{p.vendor_name} · {p.warehouse_name}</Label>

        <Card title="Invoice">
          <Field label="Vendor invoice no" value={invNo} onChangeText={setInvNo} autoCapitalize="characters" />
          <Field label="Invoice date (DD-MM-YYYY)" value={invDate} onChangeText={setInvDate} error={invDate && !isoDate ? 'Use DD-MM-YYYY' : undefined} />
          <Field label="Lorry receipt (LR) no" value={lr} onChangeText={setLr} />
          <View style={{ flexDirection: 'row', gap: 8 }}>
            <Field label="Loading ₹" keyboardType="decimal-pad" value={loadingC} onChangeText={setLoadingC} />
            <Field label="Transport ₹" keyboardType="decimal-pad" value={freight} onChangeText={setFreight} />
            <Field label="Other ₹" keyboardType="decimal-pad" value={otherC} onChangeText={setOtherC} />
          </View>
        </Card>

        <Card title="Items">
          {lines.map((l, i) => (
            <View key={l.key} style={{ gap: 8, paddingBottom: 12, borderBottomWidth: 0.5, borderColor: t.border }}>
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
                <View style={{ flex: 1 }}>
                  <Text style={{ color: t.text, fontWeight: '700' }}>{i + 1}. {l.name}</Text>
                  <Label muted>{l.sku}</Label>
                </View>
                <SmallButton title="Remove" kind="danger" onPress={() => setLines((ls) => ls.filter((_, j) => j !== i))} />
              </View>
              {uomsOf(l).length > 1 ? <Chips options={uomsOf(l).map((u) => u.code)} value={l.uom} onChange={(c) => upd(i, { uom: c })} /> : null}
              <Field label={`Quantity (${l.uom})`} keyboardType="decimal-pad" value={l.qty} onChangeText={(v) => upd(i, { qty: v })} />
              <PriceGstField key={`${l.key}-${l.uom}`} gstRate={l.gstRate} slabs={rates.length ? rates : [l.gstRate]}
                onRateChange={(r) => upd(i, { gstRate: r, price: l.price ? fromBase(l.price.base, r) : null })}
                value={l.price} onChange={(pr) => upd(i, { price: pr })} unitLabel={l.uom} />
              <GstTag rate={l.gstRate} />
              <View style={{ flexDirection: 'row', gap: 8 }}>
                <Field label="HSN code" value={l.hsn ?? ''} keyboardType="number-pad" maxLength={8} onChangeText={(v) => upd(i, { hsn: v.replace(/\D/g, '') || null })} />
                <Field label="Discount % (on the seller's bill)" keyboardType="decimal-pad" value={l.discPct} onChangeText={(v) => upd(i, { discPct: v })} placeholder="0" />
              </View>
              <Field label="Credit note % (credit for future purchases)" keyboardType="decimal-pad" value={l.creditPct}
                onChangeText={(v) => upd(i, { creditPct: v })} placeholder="0" />
              <Label>Extra discount on this item (only you see this)</Label>
              <Chips options={['NONE', 'PERCENT', 'AMOUNT'] as const} value={l.discType ?? 'NONE'}
                onChange={(v) => upd(i, { discType: v === 'NONE' ? null : v, discValue: v === 'NONE' ? '' : l.discValue })}
                format={(v) => (v === 'NONE' ? 'None' : v === 'PERCENT' ? '% off' : '₹ off')} />
              {l.discType ? (
                <View style={{ flexDirection: 'row', gap: 8 }}>
                  <Field label={l.discType === 'PERCENT' ? 'Discount %' : 'Discount ₹ (whole line)'} keyboardType="decimal-pad"
                    value={l.discValue} onChangeText={(v) => upd(i, { discValue: v })} />
                  <Field label="Reason (optional)" value={l.discReason} onChangeText={(v) => upd(i, { discReason: v })} placeholder="Scheme, cash discount…" />
                </View>
              ) : null}
            </View>
          ))}
          <Button title="＋ Add item" kind="secondary" onPress={() => setPicker(true)} />
          {structural ? <Label muted>Items/quantities changed — stock will be adjusted when you save.</Label> : null}
        </Card>

        <Card title="Extra discount on the whole bill (only you see this)">
          <Chips options={['NONE', 'PERCENT', 'AMOUNT'] as const} value={billType} onChange={setBillType}
            format={(v) => (v === 'NONE' ? 'None' : v === 'PERCENT' ? '% of bill value' : '₹ amount')} />
          {billType !== 'NONE' ? (
            <>
              <Field label={billType === 'PERCENT' ? 'Discount %' : 'Discount ₹'} keyboardType="decimal-pad" value={billValue} onChangeText={setBillValue} />
              <Field label="Reason (optional)" value={billReason} onChangeText={setBillReason} placeholder="Quarterly scheme, cash discount…" />
            </>
          ) : null}
        </Card>

        <Card title="Preview">
          <Row left="Taxable" right={formatINR(preview.taxable)} />
          <Row left="GST" right={formatINR(preview.tax)} />
          <Row left="Extra charges" right={formatINR(Number(freight || 0) + Number(loadingC || 0) + Number(otherC || 0))} />
          <Row left="Billed total" right={formatINR(preview.taxable + preview.tax + Number(freight || 0) + Number(loadingC || 0) + Number(otherC || 0))} />
          <Row left="Item discounts" right={`−${formatINR(preview.disc)}`} sub="bill discount is applied on save" />
        </Card>

        <Button title="Save changes" onPress={() => save.mutate()} busy={save.isPending}
          disabled={!invNo.trim() || !isoDate || !linesValid} />
        <Pressable onPress={onClose}><Text style={{ color: t.accent, textAlign: 'center', padding: 12 }}>Cancel</Text></Pressable>
      </ScrollView>
      <ItemPicker visible={picker} onClose={() => setPicker(false)} onPick={addItem} />
    </Modal>
  );
}

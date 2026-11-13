/**
 * One bill-entry form for both SALES and PURCHASES (staff screens and the
 * owner's "＋ New sale" / "＋ New purchase").
 *
 * Per item: qty → HSN → price excl. GST → discount % → GST %; the line total
 * ("MRP") = (price × qty − discount) + GST. 0 % GST lines are Non-GST billed.
 * Extra charges (loading / transport / other) are added to the bill total.
 * Purchases also carry the seller's invoice no/date, LR no, a photo, and — for
 * the owner only — a credit-note % per item (credit earned for future buying).
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import * as ImagePicker from 'expo-image-picker';
import { useEffect, useState } from 'react';
import { Text, View } from 'react-native';
import {
  documentTotals, formatINR, isValidGstin, purchaseLine, saleLine, splitByGst, type LineAmounts, type StockShortfall,
} from '@wh/shared';
import { ApiError, q, rpc, uploadPurchaseDoc } from '../api/client';
import { toUoms, type Me, type Party, type ProductHit } from '../api/types';
import { useAuth } from '../auth/store';
import { dmy } from '../lib/dates';
import { askText, confirmAsk, notify } from '../lib/dialogs';
import type { InvBill } from '../lib/invoice';
import { draftKey, isOffline, loadDraft, saveDraft, useOutbox } from '../lib/outbox';
import { newClientTxnId, todayIST } from '../lib/ids';
import { supabase } from '../lib/supabase';
import { useWarehouses } from '../lib/warehouse';
import { useTheme } from '../theme';
import { GstSplitRows, GstTag } from './GstSplit';
import { ItemPicker } from './ItemPicker';
import { MaterialEntry } from './MaterialEntry';
import { NewItemSheet } from './NewItemSheet';
import { OverridePinSheet } from './OverridePinSheet';
import { PartyPicker } from './PartyPicker';
import { QtyUomField } from './QtyUomField';
import { Button, Card, Chips, Field, Label, Notice, Row, SmallButton } from './ui';

type Kind = 'sale' | 'purchase';
interface Line { product: ProductHit; uomCode: string; qty: string; hsn: string; gstRate: number; price: string; discPct: string; creditPct: string }
const factorOf = (p: ProductHit, code: string) => Number(p.uoms.find((u) => u.code === code)?.factor ?? 1);
const money = (n: number) => (Number.isFinite(n) ? String(Math.round(n * 100) / 100) : '');
const num = (s: string) => (s.trim() === '' ? 0 : Number(s));
const toIso = (d: string) => {
  const m = d.trim().match(/^(\d{1,2})[-/.](\d{1,2})[-/.](\d{4})$/);
  return m ? `${m[3]}-${m[2]!.padStart(2, '0')}-${m[1]!.padStart(2, '0')}` : null;
};

/** Same maths as the database for each kind. */
export function billLine(kind: Kind, qty: number, price: number, discPct: number, gst: number): LineAmounts {
  try {
    if (kind === 'sale') return saleLine(qty, price, discPct, gst);
    const amount = Math.round(Math.round(qty * price * 100) / 100 * discPct) / 100;
    return purchaseLine(qty, price, gst, amount);
  } catch { return saleLine(0, 0, 0, gst); }
}

interface Snapshot {
  balance: number; overdue: number; oldest_overdue_days: number | null; credit_limit: number | null; credit_days: number; over_limit: boolean;
  last_bill: { invoice_no: string; invoice_date: string; total: number; by: string; items: number } | null;
  last_payment: { paid_on: string; amount: number; mode: string } | null;
  items: { product_id: string; uom: string; price: number; discount_pct: number; date: string; qty: number }[];
}
interface Draft { whId: string | null; invoiceNo: string; invoiceDate: string; lr: string; partyMode: 'Existing' | 'New'; party: Party | null;
  newName: string; newGstin: string; newPhone: string; lines: Line[]; loading: string; transport: string; other: string }

export function BillForm({ kind, owner = false, onSaved, editOf }: { kind: Kind; owner?: boolean; onSaved?: () => void; editOf?: InvBill }) {
  const t = useTheme();
  const qc = useQueryClient();
  const isSale = kind === 'sale';
  const me = useQuery({ queryKey: ['me'], queryFn: () => rpc<Me>('me') });
  const whs = useWarehouses();
  const slabs = useQuery({ queryKey: ['gst'], staleTime: 3600_000, queryFn: () => q<{ rate: number }[]>(supabase.from('gst_rates').select('rate').eq('is_active', true).order('rate')) });

  const [txnId, setTxnId] = useState(newClientTxnId);
  const [whId, setWhId] = useState<string | null>(null);
  const [invoiceNo, setInvoiceNo] = useState('');
  const [invoiceDate, setInvoiceDate] = useState(dmy(todayIST()));
  const [lr, setLr] = useState('');
  const [partyMode, setPartyMode] = useState<'Existing' | 'New'>('Existing');
  const [party, setParty] = useState<Party | null>(null);
  const [newName, setNewName] = useState('');
  const [newGstin, setNewGstin] = useState('');
  const [newPhone, setNewPhone] = useState('');
  const [lines, setLines] = useState<Line[]>([]);
  const [picking, setPicking] = useState(false);
  const [creating, setCreating] = useState<string | null>(null);
  const [loading, setLoading] = useState('');
  const [transport, setTransport] = useState('');
  const [other, setOther] = useState('');
  const [allCredit, setAllCredit] = useState('');
  const [photo, setPhoto] = useState<{ uri: string; mime: 'image/jpeg' } | null>(null);
  const [shortfalls, setShortfalls] = useState<StockShortfall[] | null>(null);
  const [draft, setDraft] = useState<(Draft & { savedAt: string }) | null>(null);
  const userId = useAuth((s) => s.user?.id);
  const dKey = draftKey(kind, userId);
  const queue = useOutbox((s) => s.add);

  // Editing an existing bill (owner): load it into the form once.
  useEffect(() => {
    if (!editOf) { const d = loadDraft<Draft>(dKey); if (d && (d.lines?.length || d.party || d.newName)) setDraft(d); return; }
    setInvoiceNo(editOf.invoice_no); setInvoiceDate(dmy(editOf.invoice_date)); setWhId(editOf.warehouse_id);
    setParty({ id: editOf.customer_id, name: editOf.customer_name, gstin: editOf.customer_gstin, state_code: editOf.place_of_supply, phone: editOf.customer_phone });
    setLoading(Number(editOf.loading_charges) ? String(Number(editOf.loading_charges)) : '');
    setTransport(Number(editOf.transport_charges) ? String(Number(editOf.transport_charges)) : '');
    setOther(Number(editOf.other_charges) ? String(Number(editOf.other_charges)) : '');
    void Promise.all(editOf.lines.map((l) => rpc<ProductHit[]>('find_material', { p_code: l.sku_code, lim: 5, p_warehouse: editOf.warehouse_id })
      .then((r) => r.find((h) => h.id === l.product_id) ?? null, () => null)))
      .then((hits) => setLines(editOf.lines.flatMap((l, i) => {
        const h = hits[i];
        if (!h) return [];
        // stock shown = what is on the shelf + what this bill already took (it is put back when the edit is saved)
        const back = Number(l.qty) * Number(h.uoms.find((u) => u.code === l.uom)?.factor ?? 1);
        return [{ product: { ...h, qty_on_hand: Number(h.qty_on_hand) + back }, uomCode: l.uom, qty: String(Number(l.qty)), hsn: l.hsn_code ?? '',
          gstRate: Number(l.gst_rate), price: money(Number(l.unit_base_price)), discPct: Number(l.discount_pct) ? String(Number(l.discount_pct)) : '', creditPct: '' }];
      })));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editOf?.id]);

  // Keep an unfinished bill on this phone so nothing is lost if the app closes.
  useEffect(() => {
    if (editOf || draft) return;
    const empty = !lines.length && !party && !newName.trim();
    const id = setTimeout(() => saveDraft(dKey, empty ? null : { whId, invoiceNo, invoiceDate, lr, partyMode, party, newName, newGstin, newPhone, lines, loading, transport, other }), 600);
    return () => clearTimeout(id);
  }, [editOf, draft, dKey, whId, invoiceNo, invoiceDate, lr, partyMode, party, newName, newGstin, newPhone, lines, loading, transport, other]);
  const resumeDraft = () => {
    const d = draft!; setDraft(null);
    setWhId(d.whId); setInvoiceNo(d.invoiceNo); setInvoiceDate(d.invoiceDate); setLr(d.lr); setPartyMode(d.partyMode); setParty(d.party);
    setNewName(d.newName); setNewGstin(d.newGstin); setNewPhone(d.newPhone); setLines(d.lines); setLoading(d.loading); setTransport(d.transport); setOther(d.other);
  };
  const discardDraft = () => { saveDraft(dKey, null); setDraft(null); };

  // Customer history while billing: what they owe, overdue, credit limit, last prices.
  const snap = useQuery({ queryKey: ['customer-snapshot', party?.id], enabled: isSale && partyMode === 'Existing' && !!party?.id,
    queryFn: () => rpc<Snapshot>('customer_snapshot', { p_customer: party!.id }) });
  const lastPrice = new Map((snap.data?.items ?? []).map((x) => [x.product_id, x]));

  const partyWord = isSale ? 'customer' : 'seller';
  // Sales: owner AND employees choose the dispatch warehouse (stock is reduced there).
  // Purchases: owner chooses; employees enter for their own warehouse.
  const pickWh = (owner || isSale) && !editOf;
  const lockedWh = editOf ? whs.data?.find((w) => w.id === editOf.warehouse_id) : undefined;
  const defaultWh = owner ? whs.data?.[0]?.id : me.data?.warehouse_id ?? whs.data?.[0]?.id;
  const warehouse = lockedWh ?? (pickWh ? whs.data?.find((w) => w.id === (whId ?? defaultWh)) : undefined);
  const warehouseId = editOf ? editOf.warehouse_id : pickWh ? warehouse?.id : me.data?.warehouse_id ?? undefined;
  const whState = editOf || pickWh ? warehouse?.state_code : me.data?.warehouse_state;

  // When the dispatch warehouse changes, refresh "In stock" on lines already added.
  useEffect(() => {
    if (!isSale || !warehouseId || !lines.length || editOf) return;   // editing: warehouse is fixed and stock already includes this bill
    let live = true;
    void Promise.all(lines.map((l) => rpc<ProductHit[]>('find_material', { p_code: l.product.sku_code, lim: 1, p_warehouse: warehouseId })
      .then((r) => (r[0]?.id === l.product.id ? Number(r[0].qty_on_hand) : null), () => null)))
      .then((qs) => { if (live) setLines((ls) => ls.map((l, i) => (qs[i] != null && ls.length === qs.length ? { ...l, product: { ...l.product, qty_on_hand: qs[i]! } } : l))); });
    return () => { live = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [warehouseId, lines.length]);
  const gstin = newGstin.trim().toUpperCase();
  const gstinOk = !gstin || isValidGstin(gstin);
  const partyState = partyMode === 'New' ? (gstin && gstinOk ? gstin.slice(0, 2) : null) : party?.state_code ?? null;
  const interstate = !!partyState && !!whState && partyState !== whState;

  const amounts = lines.map((l) => billLine(kind, num(l.qty), num(l.price), num(l.discPct), l.gstRate));
  const totals = documentTotals(amounts, interstate);
  const split = splitByGst(lines.map((l, i) => ({ gst_rate: l.gstRate, line_taxable: amounts[i]!.taxable, line_total: amounts[i]!.total })));
  const charges = num(loading) + num(transport) + num(other);
  const billTotal = Math.round((totals.grandTotal + charges) * 100) / 100;
  const creditValue = lines.reduce((a, l, i) => a + Math.round(amounts[i]!.taxable * num(l.creditPct)) / 100, 0);

  const reset = () => {
    saveDraft(dKey, null);
    setTxnId(newClientTxnId()); setLines([]); setParty(null); setNewName(''); setNewGstin(''); setNewPhone('');
    setInvoiceNo(''); setLr(''); setLoading(''); setTransport(''); setOther(''); setAllCredit(''); setPhoto(null); setShortfalls(null);
  };

  async function takePhoto() {
    const perm = await ImagePicker.requestCameraPermissionsAsync();
    if (!perm.granted) return;
    const r = await ImagePicker.launchCameraAsync({ quality: 0.6, mediaTypes: ['images'] });
    if (!r.canceled && r.assets[0]) setPhoto({ uri: r.assets[0].uri, mime: 'image/jpeg' });
  }

  const lineJson = (l: Line) => ({
    productId: l.product.id, uomCode: l.uomCode, qty: num(l.qty), unitBasePrice: num(l.price), discountPct: num(l.discPct),
    gstRate: l.gstRate, hsnCode: l.hsn.trim() || undefined,
    ...(!isSale && owner && num(l.creditPct) > 0 ? { creditPct: num(l.creditPct) } : {}),
  });
  const partyJson = partyMode === 'New' ? { name: newName.trim(), gstin: gstin || undefined, phone: newPhone.trim() || undefined } : undefined;

  const save = useMutation({
    mutationFn: async (overrideId?: string) => {
      if (editOf) {
        const reason = await askText('Why are you changing this bill?', 'Kept with the old version of the bill (optional).', { optional: true });
        if (reason === null) throw new Error('cancelled');
        const r = await rpc<{ dispatch: { invoice_no: string; grand_total: number }; revision: number }>('owner_edit_dispatch', {
          p_id: editOf.id,
          p: { invoiceDate: toIso(invoiceDate) ?? undefined, customerId: partyMode === 'Existing' ? party?.id : undefined, newCustomer: partyJson,
            loadingCharges: num(loading), transportCharges: num(transport), otherCharges: num(other), overrideId, reason: reason || undefined,
            lines: lines.map(lineJson) },
        });
        return { title: 'Bill updated', msg: `Invoice ${r.dispatch.invoice_no} · ${formatINR(r.dispatch.grand_total)} (old version kept as revision ${r.revision})` };
      }
      if (isSale) {
        const args = {
          p: {
            clientTxnId: txnId, warehouseId,
            invoiceDate: owner ? toIso(invoiceDate) ?? undefined : undefined, invoiceNo: invoiceNo.trim() || undefined,
            customerId: partyMode === 'Existing' ? party?.id : undefined, newCustomer: partyJson,
            loadingCharges: num(loading), transportCharges: num(transport), otherCharges: num(other), overrideId,
            lines: lines.map(lineJson),
          },
        };
        const who = partyMode === 'Existing' ? party?.name : newName.trim();
        try {
          const r = await rpc<{ dispatch: { invoice_no: string; grand_total: number } }>('create_dispatch', args);
          return { title: 'Sale saved', msg: `Invoice ${r.dispatch.invoice_no} · ${formatINR(r.dispatch.grand_total)}` };
        } catch (e) {
          if (!isOffline(e)) throw e;
          queue({ id: txnId, fn: 'create_dispatch', args, label: `sale to ${who} (${formatINR(billTotal)})`, queuedAt: new Date().toISOString() });
          return { title: 'No internet — saved on this phone', msg: `The sale to ${who} will be sent by itself when the internet is back. Keep the app open or open it again later.` };
        }
      }
      const attachments = photo && warehouseId
        ? [{ kind: 'LORRY_RECEIPT', storagePath: await uploadPurchaseDoc(warehouseId, photo.uri, photo.mime, txnId), mimeType: photo.mime }]
        : [];
      const purchaseArgs = {
        p: {
          clientTxnId: txnId, warehouseId: owner ? warehouseId : undefined,
          vendorId: partyMode === 'Existing' ? party?.id : undefined, newVendor: partyJson,
          vendorInvoiceNo: invoiceNo.trim(), vendorInvoiceDate: toIso(invoiceDate), lorryReceiptNo: lr.trim() || undefined,
          freightAmount: num(transport), loadingCharges: num(loading), otherCharges: num(other), attachments,
          lines: lines.map(lineJson),
        },
      };
      let r: { purchase: { grand_total: number; status: string } };
      try {
        r = await rpc<{ purchase: { grand_total: number; status: string } }>('create_purchase', purchaseArgs);
      } catch (e) {
        if (!isOffline(e) || attachments.length) throw e;
        queue({ id: txnId, fn: 'create_purchase', args: purchaseArgs, label: `purchase ${invoiceNo.trim()} (${formatINR(billTotal)})`, queuedAt: new Date().toISOString() });
        return { title: 'No internet — saved on this phone', msg: 'The purchase will be sent by itself when the internet is back.' };
      }
      return r.purchase.status === 'PENDING'
        ? { title: 'Sent to the owner for approval', msg: `Bill total ${formatINR(r.purchase.grand_total)}. Stock is added once the owner approves it.` }
        : { title: 'Purchase saved', msg: `Bill total ${formatINR(r.purchase.grand_total)} · added to stock` };
    },
    onSuccess: (r) => {
      notify(r.title, r.msg);
      reset();
      for (const k of ['inventory', 'my-day', 'sales-month', 'purchases-month', 'pending-purchases', 'credit-summary', 'owner-stock',
        'stock-overview', 'reorder', 'trend-day', 'trend-month', 'top', 'my-dashboard', 'employees-month', 'sales-targets']) void qc.invalidateQueries({ queryKey: [k] });
      onSaved?.();
    },
    onError: (e) => {
      if (e instanceof Error && e.message === 'cancelled') return;
      if (e instanceof ApiError && e.code === 'INSUFFICIENT_STOCK') setShortfalls(e.details as StockShortfall[]);
      else notify('Could not save', e instanceof Error ? e.message : String(e));
    },
  });

  const vendorDisc = !isSale && partyMode === 'Existing' ? Number(party?.default_discount_pct ?? 0) : 0;
  const addProduct = (p: ProductHit) => {
    const base = p.uoms.find((u) => Number(u.factor) === 1)?.code ?? p.uoms[0]?.code ?? 'PCS';
    // Purchases: start from the list price minus this supplier's usual discount (both can be changed).
    setLines((ls) => [...ls, {
      product: p, uomCode: base, qty: '', hsn: p.hsn_code ?? '', gstRate: Number(p.default_gst_rate),
      price: p.default_selling_price != null && (isSale || vendorDisc > 0) ? money(Number(p.default_selling_price)) : '',
      discPct: !isSale && vendorDisc > 0 ? String(vendorDisc) : '', creditPct: allCredit,
    }]);
  };
  const repeatLast = async () => {
    if (!party?.id) return;
    if (lines.length && !(await confirmAsk('Replace the items?', 'The items already on this bill are replaced with the last order.', 'Replace'))) return;
    try {
      const r = await rpc<{ hit: ProductHit; uom: string; qty: number; price: number; discount_pct: number; gst_rate: number; hsn_code: string | null }[]>(
        'customer_last_order', { p_customer: party.id, p_warehouse: warehouseId });
      setLines(r.map((x) => ({ product: x.hit, uomCode: x.uom, qty: String(Number(x.qty)), hsn: x.hsn_code ?? x.hit.hsn_code ?? '', gstRate: Number(x.gst_rate),
        price: money(Number(x.price)), discPct: Number(x.discount_pct) ? String(Number(x.discount_pct)) : '', creditPct: '' })));
      if (!r.length) notify('Nothing to repeat', 'No earlier bill for this customer.');
    } catch (e) { notify('Could not load the last order', e instanceof Error ? e.message : String(e)); }
  };
  const update = (i: number, patch: Partial<Line>) => setLines((ls) => ls.map((l, j) => (j === i ? { ...l, ...patch } : l)));
  const changeUom = (i: number, code: string) => {
    // keep any price the user typed: convert it per piece, then to the new unit
    const l = lines[i]!;
    const perBase = l.price.trim() !== '' ? num(l.price) / factorOf(l.product, l.uomCode) : null;
    update(i, { uomCode: code, price: perBase != null ? money(perBase * factorOf(l.product, code)) : l.price });
  };
  const pctOk = (s: string) => s.trim() === '' || (num(s) >= 0 && num(s) <= 100);
  const partyOk = partyMode === 'Existing' ? !!party : newName.trim().length >= 2 && gstinOk;
  const linesOk = lines.length > 0 && lines.every((l) => num(l.qty) > 0 && l.price.trim() !== '' && num(l.price) >= 0
    && pctOk(l.discPct) && pctOk(l.creditPct) && (!l.hsn.trim() || /^[0-9]{4}([0-9]{2}){0,2}$/.test(l.hsn.trim())));
  const chargesOk = [loading, transport, other].every((c) => c.trim() === '' || num(c) >= 0);
  const headerOk = isSale ? invoiceNo.trim().length <= 16 && (!owner || !!toIso(invoiceDate))
    : invoiceNo.trim().length > 0 && !!toIso(invoiceDate);
  const valid = partyOk && linesOk && chargesOk && headerOk && (!pickWh || !!warehouse);

  return (
    <View style={{ gap: 12 }}>
      {draft ? (
        <Notice tone="warning" icon="document-text-outline">
          {`You have an unfinished ${isSale ? 'sale' : 'purchase'} from ${new Date(draft.savedAt).toLocaleString('en-IN', { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' })}`
            + ` (${draft.lines.length} item(s)${draft.party?.name || draft.newName ? `, ${draft.party?.name ?? draft.newName}` : ''}).`}
          {'\n'}<Text style={{ color: t.accent, fontWeight: '800' }} onPress={resumeDraft}>Continue it</Text>{'   ·   '}
          <Text style={{ color: t.textSecondary, fontWeight: '700' }} onPress={discardDraft}>Start fresh</Text>
        </Notice>
      ) : null}
      <Card title={editOf ? `Editing bill ${editOf.invoice_no}` : isSale ? 'Bill' : "Seller's bill"}>
        {editOf ? <Label muted>Dispatched from {warehouse?.name ?? '…'} · bill number stays {editOf.invoice_no}. Stock is corrected when you save.</Label> : null}
        {pickWh ? (
          <>
            <Label>{isSale ? 'Dispatch from warehouse' : 'Warehouse'}</Label>
            <Chips options={(whs.data ?? []).map((w) => w.id)} value={warehouse?.id ?? null} onChange={setWhId}
              format={(v) => { const w = whs.data?.find((x) => x.id === v); return w ? `${w.name} (${w.code})` : v; }} />
            {isSale ? <Label muted>Stock is reduced in {warehouse?.name ?? 'this warehouse'} and the bill number uses its series ({warehouse?.code ?? '…'}/…).</Label> : null}
          </>
        ) : editOf ? null : <Label muted>{me.data?.warehouse_name}</Label>}
        {editOf ? null : <Field label={isSale ? 'Invoice number (leave blank for automatic)' : "Seller's invoice number"} value={invoiceNo}
          onChangeText={(v) => setInvoiceNo(v.toUpperCase())} autoCapitalize="characters" maxLength={isSale ? 16 : 40}
          placeholder={isSale ? `e.g. ${warehouse?.code ?? 'CTR'}-101` : 'as printed on the bill'} />}
        {owner || !isSale ? (
          <Field label="Invoice date (DD-MM-YYYY)" value={invoiceDate} onChangeText={setInvoiceDate}
            error={invoiceDate && !toIso(invoiceDate) ? 'Use DD-MM-YYYY' : undefined} />
        ) : null}
        {!isSale ? (
          <>
            <Field label="Lorry receipt no. (optional)" value={lr} onChangeText={setLr} />
            <Button title={photo ? '✓ Photo attached — retake' : '📷 Photo of lorry receipt / invoice'} kind="secondary" onPress={() => void takePhoto()} />
          </>
        ) : null}
      </Card>

      <Card title={isSale ? 'Customer' : 'Seller'}>
        <Chips options={['Existing', 'New'] as const} value={partyMode} onChange={setPartyMode}
          format={(v) => (v === 'Existing' ? `Existing ${partyWord}` : `New ${partyWord}`)} />
        {partyMode === 'Existing' ? (
          <PartyPicker kind={isSale ? 'customers' : 'vendors'} value={party} onChange={setParty} />
        ) : (
          <>
            <Field label={`${isSale ? 'Customer' : 'Seller'} name`} value={newName} onChangeText={setNewName} placeholder="e.g. Sri Lakshmi Hardware" />
            <Field label="GST number (optional)" value={newGstin} onChangeText={(v) => setNewGstin(v.toUpperCase())}
              autoCapitalize="characters" maxLength={15} placeholder="15 characters, e.g. 37AAPFV1234K1ZS"
              error={!gstinOk ? 'This GST number is not valid' : undefined} />
            <Field label="Phone (optional)" value={newPhone} onChangeText={setNewPhone} keyboardType="phone-pad" />
          </>
        )}
        {party?.gstin && partyMode === 'Existing' ? <Label muted>GSTIN {party.gstin}</Label> : null}
        {vendorDisc > 0 ? <Label muted>This supplier's usual discount: {vendorDisc}% off the list price (filled in on each item — you can change it).</Label> : null}
        {snap.data ? (
          <View style={{ gap: 4 }}>
            <Row left="Balance to collect" right={formatINR(Number(snap.data.balance))}
              sub={snap.data.last_payment ? `last paid ${formatINR(Number(snap.data.last_payment.amount))} on ${dmy(snap.data.last_payment.paid_on)}` : 'no payment yet'} />
            {Number(snap.data.overdue) > 0 ? (
              <Notice tone="danger" icon="alert-circle-outline">{`${formatINR(Number(snap.data.overdue))} is overdue (oldest ${snap.data.oldest_overdue_days} days). Collect before giving more credit.`}</Notice>
            ) : null}
            {snap.data.over_limit ? (
              <Notice tone="danger" icon="hand-left-outline">{`Over the credit limit of ${formatINR(Number(snap.data.credit_limit))}. Ask the owner before billing on credit.`}</Notice>
            ) : snap.data.credit_limit != null ? <Label muted>Credit limit {formatINR(Number(snap.data.credit_limit))} · {snap.data.credit_days} days</Label> : null}
            {snap.data.last_bill ? (
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                <Label muted>{`Last bill ${snap.data.last_bill.invoice_no} on ${dmy(snap.data.last_bill.invoice_date)} · ${formatINR(Number(snap.data.last_bill.total))} · ${snap.data.last_bill.items} item(s) by ${snap.data.last_bill.by}`}</Label>
                {!editOf ? <SmallButton icon="repeat-outline" title="Repeat last order" onPress={() => void repeatLast()} /> : null}
              </View>
            ) : <Label muted>First bill for this customer</Label>}
          </View>
        ) : null}
      </Card>

      {lines.map((l, i) => {
        const a = amounts[i]!;
        return (
          <Card key={`${l.product.id}-${i}`}>
            <View style={{ flexDirection: 'row', alignItems: 'flex-start', gap: 8 }}>
              <View style={{ flex: 1, gap: 4 }}>
                <Text style={{ color: t.text, fontSize: 16, fontWeight: '700' }}>{i + 1}. {l.product.name}</Text>
                <Label muted>Material No. {l.product.sku_code}{l.product.brand ? ` · ${l.product.brand}` : ''}</Label>
                {l.product.specification ? <Label muted>{l.product.specification}</Label> : null}
                {isSale ? <Label muted>In stock at {warehouse?.name ?? 'this warehouse'}: {Number(l.product.qty_on_hand)} {l.product.uoms.find((u) => Number(u.factor) === 1)?.code ?? 'PCS'}</Label> : null}
                {isSale && lastPrice.get(l.product.id) ? (() => { const lp = lastPrice.get(l.product.id)!; return (
                  <Label muted>{`Last sold to this customer: ${formatINR(Number(lp.price))}/${lp.uom}${Number(lp.discount_pct) ? ` − ${Number(lp.discount_pct)}%` : ''} on ${dmy(lp.date)}`}</Label>); })() : null}
                <GstTag rate={l.gstRate} />
              </View>
              <SmallButton title="Remove" kind="danger" onPress={() => setLines((ls) => ls.filter((_, j) => j !== i))} />
            </View>
            <QtyUomField uoms={toUoms(l.product)} uomCode={l.uomCode} onUomChange={(c) => changeUom(i, c)} qty={l.qty} onQtyChange={(v) => update(i, { qty: v })} />
            <Field label="HSN code" value={l.hsn} keyboardType="number-pad" maxLength={8} onChangeText={(v) => update(i, { hsn: v.replace(/\D/g, '') })}
              error={l.hsn && !/^[0-9]{4}([0-9]{2}){0,2}$/.test(l.hsn) ? '4, 6 or 8 digits' : undefined} />
            <View style={{ flexDirection: 'row', gap: 8 }}>
              <Field label={`Price / ${l.uomCode} excl. GST`} keyboardType="decimal-pad" value={l.price} onChangeText={(v) => update(i, { price: v })} />
              <Field label="Discount %" keyboardType="decimal-pad" value={l.discPct} onChangeText={(v) => update(i, { discPct: v })} placeholder="0"
                error={!pctOk(l.discPct) ? '0–100' : undefined} />
            </View>
            <Label>GST % (0% = Non-GST){Number(l.product.default_gst_rate) !== l.gstRate ? ` · price list says ${Number(l.product.default_gst_rate)}%` : ''}</Label>
            <Chips options={(slabs.data ?? []).map((s) => Number(s.rate))} value={l.gstRate} onChange={(r) => update(i, { gstRate: r })} format={(r) => `${r}%`} />
            {!isSale && owner ? (
              <Field label="Credit note % (credit for future purchases — only you see this)" keyboardType="decimal-pad" value={l.creditPct}
                onChangeText={(v) => update(i, { creditPct: v })} placeholder="0" error={!pctOk(l.creditPct) ? '0–100' : undefined} />
            ) : null}
            <Row left={`Total (MRP)`} sub={`(${formatINR(num(l.price))} × ${num(l.qty)} = ${formatINR(a.gross)}) − ${formatINR(a.discount)} discount + ${formatINR(a.tax)} GST`
              + (!isSale && owner && num(l.creditPct) > 0 ? ` · credit ${formatINR(Math.round(a.taxable * num(l.creditPct)) / 100)}` : '')}
              right={formatINR(a.total)} />
          </Card>
        );
      })}
      <MaterialEntry warehouseId={isSale ? warehouseId : undefined} warehouseName={isSale ? warehouse?.name : undefined} onPick={addProduct} onCreateNew={(c) => setCreating(c)} showPrice={isSale} />
      <View style={{ flexDirection: 'row', gap: 8, flexWrap: 'wrap' }}>
        <View style={{ flex: 1, minWidth: 200 }}><Button title="Search items by name" icon="search" kind="secondary" onPress={() => setPicking(true)} /></View>
        <View style={{ flex: 1, minWidth: 200 }}><Button title="New item / company / category" icon="add-circle-outline" kind="secondary" onPress={() => setCreating('')} /></View>
      </View>

      <Card title="Extra charges">
        <View style={{ flexDirection: 'row', gap: 8 }}>
          <Field label="Loading ₹" keyboardType="decimal-pad" value={loading} onChangeText={setLoading} placeholder="0" />
          <Field label="Transport ₹" keyboardType="decimal-pad" value={transport} onChangeText={setTransport} placeholder="0" />
          <Field label="Other ₹" keyboardType="decimal-pad" value={other} onChangeText={setOther} placeholder="0" />
        </View>
      </Card>

      {!isSale && owner && lines.length > 1 ? (
        <Card title="Credit note % for the whole bill">
          <View style={{ flexDirection: 'row', gap: 8, alignItems: 'flex-end' }}>
            <Field label="Same credit % on every item" keyboardType="decimal-pad" value={allCredit} onChangeText={setAllCredit} placeholder="e.g. 2" />
            <SmallButton title="Apply to all items" onPress={() => setLines((ls) => ls.map((l) => ({ ...l, creditPct: allCredit })))} disabled={!pctOk(allCredit)} />
          </View>
        </Card>
      ) : null}

      <Card title="Bill total">
        <GstSplitRows gst={split.gst} nonGst={split.nonGst} />
        {totals.discount ? <Row left="Discount" right={`−${formatINR(totals.discount)}`} /> : null}
        <Row left="Total excl. GST" right={formatINR(totals.taxable)} />
        {interstate
          ? <Row left="IGST" right={formatINR(totals.igst)} />
          : <><Row left="CGST" right={formatINR(totals.cgst)} /><Row left="SGST" right={formatINR(totals.sgst)} /></>}
        {charges ? <Row left="Extra charges" sub={[loading && `loading ${formatINR(num(loading))}`, transport && `transport ${formatINR(num(transport))}`,
          other && `other ${formatINR(num(other))}`].filter(Boolean).join(' · ')} right={formatINR(charges)} /> : null}
        <Text style={{ color: t.text, fontSize: 22, fontWeight: '800', textAlign: 'right' }}>{formatINR(billTotal)}</Text>
        {!isSale && owner && creditValue > 0 ? (
          <Row left="Credit note earned" sub="for future purchases from this seller · not deducted now" right={formatINR(creditValue)} />
        ) : null}
      </Card>
      <Button title={editOf ? 'Save changes to the bill' : isSale ? 'Save sale' : owner ? 'Save purchase' : 'Send purchase for approval'} onPress={() => save.mutate(undefined)}
        busy={save.isPending} disabled={!valid} />

      <ItemPicker visible={picking} onClose={() => setPicking(false)} onPick={addProduct} />
      <NewItemSheet visible={creating != null} initialCode={creating ?? ''} onClose={() => setCreating(null)} onCreated={addProduct} forPurchase={!isSale} />
      {isSale ? (
        <OverridePinSheet shortfalls={shortfalls} warehouseId={pickWh || editOf ? warehouseId : undefined}
          onCancel={() => setShortfalls(null)} onApproved={(id) => save.mutate(id)} />
      ) : null}
    </View>
  );
}

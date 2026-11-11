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
import { useState } from 'react';
import { Text, View } from 'react-native';
import {
  documentTotals, formatINR, isValidGstin, purchaseLine, saleLine, splitByGst, type LineAmounts, type StockShortfall,
} from '@wh/shared';
import { ApiError, q, rpc, uploadPurchaseDoc } from '../api/client';
import { toUoms, type Me, type Party, type ProductHit } from '../api/types';
import { dmy } from '../lib/dates';
import { notify } from '../lib/dialogs';
import { newClientTxnId, todayIST } from '../lib/ids';
import { supabase } from '../lib/supabase';
import { useWarehouses } from '../lib/warehouse';
import { useTheme } from '../theme';
import { GstSplitRows, GstTag } from './GstSplit';
import { ItemPicker } from './ItemPicker';
import { MaterialEntry } from './MaterialEntry';
import { OverridePinSheet } from './OverridePinSheet';
import { PartyPicker } from './PartyPicker';
import { QtyUomField } from './QtyUomField';
import { Button, Card, Chips, Field, Label, Row, SmallButton } from './ui';

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

export function BillForm({ kind, owner = false, onSaved }: { kind: Kind; owner?: boolean; onSaved?: () => void }) {
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
  const [loading, setLoading] = useState('');
  const [transport, setTransport] = useState('');
  const [other, setOther] = useState('');
  const [allCredit, setAllCredit] = useState('');
  const [photo, setPhoto] = useState<{ uri: string; mime: 'image/jpeg' } | null>(null);
  const [shortfalls, setShortfalls] = useState<StockShortfall[] | null>(null);

  const partyWord = isSale ? 'customer' : 'seller';
  const warehouse = owner ? whs.data?.find((w) => w.id === (whId ?? whs.data?.[0]?.id)) : undefined;
  const warehouseId = owner ? warehouse?.id : me.data?.warehouse_id ?? undefined;
  const whState = owner ? warehouse?.state_code : me.data?.warehouse_state;
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
      if (isSale) {
        const r = await rpc<{ dispatch: { invoice_no: string; grand_total: number } }>('create_dispatch', {
          p: {
            clientTxnId: txnId, warehouseId: owner ? warehouseId : undefined,
            invoiceDate: owner ? toIso(invoiceDate) ?? undefined : undefined, invoiceNo: invoiceNo.trim() || undefined,
            customerId: partyMode === 'Existing' ? party?.id : undefined, newCustomer: partyJson,
            loadingCharges: num(loading), transportCharges: num(transport), otherCharges: num(other), overrideId,
            lines: lines.map(lineJson),
          },
        });
        return { title: 'Sale saved', msg: `Invoice ${r.dispatch.invoice_no} · ${formatINR(r.dispatch.grand_total)}` };
      }
      const attachments = photo && warehouseId
        ? [{ kind: 'LORRY_RECEIPT', storagePath: await uploadPurchaseDoc(warehouseId, photo.uri, photo.mime, txnId), mimeType: photo.mime }]
        : [];
      const r = await rpc<{ purchase: { grand_total: number; status: string } }>('create_purchase', {
        p: {
          clientTxnId: txnId, warehouseId: owner ? warehouseId : undefined,
          vendorId: partyMode === 'Existing' ? party?.id : undefined, newVendor: partyJson,
          vendorInvoiceNo: invoiceNo.trim(), vendorInvoiceDate: toIso(invoiceDate), lorryReceiptNo: lr.trim() || undefined,
          freightAmount: num(transport), loadingCharges: num(loading), otherCharges: num(other), attachments,
          lines: lines.map(lineJson),
        },
      });
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
      if (e instanceof ApiError && e.code === 'INSUFFICIENT_STOCK') setShortfalls(e.details as StockShortfall[]);
      else notify('Could not save', e instanceof Error ? e.message : String(e));
    },
  });

  const addProduct = (p: ProductHit) => {
    const base = p.uoms.find((u) => Number(u.factor) === 1)?.code ?? p.uoms[0]?.code ?? 'PCS';
    setLines((ls) => [...ls, {
      product: p, uomCode: base, qty: '', hsn: p.hsn_code ?? '', gstRate: Number(p.default_gst_rate),
      price: isSale && p.default_selling_price != null ? money(Number(p.default_selling_price)) : '',
      discPct: '', creditPct: allCredit,
    }]);
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
  const valid = partyOk && linesOk && chargesOk && headerOk && (!owner || !!warehouse);

  return (
    <View style={{ gap: 12 }}>
      <Card title={isSale ? 'Bill' : "Seller's bill"}>
        {owner ? (
          <>
            <Label>Warehouse</Label>
            <Chips options={(whs.data ?? []).map((w) => w.id)} value={warehouse?.id ?? null} onChange={setWhId}
              format={(v) => whs.data?.find((w) => w.id === v)?.name ?? v} />
          </>
        ) : <Label muted>{me.data?.warehouse_name}</Label>}
        <Field label={isSale ? 'Invoice number (leave blank for automatic)' : "Seller's invoice number"} value={invoiceNo}
          onChangeText={(v) => setInvoiceNo(v.toUpperCase())} autoCapitalize="characters" maxLength={isSale ? 16 : 40}
          placeholder={isSale ? 'e.g. CTR-101' : 'as printed on the bill'} />
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
                {isSale ? <Label muted>In stock: {Number(l.product.qty_on_hand)} {l.product.uoms.find((u) => Number(u.factor) === 1)?.code ?? 'PCS'}</Label> : null}
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
      <MaterialEntry onPick={addProduct} showPrice={isSale} />
      <Button title="Search items by name" icon="search" kind="secondary" onPress={() => setPicking(true)} />

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
      <Button title={isSale ? 'Save sale' : owner ? 'Save purchase' : 'Send purchase for approval'} onPress={() => save.mutate(undefined)}
        busy={save.isPending} disabled={!valid} />

      <ItemPicker visible={picking} onClose={() => setPicking(false)} onPick={addProduct} />
      {isSale ? (
        <OverridePinSheet shortfalls={shortfalls} warehouseId={owner ? warehouseId : undefined}
          onCancel={() => setShortfalls(null)} onApproved={(id) => save.mutate(id)} />
      ) : null}
    </View>
  );
}

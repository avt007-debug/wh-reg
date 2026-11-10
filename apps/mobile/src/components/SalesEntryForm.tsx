/**
 * Sales bill entry (used by staff "Outward" and the owner's Sales page).
 * Invoice no. (blank = automatic), customer (existing, or new with GSTIN),
 * and per item: qty, HSN, GST %, price excl. GST, ₹ discount, MRP.
 * Lines with GST % above 0 are "GST billed"; 0 % lines are "Non-GST billed".
 * On INSUFFICIENT_STOCK the Admin Override sheet opens; the retry reuses the
 * same clientTxnId so nothing is ever saved twice.
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Text, View } from 'react-native';
import {
  documentTotals, formatINR, isValidGstin, saleLine, splitByGst, TRANSPORT_MODES, type StockShortfall,
} from '@wh/shared';
import { ApiError, q, rpc } from '../api/client';
import { toUoms, type Me, type Party, type ProductHit } from '../api/types';
import { dmy } from '../lib/dates';
import { notify } from '../lib/dialogs';
import { newClientTxnId, todayIST } from '../lib/ids';
import { supabase } from '../lib/supabase';
import { useWarehouses } from '../lib/warehouse';
import { useTheme } from '../theme';
import { GstSplitRows, GstTag } from './GstSplit';
import { ItemPicker } from './ItemPicker';
import { OverridePinSheet } from './OverridePinSheet';
import { PartyPicker } from './PartyPicker';
import { QtyUomField } from './QtyUomField';
import { Button, Card, Chips, Field, Label, Row, SmallButton } from './ui';

interface Line {
  product: ProductHit; uomCode: string; qty: string; hsn: string; gstRate: number; price: string; discount: string; mrp: string;
}
const factorOf = (p: ProductHit, code: string) => Number(p.uoms.find((u) => u.code === code)?.factor ?? 1);
const money = (n: number) => (Number.isFinite(n) ? String(Math.round(n * 100) / 100) : '');
const toIso = (d: string) => {
  const m = d.trim().match(/^(\d{1,2})[-/.](\d{1,2})[-/.](\d{4})$/);
  return m ? `${m[3]}-${m[2]!.padStart(2, '0')}-${m[1]!.padStart(2, '0')}` : null;
};

export function SalesEntryForm({ owner = false, onSaved }: { owner?: boolean; onSaved?: () => void }) {
  const t = useTheme();
  const qc = useQueryClient();
  const me = useQuery({ queryKey: ['me'], queryFn: () => rpc<Me>('me') });
  const whs = useWarehouses();
  const slabs = useQuery({ queryKey: ['gst'], staleTime: 3600_000, queryFn: () => q<{ rate: number }[]>(supabase.from('gst_rates').select('rate').eq('is_active', true).order('rate')) });
  const agents = useQuery({ queryKey: ['agents'], queryFn: () => q<{ id: string; name: string }[]>(supabase.from('sales_agents').select('id, name').eq('is_active', true).order('name')) });

  const [txnId, setTxnId] = useState(newClientTxnId);
  const [whId, setWhId] = useState<string | null>(null);
  const [invoiceNo, setInvoiceNo] = useState('');
  const [invoiceDate, setInvoiceDate] = useState(dmy(todayIST()));
  const [custMode, setCustMode] = useState<'Existing customer' | 'New customer'>('Existing customer');
  const [customer, setCustomer] = useState<Party | null>(null);
  const [newName, setNewName] = useState('');
  const [newGstin, setNewGstin] = useState('');
  const [newPhone, setNewPhone] = useState('');
  const [agentId, setAgentId] = useState<string | null>(null);
  const [lines, setLines] = useState<Line[]>([]);
  const [picking, setPicking] = useState(false);
  const [showTransport, setShowTransport] = useState(false);
  const [mode, setMode] = useState<(typeof TRANSPORT_MODES)[number]>('CUSTOMER_PICKUP');
  const [transporter, setTransporter] = useState('');
  const [vehicle, setVehicle] = useState('');
  const [driver, setDriver] = useState('');
  const [shortfalls, setShortfalls] = useState<StockShortfall[] | null>(null);

  const warehouse = owner ? whs.data?.find((w) => w.id === (whId ?? whs.data?.[0]?.id)) : undefined;
  const whState = owner ? warehouse?.state_code : me.data?.warehouse_state;
  const gstinUpper = newGstin.trim().toUpperCase();
  const gstinOk = !gstinUpper || isValidGstin(gstinUpper);
  const custState = custMode === 'New customer' ? (gstinUpper && gstinOk ? gstinUpper.slice(0, 2) : null) : customer?.state_code ?? null;
  const interstate = !!custState && !!whState && custState !== whState;

  const amounts = lines.map((l) => {
    try { return saleLine(Number(l.qty) || 0, Number(l.price) || 0, 0, l.gstRate, Number(l.discount) || 0); }
    catch { return saleLine(0, 0, 0, l.gstRate); }
  });
  const totals = documentTotals(amounts, interstate);
  const split = splitByGst(lines.map((l, i) => ({ gst_rate: l.gstRate, line_taxable: amounts[i]!.taxable, line_total: amounts[i]!.total })));

  const reset = () => {
    setTxnId(newClientTxnId()); setLines([]); setCustomer(null); setNewName(''); setNewGstin(''); setNewPhone('');
    setInvoiceNo(''); setVehicle(''); setDriver(''); setShortfalls(null);
  };

  const save = useMutation({
    mutationFn: (overrideId?: string) => rpc<{ dispatch: { invoice_no: string; grand_total: number } }>('create_dispatch', {
      p: {
        clientTxnId: txnId,
        warehouseId: owner ? warehouse?.id : undefined,
        invoiceDate: owner ? toIso(invoiceDate) ?? undefined : undefined,
        invoiceNo: invoiceNo.trim() || undefined,
        customerId: custMode === 'Existing customer' ? customer?.id : undefined,
        newCustomer: custMode === 'New customer' ? { name: newName.trim(), gstin: gstinUpper || undefined, phone: newPhone.trim() || undefined } : undefined,
        salesAgentId: agentId ?? undefined,
        transportMode: mode, transporterName: transporter || undefined, vehicleRegNo: vehicle || undefined, driverPhone: driver || undefined,
        overrideId,
        lines: lines.map((l) => ({
          productId: l.product.id, uomCode: l.uomCode, qty: Number(l.qty), unitBasePrice: Number(l.price),
          discountAmount: Number(l.discount) || 0, gstRate: l.gstRate, hsnCode: l.hsn.trim() || undefined, mrp: l.mrp ? Number(l.mrp) : undefined,
        })),
      },
    }),
    onSuccess: (r) => {
      notify('Sale saved', `Invoice ${r.dispatch.invoice_no} · ${formatINR(r.dispatch.grand_total)}`);
      reset();
      for (const k of ['inventory', 'my-day', 'sales-month', 'owner-stock', 'stock-overview', 'reorder', 'trend-day', 'trend-month', 'top']) {
        void qc.invalidateQueries({ queryKey: [k] });
      }
      onSaved?.();
    },
    onError: (e) => {
      if (e instanceof ApiError && e.code === 'INSUFFICIENT_STOCK') setShortfalls(e.details as StockShortfall[]);
      else notify('Could not save', e instanceof Error ? e.message : String(e));
    },
  });

  const update = (i: number, patch: Partial<Line>) => setLines((ls) => ls.map((l, j) => (j === i ? { ...l, ...patch } : l)));
  const changeUom = (i: number, code: string) => {
    const l = lines[i]!; const f = factorOf(l.product, code);
    update(i, {
      uomCode: code,
      price: l.product.default_selling_price != null ? money(Number(l.product.default_selling_price) * f) : l.price,
      mrp: l.product.mrp != null ? money(Number(l.product.mrp) * f) : l.mrp,
    });
  };
  const custOk = custMode === 'Existing customer' ? !!customer : newName.trim().length >= 2 && gstinOk;
  const linesOk = lines.length > 0 && lines.every((l, i) => Number(l.qty) > 0 && Number(l.price) >= 0 && l.price !== ''
    && (Number(l.discount) || 0) <= amounts[i]!.gross && (!l.hsn.trim() || /^[0-9]{4}([0-9]{2}){0,2}$/.test(l.hsn.trim())));
  const transportOk = !['OWN_VEHICLE', 'TRANSPORTER'].includes(mode) || vehicle.length >= 6;
  const valid = custOk && linesOk && transportOk && (!owner || (!!warehouse && !!toIso(invoiceDate))) && invoiceNo.trim().length <= 16;

  return (
    <View style={{ gap: 12 }}>
      <Card title="Bill">
        {owner ? (
          <>
            <Label>Warehouse</Label>
            <Chips options={(whs.data ?? []).map((w) => w.id)} value={warehouse?.id ?? null} onChange={setWhId}
              format={(v) => whs.data?.find((w) => w.id === v)?.name ?? v} />
            <Field label="Invoice date (DD-MM-YYYY)" value={invoiceDate} onChangeText={setInvoiceDate}
              error={invoiceDate && !toIso(invoiceDate) ? 'Use DD-MM-YYYY' : undefined} />
          </>
        ) : <Label muted>{me.data?.warehouse_name} · today</Label>}
        <Field label="Invoice number (leave blank for automatic)" value={invoiceNo} onChangeText={(v) => setInvoiceNo(v.toUpperCase())}
          autoCapitalize="characters" maxLength={16} placeholder="e.g. CTR-101" />
      </Card>

      <Card title="Customer">
        <Chips options={['Existing customer', 'New customer'] as const} value={custMode} onChange={setCustMode} />
        {custMode === 'Existing customer' ? (
          <PartyPicker kind="customers" value={customer} onChange={setCustomer} />
        ) : (
          <>
            <Field label="Customer name" value={newName} onChangeText={setNewName} placeholder="e.g. Sri Lakshmi Hardware" />
            <Field label="Customer GST number (optional)" value={newGstin} onChangeText={(v) => setNewGstin(v.toUpperCase())}
              autoCapitalize="characters" maxLength={15} placeholder="15 characters, e.g. 37AAPFV1234K1ZS"
              error={!gstinOk ? 'This GST number is not valid' : undefined} />
            <Field label="Phone (optional)" value={newPhone} onChangeText={setNewPhone} keyboardType="phone-pad" />
          </>
        )}
        {customer?.gstin && custMode === 'Existing customer' ? <Label muted>GSTIN {customer.gstin}</Label> : null}
        {(agents.data ?? []).length ? (
          <>
            <Label>Sales agent (optional)</Label>
            <Chips options={(agents.data ?? []).map((a) => a.id)} value={agentId} onChange={(v) => setAgentId(v === agentId ? null : v)}
              format={(v) => agents.data?.find((a) => a.id === v)?.name ?? ''} />
          </>
        ) : null}
      </Card>

      {lines.map((l, i) => (
        <Card key={`${l.product.id}-${i}`}>
          <View style={{ flexDirection: 'row', alignItems: 'flex-start', gap: 8 }}>
            <View style={{ flex: 1, gap: 4 }}>
              <Text style={{ color: t.text, fontSize: 16, fontWeight: '700' }}>{i + 1}. {l.product.name}</Text>
              <Label muted>{l.product.sku_code}</Label>
              <GstTag rate={l.gstRate} />
            </View>
            <SmallButton title="Remove" kind="danger" onPress={() => setLines((ls) => ls.filter((_, j) => j !== i))} />
          </View>
          <QtyUomField uoms={toUoms(l.product)} uomCode={l.uomCode} onUomChange={(c) => changeUom(i, c)} qty={l.qty} onQtyChange={(v) => update(i, { qty: v })} />
          <Field label="HSN code" value={l.hsn} keyboardType="number-pad" maxLength={8} onChangeText={(v) => update(i, { hsn: v.replace(/\D/g, '') })}
            error={l.hsn && !/^[0-9]{4}([0-9]{2}){0,2}$/.test(l.hsn) ? '4, 6 or 8 digits' : undefined} />
          <Label>GST % (0% = Non-GST)</Label>
          <Chips options={(slabs.data ?? []).map((s) => Number(s.rate))} value={l.gstRate} onChange={(r) => update(i, { gstRate: r })} format={(r) => `${r}%`} />
          <View style={{ flexDirection: 'row', gap: 8 }}>
            <Field label={`Price / ${l.uomCode} excl. GST`} keyboardType="decimal-pad" value={l.price} onChangeText={(v) => update(i, { price: v })} />
            <Field label={`MRP / ${l.uomCode}`} keyboardType="decimal-pad" value={l.mrp} onChangeText={(v) => update(i, { mrp: v })} />
          </View>
          <Field label="Discount ₹ (on this line)" keyboardType="decimal-pad" value={l.discount} onChangeText={(v) => update(i, { discount: v })}
            placeholder="0" error={(Number(l.discount) || 0) > amounts[i]!.gross ? 'More than the line value' : undefined} />
          <Row left={`Taxable ${formatINR(amounts[i]!.taxable)} + GST ${formatINR(amounts[i]!.tax)}`} right={formatINR(amounts[i]!.total)} />
        </Card>
      ))}
      <Button title="＋ Add item" kind="secondary" onPress={() => setPicking(true)} />

      <Card title="Transport (optional)">
        {!showTransport ? (
          <Row left={mode.replaceAll('_', ' ').toLowerCase()} right={<SmallButton title="Change" onPress={() => setShowTransport(true)} />} />
        ) : (
          <>
            <Chips options={TRANSPORT_MODES} value={mode} onChange={setMode} format={(m) => m.replaceAll('_', ' ').toLowerCase()} />
            <Field label="Transport name" value={transporter} onChangeText={setTransporter} placeholder="e.g. VRL Logistics" />
            <Field label="Vehicle registration no." value={vehicle} onChangeText={setVehicle} autoCapitalize="characters" placeholder="AP03AB1234"
              error={!transportOk ? 'Needed for own vehicle / transporter' : undefined} />
            <Field label="Driver phone" value={driver} onChangeText={setDriver} keyboardType="phone-pad" />
          </>
        )}
      </Card>

      <Card title="Bill total">
        <GstSplitRows gst={split.gst} nonGst={split.nonGst} />
        {totals.discount ? <Row left="Discount" right={`−${formatINR(totals.discount)}`} /> : null}
        <Row left="Total excl. GST" right={formatINR(totals.taxable)} />
        {interstate
          ? <Row left="IGST" right={formatINR(totals.igst)} />
          : <><Row left="CGST" right={formatINR(totals.cgst)} /><Row left="SGST" right={formatINR(totals.sgst)} /></>}
        <Text style={{ color: t.text, fontSize: 22, fontWeight: '800', textAlign: 'right' }}>{formatINR(totals.grandTotal)}</Text>
      </Card>
      <Button title="Save sale" onPress={() => save.mutate(undefined)} busy={save.isPending} disabled={!valid} />

      <ItemPicker visible={picking} onClose={() => setPicking(false)}
        onPick={(p) => {
          const base = p.uoms.find((u) => u.factor === 1)?.code ?? p.uoms[0]?.code ?? 'PCS';
          setLines((ls) => [...ls, {
            product: p, uomCode: base, qty: '', hsn: p.hsn_code ?? '', gstRate: Number(p.default_gst_rate),
            price: p.default_selling_price != null ? money(Number(p.default_selling_price)) : '',
            discount: '', mrp: p.mrp != null ? money(Number(p.mrp)) : '',
          }]);
        }} />
      <OverridePinSheet shortfalls={shortfalls} warehouseId={owner ? warehouse?.id : undefined}
        onCancel={() => setShortfalls(null)} onApproved={(id) => save.mutate(id)} />
    </View>
  );
}

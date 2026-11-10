/**
 * OUTWARD (Sales / Dispatch) entry.
 * Flow: customer → items (search/tree, qty+unit, price, discount) → transport → Save.
 * On 409 INSUFFICIENT_STOCK the Admin Override sheet opens; approval resubmits
 * with the SAME clientTxnId, so a double tap or flaky network never duplicates.
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useMemo, useState } from 'react';
import {Text, View} from 'react-native';
import {
  documentTotals, formatINR, saleLine, TRANSPORT_MODES, type StockShortfall,
} from '@wh/shared';
import { ApiError, q, rpc } from '../../src/api/client';
import { supabase } from '../../src/lib/supabase';
import { toUoms, type Me, type Party, type ProductHit } from '../../src/api/types';
import { ItemPicker } from '../../src/components/ItemPicker';
import { OverridePinSheet } from '../../src/components/OverridePinSheet';
import { PartyPicker } from '../../src/components/PartyPicker';
import { QtyUomField } from '../../src/components/QtyUomField';
import { Button, Card, Chips, Field, Label, Row, Screen } from '../../src/components/ui';
import { newClientTxnId } from '../../src/lib/ids';
import { notify } from '../../src/lib/dialogs';
import { useTheme } from '../../src/theme';

interface Line { product: ProductHit; uomCode: string; qty: string; price: string; discountPct: string }

export default function Outward() {
  const t = useTheme();
  const qc = useQueryClient();
  const me = useQuery({ queryKey: ['me'], queryFn: () => rpc<Me>('me') });
  const agents = useQuery({ queryKey: ['agents'], queryFn: () => q<{ id: string; name: string }[]>(supabase.from('sales_agents').select('id, name').eq('is_active', true).order('name')) });

  const [txnId, setTxnId] = useState(newClientTxnId);
  const [customer, setCustomer] = useState<Party | null>(null);
  const [agentId, setAgentId] = useState<string | null>(null);
  const [lines, setLines] = useState<Line[]>([]);
  const [picking, setPicking] = useState(false);
  const [mode, setMode] = useState<(typeof TRANSPORT_MODES)[number]>('TRANSPORTER');
  const [transporter, setTransporter] = useState('');
  const [vehicle, setVehicle] = useState('');
  const [driver, setDriver] = useState('');
  const [shortfalls, setShortfalls] = useState<StockShortfall[] | null>(null);

  // Live preview — same maths as the DB; server recomputes and is authoritative.
  const interstate = !!customer?.state_code && !!me.data?.warehouse_state && customer.state_code !== me.data.warehouse_state;
  const amounts = lines.map((l) => saleLine(Number(l.qty) || 0, Number(l.price) || 0, Number(l.discountPct) || 0, l.product.default_gst_rate));
  const totals = useMemo(() => documentTotals(amounts, interstate), [amounts, interstate]);

  const save = useMutation({
    mutationFn: (overrideId?: string) => rpc<{ dispatch: { invoice_no: string; grand_total: number } }>('create_dispatch', {
      p: {
        clientTxnId: txnId, customerId: customer!.id, salesAgentId: agentId ?? undefined,
        transportMode: mode, transporterName: transporter || undefined,
        vehicleRegNo: vehicle || undefined, driverPhone: driver || undefined, overrideId,
        lines: lines.map((l) => ({
          productId: l.product.id, uomCode: l.uomCode, qty: Number(l.qty),
          unitBasePrice: Number(l.price), discountPct: Number(l.discountPct) || 0,
        })),
      },
    }),   // server pins the warehouse, sets invoice no./date, GST split, and queues the WhatsApp alert
    onSuccess: (r) => {
      setShortfalls(null);
      notify('Dispatched', `${r.dispatch.invoice_no} · ${formatINR(r.dispatch.grand_total)}`);
      setTxnId(newClientTxnId()); setLines([]); setCustomer(null); setVehicle(''); setDriver('');
      void qc.invalidateQueries({ queryKey: ['inventory'] });
      void qc.invalidateQueries({ queryKey: ['my-day'] });
    },
    onError: (e) => {
      if (e instanceof ApiError && e.code === 'INSUFFICIENT_STOCK') setShortfalls(e.details as StockShortfall[]);
      else notify('Could not save', e instanceof Error ? e.message : String(e));
    },
  });

  const update = (i: number, patch: Partial<Line>) => setLines((ls) => ls.map((l, j) => (j === i ? { ...l, ...patch } : l)));
  const valid = !!customer && lines.length > 0 && lines.every((l) => Number(l.qty) > 0 && Number(l.price) >= 0)
    && (!['OWN_VEHICLE', 'TRANSPORTER'].includes(mode) || vehicle.length >= 6);

  return (
    <Screen>
      <Label muted>{me.data?.warehouse_name}</Label>
      <Card><PartyPicker kind="customers" value={customer} onChange={setCustomer} /></Card>
      <Card title="Sales agent">
        <Chips options={(agents.data ?? []).map((a) => a.name)} value={agents.data?.find((a) => a.id === agentId)?.name ?? null}
          onChange={(n) => setAgentId(agents.data?.find((a) => a.name === n)?.id ?? null)} />
      </Card>

      {lines.map((l, i) => (
        <Card key={`${l.product.id}-${i}`} title={l.product.name}>
          <Label muted>{l.product.sku_code} · GST {l.product.default_gst_rate}% · HSN {l.product.hsn_code ?? '-'}</Label>
          <QtyUomField uoms={toUoms(l.product)} uomCode={l.uomCode} onUomChange={(c) => update(i, { uomCode: c })}
            qty={l.qty} onQtyChange={(q) => update(i, { qty: q })} />
          <View style={{ flexDirection: 'row', gap: 10 }}>
            <Field label={`Base price / ${l.uomCode} (excl. GST)`} keyboardType="decimal-pad" value={l.price} onChangeText={(v) => update(i, { price: v })} />
            <Field label="Discount %" keyboardType="decimal-pad" value={l.discountPct} onChangeText={(v) => update(i, { discountPct: v })} />
          </View>
          <Row left="Final price (excl. GST)" right={formatINR(amounts[i]!.unitFinal)} />
          <Row left="Line total (incl. GST)" right={formatINR(amounts[i]!.total)} />
          <Button title="Remove" kind="secondary" onPress={() => setLines((ls) => ls.filter((_, j) => j !== i))} />
        </Card>
      ))}
      <Button title="+ Add item" kind="secondary" onPress={() => setPicking(true)} />

      <Card title="Transport">
        <Chips options={TRANSPORT_MODES} value={mode} onChange={setMode} format={(m) => m.replaceAll('_', ' ').toLowerCase()} />
        <Field label="Transport name" value={transporter} onChangeText={setTransporter} placeholder="e.g. VRL Logistics" />
        <Field label="Vehicle registration no." value={vehicle} onChangeText={setVehicle} autoCapitalize="characters" placeholder="KA01AB1234" />
        <Field label="Driver phone" value={driver} onChangeText={setDriver} keyboardType="phone-pad" />
      </Card>

      <Card title="Invoice total">
        <Row left="Discount" right={formatINR(totals.discount)} />
        <Row left="Total excl. GST" right={formatINR(totals.taxable)} />
        {interstate
          ? <Row left="IGST" right={formatINR(totals.igst)} />
          : <><Row left="CGST" right={formatINR(totals.cgst)} /><Row left="SGST" right={formatINR(totals.sgst)} /></>}
        <Text style={{ color: t.text, fontSize: 22, fontWeight: '800', textAlign: 'right' }}>{formatINR(totals.grandTotal)}</Text>
      </Card>
      <Button title="Save dispatch" onPress={() => save.mutate(undefined)} busy={save.isPending} disabled={!valid} />

      <ItemPicker visible={picking} onClose={() => setPicking(false)}
        onPick={(p) => setLines((ls) => [...ls, {
          product: p, uomCode: p.uoms.find((u) => u.factor === 1)?.code ?? 'PCS', qty: '',
          price: p.default_selling_price != null ? String(p.default_selling_price) : '', discountPct: '0',
        }])} />
      <OverridePinSheet shortfalls={shortfalls} onCancel={() => setShortfalls(null)} onApproved={(id) => save.mutate(id)} />
    </Screen>
  );
}

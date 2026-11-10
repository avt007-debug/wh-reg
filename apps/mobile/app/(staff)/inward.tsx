/**
 * INWARD (Goods Receipt / Purchase) entry.
 * Base ⇄ inclusive price auto-calculation per line, optional photo of the
 * paper lorry receipt / vendor invoice (uploaded straight to object storage).
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import * as ImagePicker from 'expo-image-picker';
import { useState } from 'react';
import { Alert, Text } from 'react-native';
import { documentTotals, formatINR, purchaseLine, type UnitPrice } from '@wh/shared';
import { api, uploadAttachment } from '../../src/api/client';
import { toUoms, type Me, type Party, type ProductHit } from '../../src/api/types';
import { ItemPicker } from '../../src/components/ItemPicker';
import { PartyPicker } from '../../src/components/PartyPicker';
import { PriceGstField } from '../../src/components/PriceGstField';
import { QtyUomField } from '../../src/components/QtyUomField';
import { Button, Card, Field, Row, Screen } from '../../src/components/ui';
import { newClientTxnId, todayIST } from '../../src/lib/ids';
import { useTheme } from '../../src/theme';

interface Line { product: ProductHit; uomCode: string; qty: string; gstRate: number; price: UnitPrice | null; hsn: string }

export default function Inward() {
  const t = useTheme();
  const qc = useQueryClient();
  const slabs = useQuery({ queryKey: ['gst'], queryFn: () => api<{ rate: number }[]>('/gst-rates'), staleTime: 3600_000 });
  const [txnId, setTxnId] = useState(newClientTxnId);
  const [vendor, setVendor] = useState<Party | null>(null);
  const [invoiceNo, setInvoiceNo] = useState('');
  const [invoiceDate, setInvoiceDate] = useState(todayIST());
  const [lr, setLr] = useState('');
  const [photo, setPhoto] = useState<{ uri: string; mime: 'image/jpeg' } | null>(null);
  const [lines, setLines] = useState<Line[]>([]);
  const [picking, setPicking] = useState(false);

  const me = useQuery({ queryKey: ['me'], queryFn: () => api<Me>('/me') });
  const amounts = lines.map((l) => purchaseLine(Number(l.qty) || 0, l.price?.base ?? 0, l.gstRate));
  // Preview only — the server derives IGST vs CGST+SGST from the vendor GSTIN.
  const interstate = !!vendor?.state_code && !!me.data?.warehouse_state && vendor.state_code !== me.data.warehouse_state;
  const totals = documentTotals(amounts, interstate);

  async function takePhoto() {
    const perm = await ImagePicker.requestCameraPermissionsAsync();
    if (!perm.granted) return;
    const r = await ImagePicker.launchCameraAsync({ quality: 0.6, mediaTypes: ['images'] });
    if (!r.canceled && r.assets[0]) setPhoto({ uri: r.assets[0].uri, mime: 'image/jpeg' });
  }

  const save = useMutation({
    mutationFn: async () => {
      const attachmentKeys = photo ? [{ kind: 'LORRY_RECEIPT', storageKey: await uploadAttachment(photo.uri, photo.mime), mimeType: photo.mime }] : [];
      return api<{ purchase: { grand_total: number } }>('/purchases', {
        body: {
          clientTxnId: txnId, vendorId: vendor!.id, vendorInvoiceNo: invoiceNo.trim(), vendorInvoiceDate: invoiceDate,
          lorryReceiptNo: lr || undefined, attachmentKeys,
          lines: lines.map((l) => ({
            productId: l.product.id, uomCode: l.uomCode, qty: Number(l.qty), gstRate: l.gstRate,
            unitBasePrice: l.price!.base, unitInclPrice: l.price!.inclusive, hsnCode: l.hsn || undefined,
          })),
        },
      });
    },
    onSuccess: (r) => {
      Alert.alert('Goods received', `Landed cost ${formatINR(r.purchase.grand_total)}`);
      setTxnId(newClientTxnId()); setLines([]); setVendor(null); setInvoiceNo(''); setLr(''); setPhoto(null);
      void qc.invalidateQueries({ queryKey: ['inventory'] });
      void qc.invalidateQueries({ queryKey: ['my-day'] });
    },
    onError: (e) => Alert.alert('Could not save', e instanceof Error ? e.message : String(e)),
  });

  const update = (i: number, patch: Partial<Line>) => setLines((ls) => ls.map((l, j) => (j === i ? { ...l, ...patch } : l)));
  const valid = !!vendor && invoiceNo.trim().length > 0 && lines.length > 0 && lines.every((l) => Number(l.qty) > 0 && l.price);

  return (
    <Screen>
      <Card>
        <PartyPicker kind="vendors" value={vendor} onChange={setVendor} />
        <Field label="Vendor invoice #" value={invoiceNo} onChangeText={setInvoiceNo} autoCapitalize="characters" />
        <Field label="Invoice date (YYYY-MM-DD)" value={invoiceDate} onChangeText={setInvoiceDate} />
        <Field label="Lorry receipt # (optional)" value={lr} onChangeText={setLr} />
        <Button title={photo ? '✓ Photo attached — retake' : '📷 Photo of lorry receipt / invoice'} kind="secondary" onPress={takePhoto} />
      </Card>

      {lines.map((l, i) => (
        <Card key={`${l.product.id}-${i}`} title={l.product.name}>
          <QtyUomField uoms={toUoms(l.product)} uomCode={l.uomCode} onUomChange={(c) => update(i, { uomCode: c })}
            qty={l.qty} onQtyChange={(q) => update(i, { qty: q })} />
          <Field label="HSN code" value={l.hsn} onChangeText={(v) => update(i, { hsn: v })} keyboardType="number-pad" />
          <PriceGstField gstRate={l.gstRate} slabs={(slabs.data ?? []).map((s) => s.rate)} onRateChange={(r) => update(i, { gstRate: r })}
            value={l.price} onChange={(p) => update(i, { price: p })} unitLabel={l.uomCode} />
          <Row left="Line total (incl. GST)" right={formatINR(amounts[i]!.total)} />
          <Button title="Remove" kind="secondary" onPress={() => setLines((ls) => ls.filter((_, j) => j !== i))} />
        </Card>
      ))}
      <Button title="+ Add item" kind="secondary" onPress={() => setPicking(true)} />

      <Card title="Total landed cost">
        <Row left="Base purchase value (excl. GST)" right={formatINR(totals.taxable)} />
        {interstate
          ? <Row left="IGST" right={formatINR(totals.igst)} />
          : <><Row left="CGST" right={formatINR(totals.cgst)} /><Row left="SGST" right={formatINR(totals.sgst)} /></>}
        <Text style={{ color: t.text, fontSize: 22, fontWeight: '800', textAlign: 'right' }}>{formatINR(totals.grandTotal)}</Text>
      </Card>
      <Button title="Save inward" onPress={() => save.mutate()} busy={save.isPending} disabled={!valid} />

      <ItemPicker visible={picking} onClose={() => setPicking(false)}
        onPick={(p) => setLines((ls) => [...ls, {
          product: p, uomCode: p.uoms[0]?.code ?? 'PCS', qty: '', gstRate: p.default_gst_rate, price: null, hsn: p.hsn_code ?? '',
        }])} />
    </Screen>
  );
}

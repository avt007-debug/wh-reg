/**
 * Owner-only: record the extra vendor discount on a purchase (scheme / cash
 * discount) and see billed value vs. final value after discount. Employees have
 * no endpoint, table or screen that exposes these numbers.
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Modal, View } from 'react-native';
import { formatINR } from '@wh/shared';
import { rpc } from '../../src/api/client';
import { Button, Card, Chips, Field, Label, Row, Screen } from '../../src/components/ui';
import { todayIST } from '../../src/lib/ids';
import { useTheme } from '../../src/theme';

interface NetRow {
  purchase_id: string; vendor_name: string; vendor_invoice_no: string; vendor_invoice_date: string;
  billed_taxable: number; billed_total: number; owner_discount: number; net_taxable: number; net_payable: number;
  effective_discount_pct: number | null; discount_type: 'PERCENT' | 'AMOUNT' | null; discount_value: number | null;
}

export default function OwnerPurchases() {
  const t = useTheme();
  const qc = useQueryClient();
  const from = `${todayIST().slice(0, 7)}-01`;
  const q = useQuery({ queryKey: ['purchases-net', from], queryFn: () => rpc<NetRow[]>('owner_purchases_net', { p_from: from, p_to: todayIST() }) });
  const [edit, setEdit] = useState<NetRow | null>(null);
  const [type, setType] = useState<'PERCENT' | 'AMOUNT'>('PERCENT');
  const [value, setValue] = useState('');
  const [reason, setReason] = useState('');

  const save = useMutation({
    mutationFn: () => rpc('owner_set_purchase_discount', { p_purchase: edit!.purchase_id, p_type: type, p_value: Number(value), p_reason: reason || null }),
    onSuccess: () => { setEdit(null); void qc.invalidateQueries({ queryKey: ['purchases-net'] }); void qc.invalidateQueries({ queryKey: ['stock-overview'] }); },
  });

  const billed = (q.data ?? []).reduce((a, r) => a + r.billed_total, 0);
  const net = (q.data ?? []).reduce((a, r) => a + r.net_payable, 0);

  return (
    <Screen>
      <Card title="This month">
        <Row left="Billed (incl. GST)" right={formatINR(billed)} />
        <Row left="Your extra discounts" right={formatINR(billed - net)} />
        <Row left="Net after discount" right={formatINR(net)} />
      </Card>
      {(q.data ?? []).map((r) => (
        <Card key={r.purchase_id}>
          <Row left={r.vendor_name} sub={`${r.vendor_invoice_no} · ${r.vendor_invoice_date}`} right={formatINR(r.billed_total)} />
          {r.owner_discount > 0
            ? <Label>Discount {formatINR(r.owner_discount)} ({r.effective_discount_pct}%) → net {formatINR(r.net_payable)}</Label>
            : <Label muted>No extra discount recorded</Label>}
          <Button title={r.owner_discount > 0 ? 'Edit discount' : 'Add discount'} kind="secondary"
            onPress={() => { setEdit(r); setType(r.discount_type ?? 'PERCENT'); setValue(r.discount_value ? String(r.discount_value) : ''); }} />
        </Card>
      ))}

      <Modal visible={!!edit} transparent animationType="fade" onRequestClose={() => setEdit(null)}>
        <View style={{ flex: 1, backgroundColor: '#0008', justifyContent: 'flex-end' }}>
          <View style={{ backgroundColor: t.surface, padding: 16, gap: 12 }}>
            <Label>{edit?.vendor_name} · {edit?.vendor_invoice_no} · billed {edit ? formatINR(edit.billed_taxable) : ''} excl. GST</Label>
            <Chips options={['PERCENT', 'AMOUNT'] as const} value={type} onChange={setType} format={(v) => (v === 'PERCENT' ? '% of value' : '₹ amount')} />
            <Field label={type === 'PERCENT' ? 'Discount %' : 'Discount ₹'} keyboardType="decimal-pad" value={value} onChangeText={setValue} />
            <Field label="Reason (optional)" value={reason} onChangeText={setReason} placeholder="Quarterly scheme, cash discount…" />
            <Button title="Save" onPress={() => save.mutate()} busy={save.isPending} disabled={!(Number(value) >= 0) || !value} />
            <Button title="Cancel" kind="secondary" onPress={() => setEdit(null)} />
          </View>
        </View>
      </Modal>
    </Screen>
  );
}

/** My bills: recent bills I made or of my warehouse — print / PDF, send on WhatsApp, mark delivered with proof. */
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { Text, View } from 'react-native';
import { formatINR } from '@wh/shared';
import { rpc } from '../../src/api/client';
import { MarkDeliveredSheet } from '../../src/components/DeliveryProof';
import { InvoiceActions } from '../../src/components/InvoiceActions';
import { Card, Chips, Field, Label, Screen, SmallButton } from '../../src/components/ui';
import { dateTimeIST, dmy } from '../../src/lib/dates';
import { useTheme } from '../../src/theme';

interface Bill { id: string; invoice_no: string; invoice_date: string; customer_name: string; customer_gstin: string | null; grand_total: number; status: string;
  warehouse_code: string; mine: boolean; by: string; delivered: boolean; receiver: string | null; delivered_at: string | null }

export default function MyBills() {
  const t = useTheme();
  const [days, setDays] = useState(7);
  const [who, setWho] = useState<'Mine' | 'Warehouse'>('Mine');
  const [search, setSearch] = useState('');
  const [deliver, setDeliver] = useState<Bill | null>(null);
  const q = useQuery({ queryKey: ['my-bills', days], queryFn: () => rpc<Bill[]>('my_recent_bills', { p_days: days }) });
  const needle = search.trim().toLowerCase();
  const rows = (q.data ?? []).filter((b) => (who === 'Warehouse' || b.mine) && (!needle || `${b.invoice_no} ${b.customer_name}`.toLowerCase().includes(needle)));
  return (
    <Screen>
      <Chips options={['Mine', 'Warehouse'] as const} value={who} onChange={setWho} format={(v) => (v === 'Mine' ? 'Bills I made' : 'All bills of my warehouse')} />
      <Chips options={[1, 7, 30]} value={days} onChange={setDays} format={(d) => (d === 1 ? 'Today' : `Last ${d} days`)} />
      <Field label="Search bill no. or customer" value={search} onChangeText={setSearch} autoCapitalize="none" />
      {rows.map((b) => (
        <Card key={b.id}>
          <View style={{ flexDirection: 'row', gap: 8, opacity: b.status === 'POSTED' ? 1 : 0.5 }}>
            <View style={{ flex: 1 }}>
              <Text style={{ color: t.text, fontWeight: '700', fontSize: 16 }}>{b.invoice_no}{b.status !== 'POSTED' ? ' · CANCELLED' : ''}</Text>
              <Label muted>{`${dmy(b.invoice_date)} · ${b.customer_name} · ${b.warehouse_code}${b.mine ? '' : ` · by ${b.by}`}`}</Label>
              {b.delivered ? <Text style={{ color: t.good, fontWeight: '700' }}>✓ Delivered to {b.receiver} · {dateTimeIST(b.delivered_at)}</Text> : null}
            </View>
            <Text style={{ color: t.text, fontWeight: '800' }}>{formatINR(Number(b.grand_total))}</Text>
          </View>
          {b.status === 'POSTED' ? (
            <>
              <InvoiceActions dispatchId={b.id} />
              <SmallButton icon="checkmark-done-outline" title={b.delivered ? 'Update delivery proof' : 'Mark delivered'} kind={b.delivered ? 'secondary' : 'primary'} onPress={() => setDeliver(b)} />
            </>
          ) : null}
        </Card>
      ))}
      {!rows.length ? <Label muted>{q.isLoading ? 'Loading…' : 'No bills'}</Label> : null}
      <MarkDeliveredSheet bill={deliver} onClose={() => setDeliver(null)} />
    </Screen>
  );
}

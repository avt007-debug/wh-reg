/** Returns: credit notes (customers sent goods back) and debit notes (we sent goods back to suppliers). */
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Text, View } from 'react-native';
import { formatINR } from '@wh/shared';
import { rpc } from '../../src/api/client';
import { useAuth } from '../../src/auth/store';
import { Card, Chips, Label, Notice, Row, Screen, SmallButton, Stat } from '../../src/components/ui';
import { dmy, monthLong, monthStart } from '../../src/lib/dates';
import { askText, notify } from '../../src/lib/dialogs';
import { todayIST } from '../../src/lib/ids';
import { useTheme } from '../../src/theme';

interface Ret { id: string; return_no: string; return_date: string; reason: string; taxable: number; tax: number; total: number; status: string; cancelled_reason: string | null;
  warehouse_code: string; entered_by: string; customer_name?: string; invoice_no?: string; vendor_name?: string; vendor_invoice_no?: string;
  lines: { sku_code: string; name: string; qty_base: number; total: number }[] }
const n = (x: unknown) => Number(x ?? 0);
const monthEnd = (m: string) => { const d = new Date(`${m}T00:00:00Z`); d.setUTCMonth(d.getUTCMonth() + 1); d.setUTCDate(0); return d.toISOString().slice(0, 10); };

export default function Returns() {
  const t = useTheme();
  const qc = useQueryClient();
  const fullOwner = useAuth((s) => s.user?.role) === 'OWNER';
  const [back, setBack] = useState(0);
  const [tab, setTab] = useState<'From customers' | 'To suppliers'>('From customers');
  const month = monthStart(back);
  const q = useQuery({ queryKey: ['returns', month], queryFn: () => rpc<{ sales: Ret[]; purchases: Ret[] }>('owner_returns', { p_from: month, p_to: back ? monthEnd(month) : todayIST() }) });
  const rows = (tab === 'From customers' ? q.data?.sales : q.data?.purchases) ?? [];
  const sum = (r: Ret[] | undefined) => (r ?? []).filter((x) => x.status === 'POSTED').reduce((a, x) => a + n(x.total), 0);
  const cancel = async (r: Ret) => {
    const why = await askText(`Cancel ${r.return_no}?`, 'Stock and balances go back to how they were before the return. Reason:');
    if (!why?.trim()) return;
    rpc(tab === 'From customers' ? 'owner_cancel_sales_return' : 'owner_cancel_purchase_return', { p_id: r.id, p_reason: why.trim() })
      .then(() => { for (const k of ['returns', 'owner-ledger', 'owner-customers', 'owner-suppliers', 'owner-stock']) void qc.invalidateQueries({ queryKey: [k] }); notify('Return cancelled'); },
        (e) => notify('Not cancelled', e instanceof Error ? e.message : String(e)));
  };
  return (
    <Screen>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
        <SmallButton title="‹ Prev" onPress={() => setBack((b) => b + 1)} />
        <Text style={{ flex: 1, textAlign: 'center', color: t.text, fontSize: 18, fontWeight: '700' }}>{monthLong(month)}</Text>
        <SmallButton title="Next ›" onPress={() => setBack((b) => Math.max(0, b - 1))} disabled={back === 0} />
      </View>
      <View style={{ flexDirection: 'row', gap: 10, flexWrap: 'wrap' }}>
        <Stat label="Credit notes (from customers)" value={formatINR(sum(q.data?.sales))} icon="return-down-back" />
        <Stat label="Debit notes (to suppliers)" value={formatINR(sum(q.data?.purchases))} icon="return-up-forward" />
      </View>
      <Notice icon="information-circle-outline">To record a return, open the bill on the Sales or Purchases page and tap "Goods returned".</Notice>
      <Chips options={['From customers', 'To suppliers'] as const} value={tab} onChange={setTab} />
      {rows.map((r) => (
        <Card key={r.id}>
          <View style={{ flexDirection: 'row', gap: 8, opacity: r.status === 'POSTED' ? 1 : 0.55 }}>
            <View style={{ flex: 1 }}>
              <Text style={{ color: t.text, fontWeight: '700' }}>{r.return_no}{r.status !== 'POSTED' ? ' · CANCELLED' : ''}</Text>
              <Label muted>{[dmy(r.return_date), r.customer_name ?? r.vendor_name, r.invoice_no ? `bill ${r.invoice_no}` : r.vendor_invoice_no ? `bill ${r.vendor_invoice_no}` : null, r.warehouse_code].filter(Boolean).join(' · ')}</Label>
              <Label muted>{`${r.reason} · by ${r.entered_by}`}</Label>
              {r.cancelled_reason ? <Text style={{ color: t.danger, fontSize: 12 }}>{r.cancelled_reason}</Text> : null}
            </View>
            <Text style={{ color: t.text, fontWeight: '800' }}>{formatINR(n(r.total))}</Text>
          </View>
          {r.lines.map((l, i) => <Row key={i} left={l.name} sub={`${l.sku_code} · ${n(l.qty_base)} pcs`} right={formatINR(n(l.total))} />)}
          {r.status === 'POSTED' && fullOwner ? <SmallButton title="Cancel this return" kind="danger" onPress={() => void cancel(r)} /> : null}
        </Card>
      ))}
      {!rows.length ? <Label muted>{q.isLoading ? 'Loading…' : 'No returns this month'}</Label> : null}
    </Screen>
  );
}

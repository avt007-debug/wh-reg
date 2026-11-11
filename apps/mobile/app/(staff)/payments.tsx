/**
 * Employee: record customer payments (date, mode, amount); see every customer's
 * pending balance and last bill, the bills I entered (I am responsible for
 * collecting them) and the payments I received.
 */
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { Pressable, Text, View } from 'react-native';
import { formatINR } from '@wh/shared';
import { rpc } from '../../src/api/client';
import { PaymentForm, StatementModal } from '../../src/components/Ledger';
import { Card, Chips, Field, Label, Row, Screen } from '../../src/components/ui';
import { dmy } from '../../src/lib/dates';
import { useTheme } from '../../src/theme';

interface MyLedger {
  customers: { customer_id: string; name: string; phone: string | null; balance: number; overdue: number; last_bill_date: string | null;
    last_payment_date: string | null; last_bill_by: string | null; mine_outstanding: number }[];
  my_bills: { dispatch_id: string; customer_id: string; customer_name: string; invoice_no: string; invoice_date: string; total: number; outstanding: number; days_old: number }[];
  my_payments: { id: string; customer_name: string; amount: number; paid_on: string; mode: string; reference: string | null }[];
}
const n = (x: unknown) => Number(x ?? 0);

export default function Payments() {
  const t = useTheme();
  const q = useQuery({ queryKey: ['my-ledger'], queryFn: () => rpc<MyLedger>('my_ledger') });
  const [view, setView] = useState<'Customers' | 'My bills' | 'My payments'>('Customers');
  const [search, setSearch] = useState('');
  const [open, setOpen] = useState<string | null>(null);
  const d = q.data;
  const myDue = (d?.my_bills ?? []).reduce((a, b) => a + n(b.outstanding), 0);
  const myLate = (d?.my_bills ?? []).filter((b) => n(b.outstanding) > 0 && b.days_old > 30).reduce((a, b) => a + n(b.outstanding), 0);
  const needle = search.trim().toLowerCase();

  return (
    <Screen>
      <Card title="My collection responsibility">
        <Row left="Unpaid on bills I entered" right={formatINR(myDue)} />
        {myLate ? <Row left="⚠ Late (over 30 days)" right={formatINR(myLate)} /> : null}
      </Card>
      <PaymentForm />
      <Chips options={['Customers', 'My bills', 'My payments'] as const} value={view} onChange={setView} />

      {view === 'Customers' ? (
        <>
          <Field label="Search customer" value={search} onChangeText={setSearch} autoCapitalize="none" />
          {(d?.customers ?? []).filter((c) => !needle || `${c.name} ${c.phone ?? ''}`.toLowerCase().includes(needle)).map((c) => (
            <Pressable key={c.customer_id} onPress={() => setOpen(c.customer_id)}>
              <Card>
                <View style={{ flexDirection: 'row', gap: 8 }}>
                  <View style={{ flex: 1, gap: 2 }}>
                    <Text style={{ color: t.text, fontWeight: '700' }}>{c.name}</Text>
                    <Label muted>Last bill {c.last_bill_date ? dmy(c.last_bill_date) : '—'}{c.last_bill_by ? ` by ${c.last_bill_by}` : ''} · last paid {c.last_payment_date ? dmy(c.last_payment_date) : '—'}</Label>
                    {n(c.mine_outstanding) > 0 ? <Text style={{ color: t.warning, fontSize: 12 }}>Your bills: {formatINR(n(c.mine_outstanding))} to collect</Text> : null}
                  </View>
                  <View style={{ alignItems: 'flex-end' }}>
                    <Text style={{ color: t.text, fontWeight: '800' }}>{formatINR(n(c.balance))}</Text>
                    {n(c.overdue) > 0 ? <Text style={{ color: t.danger, fontSize: 12 }}>⚠ {formatINR(n(c.overdue))} late</Text> : <Label muted>pending</Label>}
                  </View>
                </View>
              </Card>
            </Pressable>
          ))}
          {!d?.customers.length ? <Label muted>{q.isLoading ? 'Loading…' : 'No customers with pending payments'}</Label> : null}
        </>
      ) : view === 'My bills' ? (
        <Card title="Bills I entered">
          {(d?.my_bills ?? []).map((b) => (
            <Pressable key={b.dispatch_id} onPress={() => setOpen(b.customer_id)}>
              <Row left={`${b.invoice_no} · ${b.customer_name}`}
                sub={`${dmy(b.invoice_date)} · bill ${formatINR(n(b.total))} · ${n(b.outstanding) > 0 ? `${b.days_old} days${b.days_old > 30 ? ' — LATE' : ''}` : 'paid'}`}
                right={n(b.outstanding) > 0 ? formatINR(n(b.outstanding)) : '✓'} />
            </Pressable>
          ))}
          {!d?.my_bills.length ? <Label muted>No bills yet</Label> : null}
        </Card>
      ) : (
        <Card title="Payments I received (last 60 days)">
          {(d?.my_payments ?? []).map((p) => (
            <Row key={p.id} left={`${p.customer_name} · ${p.mode}`} sub={`${dmy(p.paid_on)}${p.reference ? ` · ${p.reference}` : ''}`} right={formatINR(n(p.amount))} />
          ))}
          {!d?.my_payments.length ? <Label muted>None yet</Label> : null}
        </Card>
      )}
      <StatementModal customerId={open} onClose={() => setOpen(null)} />
    </Screen>
  );
}

/**
 * Owner sales ledger: what every customer owes, payments received (date, mode,
 * amount, received by), late payers (> 30 days) with the employee responsible,
 * collections by employee, and monthly / yearly sales vs collections graphs.
 */
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { Pressable, Text, View } from 'react-native';
import { formatINR } from '@wh/shared';
import { rpc } from '../../src/api/client';
import { PaymentForm, StatementModal } from '../../src/components/Ledger';
import { Card, Chips, Field, Label, Row, Screen, SmallButton, Stat, Toolbar } from '../../src/components/ui';
import { WarehouseBars, type TrendPoint } from '../../src/components/WarehouseBars';
import { dateTimeIST, dmy, monthLabel } from '../../src/lib/dates';
import { notify } from '../../src/lib/dialogs';
import { exportXlsx } from '../../src/lib/exportFile';
import { fileStamp } from '../../src/lib/warehouse';
import { useTheme } from '../../src/theme';

interface Cust { customer_id: string; name: string; gstin: string | null; phone: string | null; billed: number; paid: number; balance: number;
  overdue: number; oldest_overdue_days: number | null; last_bill_date: string | null; last_payment_date: string | null; responsible: { name: string; outstanding: number }[] }
interface Late { dispatch_id: string; customer_id: string; customer_name: string; phone: string | null; invoice_no: string; invoice_date: string; days_old: number; total: number; outstanding: number; responsible: string }
interface Ledger {
  customers: Cust[]; late: Late[];
  monthly: { month: string; sales: number; collected: number }[];
  yearly: { fy: string; start: string; sales: number; collected: number }[];
  by_employee: { user_id: string; name: string; bills: number; outstanding: number; overdue: number; collected_this_month: number }[];
  payments: { id: string; customer_id: string; customer_name: string; amount: number; paid_on: string; mode: string; reference: string | null; notes: string | null; received_by: string; entered_at: string }[];
}
const n = (x: unknown) => Number(x ?? 0);

export default function LedgerPage() {
  const t = useTheme();
  const q = useQuery({ queryKey: ['owner-ledger'], queryFn: () => rpc<Ledger>('owner_ledger') });
  const [view, setView] = useState<'Customers' | 'Late payments' | 'Payments' | 'Employees'>('Customers');
  const [graph, setGraph] = useState<'Monthly' | 'Yearly'>('Monthly');
  const [search, setSearch] = useState('');
  const [open, setOpen] = useState<string | null>(null);
  const d = q.data;

  const outstanding = (d?.customers ?? []).reduce((a, c) => a + Math.max(0, n(c.balance)), 0);
  const overdue = (d?.late ?? []).reduce((a, l) => a + n(l.outstanding), 0);
  const thisMonth = d?.monthly[d.monthly.length - 1];
  const needle = search.trim().toLowerCase();
  const customers = (d?.customers ?? []).filter((c) => !needle || `${c.name} ${c.gstin ?? ''} ${c.phone ?? ''}`.toLowerCase().includes(needle));

  const points: TrendPoint[] = graph === 'Monthly'
    ? (d?.monthly ?? []).flatMap((m) => [{ bucket: m.month, warehouse_code: 'SALES', revenue_excl_gst: n(m.sales) }, { bucket: m.month, warehouse_code: 'PAID', revenue_excl_gst: n(m.collected) }])
    : (d?.yearly ?? []).flatMap((y) => [{ bucket: y.start, warehouse_code: 'SALES', revenue_excl_gst: n(y.sales) }, { bucket: y.start, warehouse_code: 'PAID', revenue_excl_gst: n(y.collected) }]);
  const buckets = graph === 'Monthly' ? (d?.monthly ?? []).map((m) => m.month) : (d?.yearly ?? []).map((y) => y.start);
  const fyOf = (b: string) => d?.yearly.find((y) => y.start === b)?.fy ?? b.slice(0, 4);

  const doExport = () => d && exportXlsx(`Sales_ledger_${fileStamp()}`, [
    { name: 'Customers', columns: [{ header: 'Customer', width: 28 }, { header: 'GSTIN', width: 18 }, { header: 'Phone', width: 13 },
        { header: 'Billed', kind: 'money', width: 13 }, { header: 'Paid', kind: 'money', width: 13 }, { header: 'Balance', kind: 'money', width: 13 },
        { header: 'Overdue >30 days', kind: 'money', width: 15 }, { header: 'Last bill', kind: 'date', width: 11 }, { header: 'Last payment', kind: 'date', width: 12 },
        { header: 'Responsible', width: 30 }],
      rows: d.customers.map((c) => [c.name, c.gstin, c.phone, n(c.billed), n(c.paid), n(c.balance), n(c.overdue), c.last_bill_date, c.last_payment_date,
        c.responsible.map((r) => `${r.name} ${formatINR(n(r.outstanding))}`).join(', ')]) },
    { name: 'Late payments', columns: [{ header: 'Customer', width: 26 }, { header: 'Phone', width: 13 }, { header: 'Invoice', width: 16 }, { header: 'Bill date', kind: 'date', width: 11 },
        { header: 'Days', kind: 'number', width: 7 }, { header: 'Bill total', kind: 'money', width: 12 }, { header: 'Unpaid', kind: 'money', width: 12 }, { header: 'Responsible', width: 20 }],
      rows: d.late.map((l) => [l.customer_name, l.phone, l.invoice_no, l.invoice_date, n(l.days_old), n(l.total), n(l.outstanding), l.responsible]) },
    { name: 'Payments', columns: [{ header: 'Date', kind: 'date', width: 11 }, { header: 'Customer', width: 26 }, { header: 'Mode', width: 9 }, { header: 'Reference', width: 16 },
        { header: 'Amount', kind: 'money', width: 13 }, { header: 'Received by', width: 20 }, { header: 'Note', width: 24 }],
      rows: d.payments.map((p) => [p.paid_on, p.customer_name, p.mode, p.reference, n(p.amount), p.received_by, p.notes]) },
    { name: 'Monthly', columns: [{ header: 'Month', width: 10 }, { header: 'Sales', kind: 'money', width: 14 }, { header: 'Collected', kind: 'money', width: 14 }],
      rows: d.monthly.map((m) => [monthLabel(m.month), n(m.sales), n(m.collected)]) },
    { name: 'Yearly', columns: [{ header: 'Financial year', width: 14 }, { header: 'Sales', kind: 'money', width: 14 }, { header: 'Collected', kind: 'money', width: 14 }],
      rows: d.yearly.map((y) => [y.fy, n(y.sales), n(y.collected)]) },
  ]).catch((e) => notify('Export failed', e instanceof Error ? e.message : String(e)));

  return (
    <Screen>
      <View style={{ flexDirection: 'row', gap: 10, flexWrap: 'wrap' }}>
        <Stat label="Total to collect" value={formatINR(outstanding)} sub={`${(d?.customers ?? []).filter((c) => n(c.balance) > 0).length} customer(s)`} />
        <Stat label="Late (over 30 days)" value={formatINR(overdue)} sub={`${new Set((d?.late ?? []).map((l) => l.customer_id)).size} customer(s)`} />
        <Stat label="Collected this month" value={formatINR(n(thisMonth?.collected))} sub={`sales ${formatINR(n(thisMonth?.sales))}`} />
      </View>

      <Card title="Sales vs payments collected" subtitle="Billed (incl. GST) against money received, month by month">
        <Chips options={['Monthly', 'Yearly'] as const} value={graph} onChange={setGraph} />
        <WarehouseBars points={points} warehouses={['SALES', 'PAID']} buckets={buckets} names={{ SALES: 'Sales (incl. GST)', PAID: 'Collected' }} showTotal={false}
          formatBucket={graph === 'Monthly' ? monthLabel : fyOf} formatAxis={graph === 'Monthly' ? (b) => monthLabel(b).slice(0, 3) : fyOf} />
      </Card>

      <PaymentForm />

      <Chips options={['Customers', 'Late payments', 'Payments', 'Employees'] as const} value={view} onChange={setView}
        format={(v) => (v === 'Late payments' ? `Late payments (${d?.late.length ?? 0})` : v === 'Employees' ? 'By employee' : v)} />
      <Toolbar><SmallButton icon="⬇" title="Export ledger to Excel" onPress={() => void doExport()} disabled={!d} /></Toolbar>

      {view === 'Customers' ? (
        <>
          <Field label="Search customer, GSTIN or phone" value={search} onChangeText={setSearch} autoCapitalize="none" />
          {customers.map((c) => (
            <Pressable key={c.customer_id} onPress={() => setOpen(c.customer_id)}>
              <Card>
                <View style={{ flexDirection: 'row', gap: 8 }}>
                  <View style={{ flex: 1, gap: 2 }}>
                    <Text style={{ color: t.text, fontSize: 16, fontWeight: '700' }}>{c.name}</Text>
                    <Label muted>Last bill {c.last_bill_date ? dmy(c.last_bill_date) : '—'} · last payment {c.last_payment_date ? dmy(c.last_payment_date) : '—'}</Label>
                    {c.responsible.length ? <Text style={{ color: t.textSecondary, fontSize: 12 }}>To collect: {c.responsible.map((r) => `${r.name} ${formatINR(n(r.outstanding))}`).join(' · ')}</Text> : null}
                  </View>
                  <View style={{ alignItems: 'flex-end' }}>
                    <Text style={{ color: n(c.balance) > 0 ? t.text : t.good, fontSize: 17, fontWeight: '800' }}>{formatINR(n(c.balance))}</Text>
                    {n(c.overdue) > 0 ? <Text style={{ color: t.danger, fontSize: 12, fontWeight: '700' }}>⚠ {formatINR(n(c.overdue))} late · {c.oldest_overdue_days} days</Text>
                      : <Label muted>{n(c.balance) > 0 ? 'due' : n(c.balance) < 0 ? 'advance' : 'settled'}</Label>}
                  </View>
                </View>
              </Card>
            </Pressable>
          ))}
          {!customers.length ? <Label muted>{q.isLoading ? 'Loading…' : 'No customers with bills yet'}</Label> : null}
        </>
      ) : view === 'Late payments' ? (
        <Card title="Bills unpaid for more than 30 days" tone="danger" subtitle="Tap a customer to see their full statement and record a payment">
          {(d?.late ?? []).map((l) => (
            <Pressable key={l.dispatch_id} onPress={() => setOpen(l.customer_id)}>
              <Row left={`${l.customer_name} · ${l.invoice_no}`} sub={`${dmy(l.invoice_date)} · ${l.days_old} days late · responsible: ${l.responsible}${l.phone ? ` · ${l.phone}` : ''}`}
                right={formatINR(n(l.outstanding))} />
            </Pressable>
          ))}
          {!d?.late.length ? <Label muted>No late payments 🎉</Label> : null}
        </Card>
      ) : view === 'Payments' ? (
        <Card title="Payments received" subtitle="Date, mode and who received the money">
          {(d?.payments ?? []).map((p) => (
            <Pressable key={p.id} onPress={() => setOpen(p.customer_id)}>
              <Row left={`${p.customer_name} · ${p.mode}`} sub={`${dmy(p.paid_on)} · received by ${p.received_by}${p.reference ? ` · ${p.reference}` : ''} · entered ${dateTimeIST(p.entered_at)}`}
                right={formatINR(n(p.amount))} />
            </Pressable>
          ))}
          {!d?.payments.length ? <Label muted>No payments recorded yet</Label> : null}
        </Card>
      ) : (
        <Card title="Collection responsibility by employee" subtitle="Unpaid amounts on bills each employee entered">
          {(d?.by_employee ?? []).map((e) => (
            <Row key={e.user_id} left={e.name} sub={`${e.bills} bill(s) entered · collected this month ${formatINR(n(e.collected_this_month))}${n(e.overdue) ? ` · late ${formatINR(n(e.overdue))}` : ''}`}
              right={formatINR(n(e.outstanding))} />
          ))}
          <Label muted>Right-hand amount = unpaid on bills that employee entered (they are responsible for collecting it).</Label>
        </Card>
      )}

      <StatementModal customerId={open} onClose={() => setOpen(null)} owner />
    </Screen>
  );
}

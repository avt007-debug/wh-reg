/**
 * Owner: employees, month by month — attendance (clock in / out), sales,
 * market runs per place, customers approached, and a 6-month performance trend.
 */
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { Modal, Pressable, ScrollView, Text, View } from 'react-native';
import { formatINR } from '@wh/shared';
import { rpc } from '../../src/api/client';
import { Button, Card, Chips, Empty, Field, HBar, Label, Progress, Row, Screen, SmallButton, Toolbar, pageBg } from '../../src/components/ui';
import { dateTimeIST, dmy, hoursLabel, monthLabel, monthLong, monthStart, timeIST } from '../../src/lib/dates';
import { askText, notify } from '../../src/lib/dialogs';
import { exportXlsx } from '../../src/lib/exportFile';
import { fileStamp } from '../../src/lib/warehouse';
import { useTheme } from '../../src/theme';
import { VisitRow, type Visit } from '../../src/components/VisitRow';
import { OwnerRequests, OwnerVisitPlans } from '../../src/components/OwnerRequests';

interface Stats {
  days_present: number; hours: number; missed_clock_outs: number; invoices: number; sales: number; customers_billed: number;
  purchases_entered: number; market_runs: number; places: number; customers_approached: number; orders_from_visits: number;
}
interface Emp {
  id: string; login_id: string; full_name: string; role: string; phone: string | null; is_active: boolean; removed_at: string | null;
  warehouse_name: string | null; clocked_in_since: string | null; target: number | null; stats: Stats;
}
interface Detail {
  stats: Stats;
  attendance: { id: string; work_date: string; clock_in_at: string; clock_out_at: string | null; hours: number | null; clock_in_note: string | null; clock_out_note: string | null; edited: boolean }[];
  places: { place: string; runs: number; customers: number; last: string }[];
  runs: { id: string; run_date: string; place: string; notes: string | null; visits: Visit[] }[];
  customers: Visit[];
  sales: { id: string; invoice_no: string; invoice_date: string; customer_name: string; taxable: number; total: number }[];
  trend: { month: string; stats: Stats }[];
}

const n = (x: unknown) => Number(x ?? 0);

export default function Employees() {
  const t = useTheme();
  const [back, setBack] = useState(0);
  const [open, setOpen] = useState<Emp | null>(null);
  const [showRemoved, setShowRemoved] = useState(false);
  const month = monthStart(back);
  const list = useQuery({ queryKey: ['employees-month', month], queryFn: () => rpc<Emp[]>('owner_employees_month', { p_month: month }) });
  const rows = (list.data ?? []).filter((e) => showRemoved || !e.removed_at);

  const doExport = () => exportXlsx(`Employees_${month.slice(0, 7)}_${fileStamp()}`, [{
    name: monthLong(month),
    columns: [
      { header: 'Employee', width: 22 }, { header: 'User ID', width: 14 }, { header: 'Warehouse', width: 14 },
      { header: 'Days present', kind: 'number', width: 12 }, { header: 'Hours worked', kind: 'number', width: 12 },
      { header: 'Missed clock-outs', kind: 'number', width: 15 }, { header: 'Invoices', kind: 'number', width: 9 },
      { header: 'Sales (excl. GST)', kind: 'money', width: 16 }, { header: 'Customers billed', kind: 'number', width: 15 },
      { header: 'Market runs', kind: 'number', width: 11 }, { header: 'Places', kind: 'number', width: 8 },
      { header: 'Customers approached', kind: 'number', width: 19 }, { header: 'Orders from visits', kind: 'number', width: 16 },
      { header: 'Purchases entered', kind: 'number', width: 16 },
    ],
    rows: rows.map((e) => [e.full_name, e.login_id, e.warehouse_name, n(e.stats.days_present), n(e.stats.hours), n(e.stats.missed_clock_outs),
      n(e.stats.invoices), n(e.stats.sales), n(e.stats.customers_billed), n(e.stats.market_runs), n(e.stats.places),
      n(e.stats.customers_approached), n(e.stats.orders_from_visits), n(e.stats.purchases_entered)]),
  }]).catch((e) => notify('Export failed', e instanceof Error ? e.message : String(e)));

  return (
    <Screen>
      <MonthNav month={month} back={back} setBack={setBack} />
      <Toolbar>
        <SmallButton icon="⬇" title="Export month to Excel" onPress={doExport} disabled={!rows.length} />
        {(list.data ?? []).some((e) => e.removed_at) ? (
          <SmallButton title={showRemoved ? 'Hide removed staff' : 'Show removed staff'} onPress={() => setShowRemoved((v) => !v)} />
        ) : null}
      </Toolbar>
      <OwnerRequests employees={rows.filter((e) => !e.removed_at && e.role === 'EMPLOYEE')} />
      <SalesTargets month={month} />
      <OwnerVisitPlans employees={rows.filter((e) => !e.removed_at && e.role === 'EMPLOYEE')} />
      {rows.map((e) => (
        <Pressable key={e.id} onPress={() => setOpen(e)}>
          <Card>
            <View style={{ flexDirection: 'row', gap: 8, alignItems: 'flex-start' }}>
              <View style={{ flex: 1, gap: 2 }}>
                <Text style={{ color: t.text, fontSize: 17, fontWeight: '700' }}>{e.full_name}{e.removed_at ? ' (removed)' : !e.is_active ? ' (disabled)' : ''}</Text>
                <Label muted>{e.login_id} · {e.warehouse_name ?? 'All warehouses'}</Label>
              </View>
              <Text style={{ color: e.clocked_in_since ? t.good : t.textMuted, fontWeight: '600' }}>
                {e.clocked_in_since ? `🟢 In since ${timeIST(e.clocked_in_since)}` : 'Not clocked in'}
              </Text>
            </View>
            <StatGrid s={e.stats} />
            {e.target != null ? (
              <View style={{ gap: 4 }}>
                <Label>Target {formatINR(n(e.target))} · achieved {formatINR(n(e.stats.sales))} ({Math.round((n(e.stats.sales) / n(e.target)) * 100)}%)</Label>
                <Progress value={n(e.stats.sales)} max={n(e.target)} height={8} />
              </View>
            ) : null}
            <Label muted>Tap for attendance, market runs, customers and sales →</Label>
          </Card>
        </Pressable>
      ))}
      {!rows.length ? <Label muted>{list.isLoading ? 'Loading…' : 'No employees yet — add them in Settings.'}</Label> : null}
      {open ? <EmployeeDetail emp={open} month={month} onClose={() => setOpen(null)} /> : null}
    </Screen>
  );
}

interface TargetRow { user_id: string; full_name: string; login_id: string; warehouse_name: string | null; target: number | null; note: string | null; last_month_target: number | null; achieved: number }

/** Owner sets each employee's monthly sales target and sees how much is achieved. */
function SalesTargets({ month }: { month: string }) {
  const t = useTheme();
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['sales-targets', month], queryFn: () => rpc<TargetRow[]>('owner_sales_targets', { p_month: month }) });
  const rows = q.data ?? [];
  const save = (r: TargetRow, amount: number | null, note: string | null) =>
    rpc('owner_set_sales_target', { p_user: r.user_id, p_month: month, p_target: amount, p_note: note })
      .then(() => { for (const k of ['sales-targets', 'employees-month']) void qc.invalidateQueries({ queryKey: [k] }); },
        (e) => notify('Not saved', e instanceof Error ? e.message : String(e)));
  const [editing, setEditing] = useState<TargetRow | null>(null);
  const totalTarget = rows.reduce((a, r) => a + n(r.target), 0);
  const totalAch = rows.filter((r) => r.target != null).reduce((a, r) => a + n(r.achieved), 0);
  return (
    <Card title={`Sales targets · ${monthLong(month)}`} icon="flag-outline"
      subtitle="Set a monthly target for each employee. Achieved = their posted sales bills before GST. Employees see this on their dashboard."
      right={totalTarget ? <Text style={{ color: t.textSecondary, fontWeight: '700' }}>{Math.round((totalAch / totalTarget) * 100)}% overall</Text> : null}>
      {rows.map((r) => {
        const pct = r.target ? Math.round((n(r.achieved) / n(r.target)) * 100) : null;
        return (
          <View key={r.user_id} style={{ gap: 6, paddingVertical: 10, borderBottomWidth: 0.5, borderColor: t.border }}>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
              <View style={{ flex: 1 }}>
                <Text style={{ color: t.text, fontWeight: '700' }}>{r.full_name}</Text>
                <Text style={{ color: t.textMuted, fontSize: 12.5 }}>
                  {r.target != null
                    ? `${formatINR(n(r.achieved))} of ${formatINR(n(r.target))} · ${pct}%${n(r.achieved) >= n(r.target) ? ' — achieved' : ` · ${formatINR(n(r.target) - n(r.achieved))} to go`}`
                    : `No target · sales ${formatINR(n(r.achieved))}`}
                </Text>
              </View>
              {r.target == null && r.last_month_target ? (
                <SmallButton title={`Same as last month (${formatINR(n(r.last_month_target))})`} onPress={() => void save(r, n(r.last_month_target), null)} />
              ) : null}
              <SmallButton title={r.target != null ? 'Edit' : 'Set target'} icon={r.target != null ? 'create-outline' : 'flag-outline'} kind={r.target != null ? 'secondary' : 'primary'} onPress={() => setEditing(r)} />
            </View>
            {r.target != null ? <Progress value={n(r.achieved)} max={n(r.target)} height={8} /> : null}
            {r.note ? <Text style={{ color: t.textSecondary, fontSize: 12.5 }}>Note: {r.note}</Text> : null}
          </View>
        );
      })}
      {!rows.length ? <Empty icon="people-outline" text={q.isLoading ? 'Loading…' : 'No employees yet — add them in Settings.'} /> : null}
      <TargetSheet row={editing} month={month} onClose={() => setEditing(null)} onSave={save} />
    </Card>
  );
}

/** One small form: target amount + optional note, Save / Remove target. */
function TargetSheet({ row, month, onClose, onSave }: {
  row: TargetRow | null; month: string; onClose: () => void; onSave: (r: TargetRow, amount: number | null, note: string | null) => Promise<unknown>;
}) {
  const t = useTheme();
  const [amount, setAmount] = useState('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (row) { setAmount(row.target != null ? String(n(row.target)) : row.last_month_target != null ? String(n(row.last_month_target)) : ''); setNote(row.note ?? ''); }
  }, [row]);
  if (!row) return null;
  const value = Number(amount.replace(/[₹,\s]/g, ''));
  const ok = amount.trim() !== '' && Number.isFinite(value) && value > 0;
  const go = async (a: number | null) => { setBusy(true); await onSave(row, a, a == null ? null : note.trim() || null); setBusy(false); onClose(); };
  return (
    <Modal visible transparent animationType="fade" onRequestClose={onClose}>
      <View style={{ flex: 1, backgroundColor: t.overlay, justifyContent: 'center', padding: 20 }}>
        <View style={{ backgroundColor: t.card, borderRadius: 16, padding: 18, gap: 12, width: '100%', maxWidth: 460, alignSelf: 'center', borderWidth: 1, borderColor: t.border }}>
          <Text style={{ color: t.text, fontSize: 18, fontWeight: '800' }}>Sales target · {row.full_name}</Text>
          <Label muted>{monthLong(month)} · sales so far {formatINR(n(row.achieved))} (before GST)</Label>
          <Field label="Target amount ₹ (before GST)" value={amount} onChangeText={setAmount} keyboardType="number-pad" autoFocus
            placeholder="e.g. 300000" error={amount.trim() && !ok ? 'Enter an amount like 300000' : undefined}
            onSubmitEditing={() => { if (ok) void go(value); }} />
          {ok ? <Label muted>= {formatINR(value)}</Label> : null}
          <Field label="Note for the employee (optional)" value={note} onChangeText={setNote} placeholder="e.g. Focus on new dealers in Tirupati" />
          <Button title="Save target" icon="checkmark" onPress={() => void go(value)} disabled={!ok} busy={busy} />
          {row.target != null ? <Button title="Remove target" kind="danger" onPress={() => void go(null)} disabled={busy} /> : null}
          <Button title="Cancel" kind="secondary" onPress={onClose} disabled={busy} />
        </View>
      </View>
    </Modal>
  );
}

function MonthNav({ month, back, setBack }: { month: string; back: number; setBack: (f: (b: number) => number) => void }) {
  const t = useTheme();
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
      <SmallButton title="‹ Prev" onPress={() => setBack((b) => b + 1)} />
      <Text style={{ flex: 1, textAlign: 'center', color: t.text, fontSize: 18, fontWeight: '700' }}>{monthLong(month)}</Text>
      <SmallButton title="Next ›" onPress={() => setBack((b) => Math.max(0, b - 1))} disabled={back === 0} />
    </View>
  );
}

function StatGrid({ s }: { s: Stats }) {
  const t = useTheme();
  const cells: [string, string, string?][] = [
    ['Days present', String(n(s.days_present)), n(s.missed_clock_outs) ? `${n(s.missed_clock_outs)} missed clock-out` : hoursLabel(n(s.hours))],
    ['Sales', formatINR(n(s.sales)), `${n(s.invoices)} invoice(s)`],
    ['Market runs', String(n(s.market_runs)), `${n(s.places)} place(s)`],
    ['Customers approached', String(n(s.customers_approached)), `${n(s.orders_from_visits)} order(s)`],
  ];
  return (
    <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
      {cells.map(([label, value, sub]) => (
        <View key={label} style={{ flexGrow: 1, minWidth: 140, borderWidth: 0.5, borderColor: t.border, borderRadius: 8, padding: 10 }}>
          <Text style={{ color: t.textMuted, fontSize: 12 }}>{label}</Text>
          <Text style={{ color: t.text, fontSize: 18, fontWeight: '700', fontVariant: ['tabular-nums'] }}>{value}</Text>
          {sub ? <Text style={{ color: t.textMuted, fontSize: 12 }}>{sub}</Text> : null}
        </View>
      ))}
    </View>
  );
}

function EmployeeDetail({ emp, month: initialMonth, onClose }: { emp: Emp; month: string; onClose: () => void }) {
  const t = useTheme();
  const qc = useQueryClient();
  const [back, setBack] = useState(() => {
    const now = monthStart(0);
    return (Number(now.slice(0, 4)) - Number(initialMonth.slice(0, 4))) * 12 + Number(now.slice(5, 7)) - Number(initialMonth.slice(5, 7));
  });
  const [tab, setTab] = useState<'Performance' | 'Attendance' | 'Market runs' | 'Customers' | 'Sales'>('Performance');
  const month = monthStart(back);
  const d = useQuery({ queryKey: ['employee-month', emp.id, month], queryFn: () => rpc<Detail>('owner_employee_month', { p_user: emp.id, p_month: month }) });

  const fix = async (a: Detail['attendance'][number]) => {
    const ins = await askText('Clock-in time', `${dmy(a.work_date)} — 24-hour HH:MM (now ${timeIST(a.clock_in_at)})`);
    if (ins == null) return;
    const outs = await askText('Clock-out time', `${dmy(a.work_date)} — 24-hour HH:MM (now ${a.clock_out_at ? timeIST(a.clock_out_at) : 'not clocked out'})`);
    if (outs == null) return;
    const ok = (s: string) => /^([01]?\d|2[0-3]):[0-5]\d$/.test(s.trim());
    if (!ok(ins) || !ok(outs)) return notify('Use 24-hour time like 09:15 or 18:30');
    const ts = (hm: string) => `${a.work_date}T${hm.trim().padStart(5, '0')}:00+05:30`;
    rpc('owner_fix_attendance', { p_id: a.id, p_in: ts(ins), p_out: ts(outs) })
      .then(() => { void qc.invalidateQueries({ queryKey: ['employee-month'] }); void qc.invalidateQueries({ queryKey: ['employees-month'] }); },
        (e) => notify('Not saved', e instanceof Error ? e.message : String(e)));
  };

  const data = d.data;
  const maxSales = Math.max(0, ...(data?.trend ?? []).map((m) => n(m.stats.sales)));
  return (
    <Modal visible animationType="slide" onRequestClose={onClose}>
      <ScrollView style={[{ flex: 1 }, pageBg(t)]}
        contentContainerStyle={{ padding: 16, gap: 12, paddingTop: 40, width: '100%', maxWidth: 860, alignSelf: 'center' }}>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
          <View style={{ flex: 1 }}>
            <Text style={{ color: t.text, fontSize: 20, fontWeight: '700' }}>{emp.full_name}</Text>
            <Label muted>{emp.login_id} · {emp.warehouse_name ?? 'All warehouses'}{emp.phone ? ` · ${emp.phone}` : ''}</Label>
          </View>
          <SmallButton title="Close" onPress={onClose} />
        </View>
        <MonthNav month={month} back={back} setBack={setBack} />
        {data ? <StatGrid s={data.stats} /> : <Label muted>Loading…</Label>}
        <Chips options={['Performance', 'Attendance', 'Market runs', 'Customers', 'Sales'] as const} value={tab} onChange={setTab} />

        {!data ? null : tab === 'Performance' ? (
          <Card title="Last 6 months" subtitle="Sales value entered by this employee each month">
            {[...data.trend].reverse().map((m) => (
              <View key={m.month} style={{ gap: 2, paddingBottom: 8, borderBottomWidth: 0.5, borderColor: t.border }}>
                <HBar label={monthLabel(m.month)} value={n(m.stats.sales)} max={maxSales} display={formatINR(n(m.stats.sales))}
                  sub={`${n(m.stats.days_present)} days · ${hoursLabel(n(m.stats.hours))} · ${n(m.stats.invoices)} invoices · `
                    + `${n(m.stats.market_runs)} runs to ${n(m.stats.places)} place(s) · ${n(m.stats.customers_approached)} customers (${n(m.stats.orders_from_visits)} orders)`} />
              </View>
            ))}
          </Card>
        ) : tab === 'Attendance' ? (
          <Card title={`Attendance · ${n(data.stats.days_present)} day(s) · ${hoursLabel(n(data.stats.hours))}`}>
            {data.attendance.map((a) => (
              <Row key={a.id} left={`${dmy(a.work_date)}   ${timeIST(a.clock_in_at)} → ${a.clock_out_at ? timeIST(a.clock_out_at) : '—'}`}
                sub={[a.clock_out_at ? hoursLabel(a.hours) : 'not clocked out', a.clock_in_note, a.clock_out_note, a.edited ? 'corrected by owner' : null].filter(Boolean).join(' · ')}
                right={<SmallButton title="Fix" onPress={() => void fix(a)} />} />
            ))}
            {!data.attendance.length ? <Label muted>No clock-ins this month</Label> : null}
          </Card>
        ) : tab === 'Market runs' ? (
          <>
            <Card title="Market runs per place" subtitle="How often each area was visited this month">
              {data.places.map((p) => <Row key={p.place} left={p.place} sub={`last ${dmy(p.last)} · ${p.customers} customer(s) approached`} right={`${p.runs} run(s)`} />)}
              {!data.places.length ? <Label muted>No market runs this month</Label> : null}
            </Card>
            {data.runs.map((r) => (
              <Card key={r.id}>
                <Row left={`${r.place}`} sub={`${dmy(r.run_date)}${r.notes ? ` · ${r.notes}` : ''}`} right={`${r.visits.length} customer(s)`} />
                {r.visits.map((v) => <VisitRow key={v.id} v={v} />)}
              </Card>
            ))}
          </>
        ) : tab === 'Customers' ? (
          <Card title={`Customers approached (${data.customers.length})`}>
            {data.customers.map((v) => <VisitRow key={v.id} v={v} showDate />)}
            {!data.customers.length ? <Label muted>None this month</Label> : null}
          </Card>
        ) : (
          <Card title={`Sales · ${formatINR(n(data.stats.sales))} excl. GST`}>
            {data.sales.map((s) => <Row key={s.id} left={s.invoice_no} sub={`${dmy(s.invoice_date)} · ${s.customer_name}`} right={formatINR(n(s.total))} />)}
            {!data.sales.length ? <Label muted>No sales this month</Label> : null}
          </Card>
        )}
        <Text style={{ color: t.textMuted, fontSize: 12 }}>Updated {dateTimeIST(new Date().toISOString())}</Text>
      </ScrollView>
    </Modal>
  );
}

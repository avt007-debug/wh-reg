/**
 * Daily report — the same content as the 8 pm WhatsApp summary, for any day:
 * sales (how many, value, to whom), purchases (from whom), payments received,
 * attendance (clock in / out), market runs.
 */
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { Text, View } from 'react-native';
import { formatINR } from '@wh/shared';
import { rpc } from '../../src/api/client';
import { Card, Empty, Label, Row, Screen, Section, SmallButton, Stat } from '../../src/components/ui';
import { dmy, hoursLabel, timeIST } from '../../src/lib/dates';
import { exportXlsx } from '../../src/lib/exportFile';
import { notify } from '../../src/lib/dialogs';
import { todayIST } from '../../src/lib/ids';
import { useTheme } from '../../src/theme';

interface Report {
  date: string;
  sales: { count: number; taxable: number; total: number; by_customer: { name: string; bills: number; total: number; warehouses: string }[];
           by_warehouse: { code: string; name: string; bills: number; total: number }[] };
  purchases: { count: number; total: number; pending: number; by_vendor: { name: string; bills: number; total: number; pending: number }[] };
  payments: { count: number; total: number };
  attendance: { name: string; warehouse: string | null; first_in: string | null; last_out: string | null; open: boolean; hours: number }[];
  market_runs: { name: string; places: string; runs: number; approached: number; orders: number }[];
}

const n = (x: unknown) => Number(x ?? 0);
const shift = (iso: string, days: number) => { const d = new Date(`${iso}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + days); return d.toISOString().slice(0, 10); };

export default function DailyReport() {
  const t = useTheme();
  const today = todayIST();
  const [day, setDay] = useState(today);
  const q = useQuery({ queryKey: ['daily-report', day], queryFn: () => rpc<Report>('owner_daily_report', { p_date: day }), refetchInterval: day === today ? 60_000 : false });
  const r = q.data;
  const weekday = new Date(`${day}T00:00:00Z`).toLocaleDateString('en-IN', { weekday: 'long', timeZone: 'UTC' });

  const doExport = () => r && exportXlsx(`Daily_report_${day}`, [
    { name: 'Sales', columns: [{ header: 'Customer', width: 34 }, { header: 'Bills', kind: 'number' }, { header: 'Total incl. GST', kind: 'money', width: 16 }, { header: 'Warehouse' }],
      rows: r.sales.by_customer.map((c) => [c.name, n(c.bills), n(c.total), c.warehouses]) },
    { name: 'Purchases', columns: [{ header: 'Supplier', width: 34 }, { header: 'Bills', kind: 'number' }, { header: 'Total', kind: 'money', width: 16 }, { header: 'Awaiting approval', kind: 'number' }],
      rows: r.purchases.by_vendor.map((v) => [v.name, n(v.bills), n(v.total), n(v.pending)]) },
    { name: 'Attendance', columns: [{ header: 'Employee', width: 26 }, { header: 'Warehouse' }, { header: 'Clock in' }, { header: 'Clock out' }, { header: 'Hours', kind: 'number' }],
      rows: r.attendance.map((a) => [a.name, a.warehouse, a.first_in ? timeIST(a.first_in) : 'Absent', a.open ? 'Not clocked out' : timeIST(a.last_out), n(a.hours)]) },
    { name: 'Market runs', columns: [{ header: 'Employee', width: 26 }, { header: 'Places', width: 40 }, { header: 'Customers approached', kind: 'number' }, { header: 'Orders', kind: 'number' }],
      rows: r.market_runs.map((m) => [m.name, m.places, n(m.approached), n(m.orders)]) },
  ]).catch((e) => notify('Export failed', e instanceof Error ? e.message : String(e)));

  return (
    <Screen>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
        <SmallButton title="‹ Prev" onPress={() => setDay((d) => shift(d, -1))} />
        <View style={{ flex: 1, alignItems: 'center' }}>
          <Text style={{ color: t.text, fontWeight: '800', fontSize: 16 }}>{dmy(day)}</Text>
          <Text style={{ color: t.textMuted, fontSize: 12.5 }}>{day === today ? 'Today · updates every minute' : weekday}</Text>
        </View>
        <SmallButton title="Next ›" onPress={() => setDay((d) => shift(d, 1))} disabled={day >= today} />
      </View>
      <SmallButton title="Export to Excel" icon="⬇" onPress={() => void doExport()} disabled={!r} />

      {!r ? <Empty icon="hourglass-outline" text={q.isError ? 'Could not load the report' : 'Loading…'} /> : (
        <>
          <View style={{ flexDirection: 'row', gap: 12, flexWrap: 'wrap' }}>
            <Stat label="Sales" value={formatINR(n(r.sales.total))} sub={`${n(r.sales.count)} bill(s) · incl. GST`} />
            <Stat label="Purchases" value={formatINR(n(r.purchases.total))} sub={`${n(r.purchases.count)} bill(s)${n(r.purchases.pending) ? ` · ${n(r.purchases.pending)} awaiting approval` : ''}`} />
            <Stat label="Payments collected" icon="cash-outline" value={formatINR(n(r.payments.total))} sub={`${n(r.payments.count)} payment(s)`} tone="good" />
            <Stat label="Present" icon="people-outline" value={`${r.attendance.filter((a) => a.first_in).length} / ${r.attendance.length}`} sub="employees clocked in" />
          </View>

          <Section title="Sales" hint="Who bought today" />
          <Card title={`Sales to customers (${r.sales.by_customer.length})`}>
            {r.sales.by_warehouse.length > 1 ? <Label muted>{r.sales.by_warehouse.map((w) => `${w.name}: ${n(w.bills)} bill(s) ${formatINR(n(w.total))}`).join(' · ')}</Label> : null}
            {r.sales.by_customer.map((c) => <Row key={c.name} left={c.name} sub={`${n(c.bills)} bill(s) · ${c.warehouses}`} right={formatINR(n(c.total))} />)}
            {!r.sales.by_customer.length ? <Empty icon="pricetags-outline" text="No sales on this day" /> : null}
          </Card>

          <Section title="Purchases" hint="Bought from" />
          <Card title={`Purchases from suppliers (${r.purchases.by_vendor.length})`}>
            {r.purchases.by_vendor.map((v) => <Row key={v.name} left={v.name} sub={`${n(v.bills)} bill(s)${n(v.pending) ? ' · awaiting your approval' : ''}`} right={formatINR(n(v.total))} />)}
            {!r.purchases.by_vendor.length ? <Empty icon="receipt-outline" text="No purchases on this day" /> : null}
          </Card>

          <Section title="Team" />
          <Card title="Attendance">
            {r.attendance.map((a) => (
              <Row key={a.name} left={a.name}
                sub={a.first_in ? `In ${timeIST(a.first_in)} · ${a.open ? 'not clocked out' : `out ${timeIST(a.last_out)}`}${a.warehouse ? ` · ${a.warehouse}` : ''}` : `Absent${a.warehouse ? ` · ${a.warehouse}` : ''}`}
                right={a.first_in ? hoursLabel(n(a.hours)) : <Text style={{ color: t.danger, fontWeight: '700' }}>Absent</Text>} />
            ))}
            {!r.attendance.length ? <Empty icon="people-outline" text="No employees" /> : null}
          </Card>
          <Card title="Market runs">
            {r.market_runs.map((m) => <Row key={m.name} left={m.name} sub={m.places} right={`${n(m.approached)} approached · ${n(m.orders)} orders`} />)}
            {!r.market_runs.length ? <Empty icon="map-outline" text="No market runs on this day" /> : null}
          </Card>
        </>
      )}
    </Screen>
  );
}

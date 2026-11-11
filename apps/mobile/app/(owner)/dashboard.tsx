import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { View } from 'react-native';
import { formatINR } from '@wh/shared';
import { rpc } from '../../src/api/client';
import { Card, Chips, Empty, HBar, Notice, Screen, Section, SmallButton, Stat, Toolbar } from '../../src/components/ui';
import { useRouter } from 'expo-router';
import { useAuth } from '../../src/auth/store';
import { WarehouseBars, type TrendPoint } from '../../src/components/WarehouseBars';
import { useSelectedWarehouseName, WarehouseSwitch } from '../../src/components/WarehouseSwitch';
import { todayIST } from '../../src/lib/ids';
import { useOwnerWarehouse, useWarehouses } from '../../src/lib/warehouse';
import { dateTimeIST, hoursLabel, monthLabel, monthStart, timeIST } from '../../src/lib/dates';
import { Text } from 'react-native';
import { useTheme } from '../../src/theme';

interface TopRow { product_id: string; sku_code?: string; product_name: string; units_base: number; revenue_excl_gst: number; rank_by_revenue: number }

export default function Dashboard() {
  const t = useTheme();
  const wh = useOwnerWarehouse((s) => s.id);
  const whName = useSelectedWarehouseName();
  const whs = useWarehouses();
  const [topPeriod, setTopPeriod] = useState<'This month' | 'Last 12 months'>('This month');
  const today = todayIST();
  const m0 = monthStart(0);
  const m11 = monthStart(11);

  const month = useQuery({
    queryKey: ['trend-day', m0, today, wh],
    queryFn: () => rpc<TrendPoint[]>('owner_sales_trend', { p_from: m0, p_to: today, p_granularity: 'day', p_warehouse: wh }),
  });
  const year = useQuery({
    queryKey: ['trend-month', m11, today, wh],
    queryFn: () => rpc<TrendPoint[]>('owner_sales_trend', { p_from: m11, p_to: today, p_granularity: 'month', p_warehouse: wh }),
  });
  const stock = useQuery({
    queryKey: ['stock-overview'],
    queryFn: () => rpc<{ warehouses: { warehouse_id: string; warehouse_code: string; valuation: number }[] }>('owner_stock_overview'),
  });
  const topFrom = topPeriod === 'This month' ? m0 : m11;
  const top = useQuery({
    queryKey: ['top', topFrom, today, wh],
    queryFn: () => rpc<TopRow[]>('owner_top_items', { p_from: topFrom, p_to: today, p_warehouse: wh, p_limit: 10 }),
  });
  const alerts = useQuery({ queryKey: ['reorder'], queryFn: () => rpc<{ warehouse_id: string }[]>('owner_reorder_alerts') });
  // Shares cache keys with the Purchases badge and the Ledger page.
  const pending = useQuery({ queryKey: ['pending-purchases'], queryFn: () => rpc<unknown[]>('owner_pending_purchases') });
  const ledger = useQuery({
    queryKey: ['owner-ledger'],
    queryFn: () => rpc<{ customers: { balance: number }[]; late: { customer_id: string; outstanding: number }[] }>('owner_ledger'),
  });
  const router = useRouter();
  const name = useAuth((s) => s.user?.fullName ?? '');

  const sum = (pts: TrendPoint[] | undefined, pred: (p: TrendPoint) => boolean = () => true) =>
    (pts ?? []).filter(pred).reduce((a, p) => a + Number(p.revenue_excl_gst), 0);
  const salesToday = sum(month.data, (p) => p.bucket === today);
  const salesMonth = sum(month.data);
  const valuation = (stock.data?.warehouses ?? []).filter((w) => !wh || w.warehouse_id === wh).reduce((a, w) => a + Number(w.valuation), 0);
  const toReorder = (alerts.data ?? []).filter((a) => !wh || a.warehouse_id === wh).length;

  const codes = (whs.data ?? []).filter((w) => !wh || w.id === wh).map((w) => w.code);
  const buckets = Array.from({ length: 12 }, (_, i) => monthStart(11 - i));
  const toCollect = (ledger.data?.customers ?? []).reduce((a, c) => a + Math.max(0, Number(c.balance)), 0);
  const late = ledger.data?.late ?? [];
  const lateAmt = late.reduce((a, l) => a + Number(l.outstanding), 0);
  const nPending = pending.data?.length ?? 0;
  const hour = Number(new Intl.DateTimeFormat('en-IN', { hour: 'numeric', hour12: false, timeZone: 'Asia/Kolkata' }).format(new Date()));
  const greet = hour < 12 ? 'Good morning' : hour < 17 ? 'Good afternoon' : 'Good evening';
  const lastMonth = sum(year.data, (p) => p.bucket === monthStart(1));
  const topRows = [...(top.data ?? [])].sort((a, b) => a.rank_by_revenue - b.rank_by_revenue).slice(0, 10);

  return (
    <Screen>
      <View style={{ gap: 2 }}>
        <Text style={{ color: t.text, fontSize: 20, fontWeight: '800' }}>{greet}{name ? `, ${name.split(' ')[0]}` : ''}</Text>
        <Text style={{ color: t.textMuted }}>{new Date().toLocaleDateString('en-IN', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', timeZone: 'Asia/Kolkata' })} · showing {whName}</Text>
      </View>
      <WarehouseSwitch />

      {nPending || toReorder || late.length ? <Section title="Needs your attention" /> : null}
      {nPending ? <Notice tone="warning" icon="hourglass-outline">{nPending} purchase bill(s) entered by employees are waiting for your approval. Stock is added only after you approve. </Notice> : null}
      {late.length ? <Notice tone="danger" icon="alarm-outline">{formatINR(lateAmt)} is unpaid for more than 30 days across {new Set(late.map((l) => l.customer_id)).size} customer(s).</Notice> : null}
      {toReorder ? <Notice tone="accent" icon="cart-outline">{toReorder} item(s) are at or below their reorder level.</Notice> : null}
      {nPending || toReorder || late.length ? (
        <Toolbar>
          {nPending ? <SmallButton title="Review purchases" icon="hourglass-outline" onPress={() => router.navigate('/purchases')} /> : null}
          {late.length ? <SmallButton title="Open ledger" icon="book-outline" onPress={() => router.navigate('/ledger')} /> : null}
          {toReorder ? <SmallButton title="See reorder list" icon="cart-outline" onPress={() => router.navigate('/reorder')} /> : null}
        </Toolbar>
      ) : null}

      <Section title="Sales" hint="Amounts before GST" />
      <View style={{ flexDirection: 'row', gap: 12, flexWrap: 'wrap' }}>
        <Stat label="Sales today" value={formatINR(salesToday)} sub="excl. GST" />
        <Stat label={`Sales in ${monthLabel(m0)}`} value={formatINR(salesMonth)}
          sub={lastMonth ? `${monthLabel(monthStart(1))}: ${formatINR(lastMonth)}` : 'excl. GST'} />
        <Stat label="Stock value" value={formatINR(valuation)} sub={`at cost · ${toReorder} to reorder`} />
      </View>
      <Section title="Money" hint="All warehouses" />
      <View style={{ flexDirection: 'row', gap: 12, flexWrap: 'wrap' }}>
        <Stat label="To collect from customers" value={formatINR(toCollect)} sub={`${(ledger.data?.customers ?? []).filter((c) => Number(c.balance) > 0).length} customer(s) owe money`} />
        <Stat label="Late (over 30 days)" value={formatINR(lateAmt)} tone={late.length ? 'danger' : 'good'} sub={late.length ? `${late.length} bill(s)` : 'Nothing late'} />
        <Stat label="Purchases awaiting approval" icon="hourglass-outline" value={String(nPending)} tone={nPending ? 'warning' : 'good'} sub={nPending ? 'Tap Purchases to review' : 'All approved'} />
      </View>

      <Section title="Trends & team" />
      <Card title={`Sales per month · ${whName}`} subtitle="Last 12 months, excluding GST — table below the chart">
        <WarehouseBars points={year.data ?? []} warehouses={codes} buckets={buckets} formatBucket={monthLabel} formatAxis={(b) => monthLabel(b).slice(0, 3)}
          colorCodes={(whs.data ?? []).map((w) => w.code)}
          names={Object.fromEntries((whs.data ?? []).map((w) => [w.code, w.name]))} />
      </Card>

      <TodayAttendance />

      <Card title={`Top sellers by revenue · ${whName}`} subtitle="Ranked by sales value before GST">
        <Chips options={['This month', 'Last 12 months'] as const} value={topPeriod} onChange={setTopPeriod} />
        {topRows.map((r, _i, all) => (
          <HBar key={r.product_id} label={`#${r.rank_by_revenue} ${r.product_name}`} value={Number(r.revenue_excl_gst)}
            max={Number(all[0]?.revenue_excl_gst ?? 0)} display={formatINR(Number(r.revenue_excl_gst))}
            sub={`${r.sku_code ? `${r.sku_code} · ` : ''}${r.units_base} units sold`} />
        ))}
        {!topRows.length ? <Empty icon="trophy-outline" text={top.isLoading ? 'Loading…' : 'No sales in this period yet'} /> : null}
      </Card>
    </Screen>
  );
}

interface TodayRow { id: string; full_name: string; login_id: string; warehouse_name: string | null; first_in: string | null; last_out: string | null; open_since: string | null; shifts: number; hours: number }

/** Today's clock-in / clock-out for every employee in the selected warehouse. */
function TodayAttendance() {
  const t = useTheme();
  const wh = useOwnerWarehouse((s) => s.id);
  const q = useQuery({ queryKey: ['attendance-today', wh], queryFn: () => rpc<TodayRow[]>('owner_attendance_today', { p_warehouse: wh }), refetchInterval: 60_000 });
  const rows = q.data ?? [];
  const inNow = rows.filter((r) => r.open_since).length;
  return (
    <Card title={`Today's attendance · ${inNow} of ${rows.length} clocked in`} subtitle="Refreshes every minute">
      {rows.map((r) => {
        const status = r.open_since ? '● In now' : r.first_in ? '○ Left' : '✕ Not in yet';
        const startedEarlier = !!r.first_in && new Date(new Date(r.first_in).getTime() + 5.5 * 3600_000).toISOString().slice(0, 10) !== todayIST();
        return (
          <View key={r.id} style={{ flexDirection: 'row', alignItems: 'center', gap: 8, paddingVertical: 8, borderBottomWidth: 0.5, borderColor: t.border }}>
            <View style={{ flex: 1, gap: 2 }}>
              <Text style={{ color: t.text, fontWeight: '600' }}>{r.full_name}</Text>
              <Text style={{ color: t.textMuted, fontSize: 12 }}>{r.warehouse_name ?? 'All warehouses'}{Number(r.shifts) > 1 ? ` · ${r.shifts} shifts` : ''}</Text>
            </View>
            <View style={{ alignItems: 'flex-end', gap: 2 }}>
              <Text style={{ color: t.text, fontVariant: ['tabular-nums'] }}>
                {r.first_in ? `In ${startedEarlier ? dateTimeIST(r.first_in) : timeIST(r.first_in)}` : '—'}
                {'  ·  '}{r.open_since ? 'still in' : r.last_out ? `Out ${timeIST(r.last_out)}` : '—'}
              </Text>
              <Text style={{ color: r.open_since ? t.good : r.first_in ? t.textMuted : t.danger, fontSize: 12, fontWeight: '600' }}>
                {status}{r.first_in ? ` · ${hoursLabel(Number(r.hours))}` : ''}
              </Text>
            </View>
          </View>
        );
      })}
      {!rows.length ? <Empty icon="people-outline" text={q.isLoading ? 'Loading…' : 'No employees in this warehouse'} /> : null}
    </Card>
  );
}

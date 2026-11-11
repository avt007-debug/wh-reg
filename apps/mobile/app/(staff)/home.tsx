/**
 * Employee dashboard: today's clock in / out, this month's sales target and how much
 * is achieved, a basic summary (sales, bills, payments, field work), and the full
 * month's attendance — one row per day with clock-in and clock-out times.
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { Text, View } from 'react-native';
import { formatINR } from '@wh/shared';
import { rpc } from '../../src/api/client';
import { Button, Card, Empty, Label, Notice, Progress, Screen, Section, SmallButton, Stat } from '../../src/components/ui';
import { dmy, hoursLabel, monthLong, monthStart, timeIST } from '../../src/lib/dates';
import { notify } from '../../src/lib/dialogs';
import { todayIST } from '../../src/lib/ids';
import { useTheme } from '../../src/theme';

interface Shift { id: string; work_date: string; clock_in_at: string; clock_out_at: string | null; hours: number | null }
interface Day { date: string; first_in: string | null; last_out: string | null; shifts: number; open: boolean; hours: number }
interface Stats {
  days_present: number; hours: number; missed_clock_outs: number; invoices: number; sales: number; customers_billed: number;
  purchases_entered: number; market_runs: number; places: number; customers_approached: number; orders_from_visits: number;
}
interface Dash {
  me: { full_name: string; login_id: string; warehouse_name: string | null };
  month: string; today: string;
  open_shift: Shift | null; today_shifts: Shift[]; days: Day[]; stats: Stats;
  target: number | null; target_note: string | null; achieved: number; days_left: number;
  sales_today: number; bills_today: number; collected_month: number; to_collect: number; overdue: number;
  recent_bills: { invoice_no: string; invoice_date: string; customer_name: string; taxable: number; total: number }[];
}

const n = (x: unknown) => Number(x ?? 0);
const WEEKDAY = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const weekday = (iso: string) => WEEKDAY[new Date(`${iso}T00:00:00Z`).getUTCDay()]!;

export default function Home() {
  const t = useTheme();
  const qc = useQueryClient();
  const [back, setBack] = useState(0);
  const month = monthStart(back);
  const thisMonth = useQuery({ queryKey: ['my-dashboard', monthStart(0)], queryFn: () => rpc<Dash>('my_dashboard', { p_month: monthStart(0) }), refetchInterval: 60_000 });
  const viewed = useQuery({ queryKey: ['my-dashboard', month], queryFn: () => rpc<Dash>('my_dashboard', { p_month: month }), enabled: back > 0 });
  const d = thisMonth.data;
  const m = back > 0 ? viewed.data : d;

  // re-render every 30 s so "working for" keeps counting
  const [, tick] = useState(0);
  useEffect(() => { const id = setInterval(() => tick((x) => x + 1), 30_000); return () => clearInterval(id); }, []);

  const refresh = () => { void qc.invalidateQueries({ queryKey: ['my-dashboard'] }); void qc.invalidateQueries({ queryKey: ['my-attendance'] }); };
  const fail = (e: unknown) => notify('Not saved', e instanceof Error ? e.message : String(e));
  const clockIn = useMutation({ mutationFn: () => rpc<Shift>('clock_in'), onSuccess: (s) => { refresh(); notify('Clocked in', `at ${timeIST(s.clock_in_at)}`); }, onError: fail });
  const clockOut = useMutation({ mutationFn: () => rpc<Shift>('clock_out'), onSuccess: (s) => { refresh(); notify('Clocked out', `at ${timeIST(s.clock_out_at)}`); }, onError: fail });

  if (thisMonth.isLoading) return <Screen><Empty icon="hourglass-outline" text="Loading your dashboard…" /></Screen>;
  if (!d) return <Screen><Notice tone="danger">Could not load your dashboard. Check your internet and pull to refresh.</Notice></Screen>;

  const open = d.open_shift;
  const todayShifts = [...d.today_shifts].sort((a, b) => a.clock_in_at.localeCompare(b.clock_in_at));
  const firstIn = todayShifts[0]?.clock_in_at ?? null;
  const lastOut = !open ? todayShifts.at(-1)?.clock_out_at ?? null : null;
  const workedToday = todayShifts.reduce((a, s) => a + (s.clock_out_at ? n(s.hours) : (Date.now() - new Date(s.clock_in_at).getTime()) / 3600_000), 0);
  const hour = Number(new Intl.DateTimeFormat('en-IN', { hour: 'numeric', hour12: false, timeZone: 'Asia/Kolkata' }).format(new Date()));
  const greet = hour < 12 ? 'Good morning' : hour < 17 ? 'Good afternoon' : 'Good evening';

  const target = d.target != null ? n(d.target) : null;
  const achieved = n(d.achieved);
  const remaining = target != null ? Math.max(0, target - achieved) : 0;
  const pct = target ? Math.round((achieved / target) * 100) : 0;
  const perDay = d.days_left > 0 ? remaining / d.days_left : remaining;

  return (
    <Screen>
      <View style={{ gap: 2 }}>
        <Text style={{ color: t.text, fontSize: 20, fontWeight: '800' }}>{greet}, {d.me.full_name.split(' ')[0]}</Text>
        <Text style={{ color: t.textMuted }}>
          {new Date().toLocaleDateString('en-IN', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', timeZone: 'Asia/Kolkata' })}
          {d.me.warehouse_name ? ` · ${d.me.warehouse_name}` : ''}
        </Text>
      </View>

      {/* ---------------- Today */}
      <Card title="Today" icon="time-outline" tone={open ? 'good' : firstIn ? undefined : 'warning'}
        subtitle={open ? 'You are clocked in' : firstIn ? 'You have clocked out' : 'You have not clocked in yet'}>
        <View style={{ flexDirection: 'row', gap: 10, flexWrap: 'wrap' }}>
          <TimeBox label="Clock in" value={timeIST(firstIn)} />
          <TimeBox label="Clock out" value={open ? 'Still in' : timeIST(lastOut)} />
          <TimeBox label={open ? 'Working for' : 'Worked today'} value={firstIn ? hoursLabel(workedToday) : '—'} />
        </View>
        {todayShifts.length > 1 ? (
          <Label muted>Shifts today: {todayShifts.map((s) => `${timeIST(s.clock_in_at)}–${s.clock_out_at ? timeIST(s.clock_out_at) : 'now'}`).join(', ')}</Label>
        ) : null}
        {open && open.work_date !== todayIST() ? <Notice tone="warning">You clocked in on {dmy(open.work_date)} and never clocked out. Clock out now and ask the owner to correct the time.</Notice> : null}
        {open
          ? <Button title="Clock out" icon="log-out-outline" kind="danger" onPress={() => clockOut.mutate()} busy={clockOut.isPending} />
          : <Button title={firstIn ? 'Clock in again' : 'Clock in'} icon="log-in-outline" onPress={() => clockIn.mutate()} busy={clockIn.isPending} />}
      </Card>

      {/* ---------------- Target */}
      <Card title={`Sales target · ${monthLong(d.month)}`} icon="flag-outline" tone={target != null && achieved >= target ? 'good' : 'accent'}
        subtitle="Your posted sales bills this month, before GST">
        {target == null ? (
          <>
            <Empty icon="flag-outline" text="The owner has not set a target for you this month." />
            <Label muted>Sales so far: {formatINR(achieved)}</Label>
          </>
        ) : (
          <>
            <View style={{ flexDirection: 'row', alignItems: 'flex-end', justifyContent: 'space-between', gap: 8, flexWrap: 'wrap' }}>
              <View>
                <Text style={{ color: t.textMuted, fontSize: 12.5 }}>Achieved</Text>
                <Text style={{ color: t.text, fontSize: 26, fontWeight: '800', fontVariant: ['tabular-nums'] }}>{formatINR(achieved)}</Text>
              </View>
              <View style={{ alignItems: 'flex-end' }}>
                <Text style={{ color: t.textMuted, fontSize: 12.5 }}>Target</Text>
                <Text style={{ color: t.textSecondary, fontSize: 18, fontWeight: '700', fontVariant: ['tabular-nums'] }}>{formatINR(target)}</Text>
              </View>
            </View>
            <Progress value={achieved} max={target} />
            <Text style={{ color: achieved >= target ? t.good : t.text, fontWeight: '700' }}>
              {achieved >= target
                ? `Target achieved — ${pct}%${achieved > target ? ` (${formatINR(achieved - target)} above target)` : ''}`
                : `${pct}% done · ${formatINR(remaining)} to go`}
            </Text>
            {achieved < target ? (
              <Label muted>{d.days_left} day(s) left this month{d.days_left > 0 ? ` · about ${formatINR(perDay)} per day needed` : ''}</Label>
            ) : null}
            {d.target_note ? <Notice icon="chatbubble-ellipses-outline">Owner's note: {d.target_note}</Notice> : null}
          </>
        )}
      </Card>

      {/* ---------------- Summary */}
      <Section title="This month at a glance" />
      <View style={{ flexDirection: 'row', gap: 12, flexWrap: 'wrap' }}>
        <Stat label="Sales today" value={formatINR(n(d.sales_today))} sub={`${n(d.bills_today)} bill(s) · excl. GST`} />
        <Stat label="Bills this month" icon="document-text-outline" value={String(n(d.stats.invoices))} sub={`${n(d.stats.customers_billed)} customer(s) billed`} />
        <Stat label="Payments I collected" icon="cash-outline" value={formatINR(n(d.collected_month))} sub="this month" tone="good" />
        <Stat label="Still to collect" value={formatINR(n(d.to_collect))} tone={n(d.overdue) > 0 ? 'danger' : undefined}
          sub={n(d.overdue) > 0 ? `${formatINR(n(d.overdue))} late (over 30 days)` : 'on bills you entered'} />
        <Stat label="Days present" icon="calendar-outline" value={String(n(d.stats.days_present))}
          sub={`${hoursLabel(n(d.stats.hours))} worked${n(d.stats.missed_clock_outs) ? ` · ${n(d.stats.missed_clock_outs)} missed clock-out` : ''}`} />
        <Stat label="Market runs" icon="map-outline" value={String(n(d.stats.market_runs))}
          sub={`${n(d.stats.customers_approached)} customer(s) approached · ${n(d.stats.orders_from_visits)} order(s)`} />
      </View>

      {/* ---------------- Monthly attendance */}
      <Card title={`Attendance · ${monthLong(month)}`} icon="calendar-outline" subtitle="Every day of the month with your clock-in and clock-out times">
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
          <SmallButton title="‹ Prev" onPress={() => setBack((b) => b + 1)} />
          <Text style={{ flex: 1, textAlign: 'center', color: t.text, fontWeight: '700' }}>{monthLong(month)}</Text>
          <SmallButton title="Next ›" onPress={() => setBack((b) => Math.max(0, b - 1))} disabled={back === 0} />
        </View>
        {m ? (
          <>
            <Label muted>
              {n(m.stats.days_present)} day(s) present · {hoursLabel(n(m.stats.hours))} worked
              {n(m.stats.missed_clock_outs) ? ` · ${n(m.stats.missed_clock_outs)} missed clock-out(s)` : ''}
            </Label>
            <AttendanceTable days={m.days} today={d.today} />
          </>
        ) : <Empty icon="hourglass-outline" text="Loading…" />}
      </Card>

      {/* ---------------- Recent bills */}
      <Card title="My latest bills" icon="document-text-outline" subtitle="Last 5 sales bills you entered this month">
        {d.recent_bills.map((b) => (
          <View key={b.invoice_no} style={{ flexDirection: 'row', gap: 8, paddingVertical: 8, borderBottomWidth: 0.5, borderColor: t.border }}>
            <View style={{ flex: 1 }}>
              <Text style={{ color: t.text, fontWeight: '600' }}>{b.customer_name}</Text>
              <Text style={{ color: t.textMuted, fontSize: 12.5 }}>{b.invoice_no} · {dmy(b.invoice_date)}</Text>
            </View>
            <Text style={{ color: t.text, fontWeight: '700', fontVariant: ['tabular-nums'] }}>{formatINR(n(b.total))}</Text>
          </View>
        ))}
        {!d.recent_bills.length ? <Empty icon="document-text-outline" text="No bills yet this month" /> : null}
      </Card>
    </Screen>
  );
}

function TimeBox({ label, value }: { label: string; value: string }) {
  const t = useTheme();
  return (
    <View style={{ flex: 1, minWidth: 96, backgroundColor: t.cardAlt, borderRadius: 10, padding: 10, gap: 2 }}>
      <Text style={{ color: t.textMuted, fontSize: 12 }}>{label}</Text>
      <Text style={{ color: t.text, fontSize: 17, fontWeight: '800', fontVariant: ['tabular-nums'] }}>{value}</Text>
    </View>
  );
}

function AttendanceTable({ days, today }: { days: Day[]; today: string }) {
  const t = useTheme();
  const cell = { flex: 1, color: t.text, fontVariant: ['tabular-nums' as const], fontSize: 13.5 };
  return (
    <View>
      <View style={{ flexDirection: 'row', paddingVertical: 8, paddingHorizontal: 8, backgroundColor: t.cardAlt, borderRadius: 8 }}>
        {['Date', 'In', 'Out', 'Hours'].map((h, i) => (
          <Text key={h} style={{ ...cell, flex: i === 0 ? 1.3 : 1, color: t.textMuted, fontWeight: '700', fontSize: 12, textAlign: i === 3 ? 'right' : 'left' }}>{h}</Text>
        ))}
      </View>
      {days.map((day) => {
        const sunday = weekday(day.date) === 'Sun';
        const absent = !day.first_in;
        const isToday = day.date === today;
        const status = absent ? (isToday ? 'Not yet' : sunday ? 'Sunday' : 'Absent') : null;
        return (
          <View key={day.date} style={{ flexDirection: 'row', alignItems: 'center', paddingVertical: 9, paddingHorizontal: 8, borderBottomWidth: 0.5, borderColor: t.border,
            backgroundColor: isToday ? t.accentSoft : 'transparent', borderRadius: isToday ? 8 : 0 }}>
            <Text style={{ ...cell, flex: 1.3, fontWeight: '600' }}>{dmy(day.date).slice(0, 5)} <Text style={{ color: t.textMuted, fontWeight: '400' }}>{weekday(day.date)}</Text></Text>
            {status ? (
              <Text style={{ ...cell, flex: 3, color: status === 'Absent' ? t.danger : t.textMuted, fontWeight: '600' }}>{status}</Text>
            ) : (
              <>
                <Text style={cell}>{timeIST(day.first_in)}</Text>
                <Text style={{ ...cell, color: day.open ? (isToday ? t.good : t.warning) : t.text }}>
                  {day.open ? (isToday ? 'Still in' : 'Missed') : timeIST(day.last_out)}
                </Text>
                <Text style={{ ...cell, textAlign: 'right', fontWeight: '700' }}>{hoursLabel(n(day.hours))}{day.shifts > 1 ? ` ×${day.shifts}` : ''}</Text>
              </>
            )}
          </View>
        );
      })}
      {!days.length ? <Empty icon="calendar-outline" text="No days to show" /> : null}
    </View>
  );
}

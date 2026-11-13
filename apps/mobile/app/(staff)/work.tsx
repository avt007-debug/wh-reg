/**
 * Employee: clock in / clock out, log market runs (place visited + customers
 * approached), and see this month's attendance and field work.
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { Text, View } from 'react-native';
import * as ImagePicker from 'expo-image-picker';
import { rpc, uploadFieldPhoto } from '../../src/api/client';
import { useAuth } from '../../src/auth/store';
import { currentPosition } from '../../src/lib/location';
import { Button, Card, Chips, Field, Label, Row, Screen, SmallButton, Toolbar } from '../../src/components/ui';
import { OUTCOME, OUTCOMES, VisitRow, type Visit } from '../../src/components/VisitRow';
import { dmy, hoursLabel, monthLong, timeIST } from '../../src/lib/dates';
import { confirmAsk, notify } from '../../src/lib/dialogs';
import { todayIST } from '../../src/lib/ids';
import { useTheme } from '../../src/theme';

interface Shift { id: string; work_date: string; clock_in_at: string; clock_out_at: string | null; hours?: number | null }
interface Run { id: string; run_date: string; place: string; notes: string | null; created_at: string; visits: Visit[] }
interface CustomerDraft { customerName: string; shopName: string; phone: string; outcome: (typeof OUTCOMES)[number]; notes: string }
const blankCustomer = (): CustomerDraft => ({ customerName: '', shopName: '', phone: '', outcome: 'FOLLOW_UP', notes: '' });
const fail = (e: unknown) => notify('Not saved', e instanceof Error ? e.message : String(e));

export default function Work() {
  return (
    <Screen>
      <ClockCard />
      <MarketRunForm />
      <SingleCustomerForm />
      <MyMonth />
    </Screen>
  );
}

function ClockCard() {
  const t = useTheme();
  const qc = useQueryClient();
  const att = useQuery({ queryKey: ['my-attendance'], queryFn: () => rpc<{ open: Shift | null; days: Shift[] }>('my_attendance'), refetchInterval: 60_000 });
  const [note, setNote] = useState('');
  const [, tick] = useState(0);
  useEffect(() => { const id = setInterval(() => tick((x) => x + 1), 30_000); return () => clearInterval(id); }, []);
  const done = () => { setNote(''); void qc.invalidateQueries({ queryKey: ['my-attendance'] }); void qc.invalidateQueries({ queryKey: ['my-dashboard'] }); };
  const clockIn = useMutation({ mutationFn: () => rpc<Shift>('clock_in', { p_note: note || null }), onSuccess: (s) => { done(); notify('Clocked in', `at ${timeIST(s.clock_in_at)}`); }, onError: fail });
  const clockOut = useMutation({ mutationFn: () => rpc<Shift>('clock_out', { p_note: note || null }), onSuccess: (s) => { done(); notify('Clocked out', `at ${timeIST(s.clock_out_at)}`); }, onError: fail });

  const open = att.data?.open;
  const worked = open ? (Date.now() - new Date(open.clock_in_at).getTime()) / 3600_000 : 0;
  const today = (att.data?.days ?? []).filter((d) => d.work_date === todayIST() && d.clock_out_at);
  return (
    <Card title="Attendance">
      {att.isLoading ? <Label muted>Loading…</Label> : open ? (
        <>
          <Text style={{ color: t.good, fontSize: 18, fontWeight: '700' }}>🟢 Clocked in since {timeIST(open.clock_in_at)}</Text>
          <Label muted>{open.work_date !== todayIST() ? `Started on ${dmy(open.work_date)} — please clock out. ` : ''}Working {hoursLabel(worked)}</Label>
          <Field label="Note (optional)" value={note} onChangeText={setNote} placeholder="e.g. leaving for market run" />
          <Button title="Clock out" kind="danger" onPress={() => clockOut.mutate()} busy={clockOut.isPending} />
        </>
      ) : (
        <>
          <Text style={{ color: t.textSecondary, fontSize: 16 }}>You are not clocked in.</Text>
          {today.length ? <Label muted>Today: {today.map((d) => `${timeIST(d.clock_in_at)}–${timeIST(d.clock_out_at)}`).join(', ')}</Label> : null}
          <Field label="Note (optional)" value={note} onChangeText={setNote} placeholder="e.g. late — bus delay" />
          <Button title="Clock in" onPress={() => clockIn.mutate()} busy={clockIn.isPending} />
        </>
      )}
    </Card>
  );
}

function CustomerFields({ c, onChange, onRemove, index }: { c: CustomerDraft; onChange: (c: CustomerDraft) => void; onRemove?: () => void; index?: number }) {
  const t = useTheme();
  return (
    <View style={{ gap: 8, borderWidth: 0.5, borderColor: t.border, borderRadius: 10, padding: 10 }}>
      <View style={{ flexDirection: 'row', alignItems: 'center' }}>
        <Text style={{ flex: 1, color: t.text, fontWeight: '600' }}>{index != null ? `Customer ${index + 1}` : 'Customer'}</Text>
        {onRemove ? <SmallButton title="✕" kind="danger" onPress={onRemove} /> : null}
      </View>
      <Field label="Customer name" value={c.customerName} onChangeText={(v) => onChange({ ...c, customerName: v })} placeholder="e.g. Ramesh" />
      <View style={{ flexDirection: 'row', gap: 8 }}>
        <Field label="Shop (optional)" value={c.shopName} onChangeText={(v) => onChange({ ...c, shopName: v })} placeholder="e.g. Sri Lakshmi Hardware" />
        <Field label="Phone (optional)" value={c.phone} keyboardType="phone-pad" onChangeText={(v) => onChange({ ...c, phone: v })} />
      </View>
      <Chips options={OUTCOMES} value={c.outcome} onChange={(v) => onChange({ ...c, outcome: v })} format={(v) => OUTCOME[v] ?? v} />
      <Field label="Notes (optional)" value={c.notes} onChangeText={(v) => onChange({ ...c, notes: v })} placeholder="what they need, when to call back…" />
    </View>
  );
}

function MarketRunForm() {
  const qc = useQueryClient();
  const month = useQuery({ queryKey: ['my-field'], queryFn: () => rpc<{ runs: Run[]; loose_visits: Visit[] }>('my_field_month') });
  const [place, setPlace] = useState('');
  const [notes, setNotes] = useState('');
  const [customers, setCustomers] = useState<CustomerDraft[]>([]);
  const [photo, setPhoto] = useState<string | null>(null);
  const uid = useAuth((s) => s.user?.id);
  const recent = [...new Set((month.data?.runs ?? []).map((r) => r.place))].slice(0, 8);
  const takePhoto = async () => {
    await ImagePicker.requestCameraPermissionsAsync();
    const r = await ImagePicker.launchCameraAsync({ quality: 0.5, mediaTypes: ['images'] });
    if (!r.canceled && r.assets[0]) setPhoto(r.assets[0].uri);
  };

  const save = useMutation({
    mutationFn: async () => {
      const pos = currentPosition();          // ask for location while saving
      const run = await rpc<Run>('log_market_run', { p: { place: place.trim(), notes: notes.trim() || null, visits: customers.filter((c) => c.customerName.trim()) } });
      const [p, key] = await Promise.all([pos, photo && uid ? uploadFieldPhoto(uid, photo, 'run').catch(() => null) : Promise.resolve(null)]);
      if (p || key) await rpc('set_field_location', { p_kind: 'run', p_id: run.id, p_lat: p?.lat ?? null, p_lng: p?.lng ?? null, p_accuracy: p?.accuracy ?? null, p_photo: key }).catch(() => undefined);
      return { ...run, located: !!p, photo: !!key };
    },
    onSuccess: (r) => {
      notify('Market run saved', `${r.place} · ${r.visits.length} customer(s)${r.located ? ' · location saved' : ''}${r.photo ? ' · photo saved' : ''}`);
      setPlace(''); setNotes(''); setCustomers([]); setPhoto(null);
      void qc.invalidateQueries({ queryKey: ['my-field'] });
    },
    onError: fail,
  });
  const bad = customers.some((c) => c.customerName.trim().length > 0 && c.customerName.trim().length < 2);
  return (
    <Card title="Log a market run">
      <Field label="Place visited" value={place} onChangeText={setPlace} placeholder="e.g. Puttur" />
      {recent.length ? <Chips options={recent} value={null} onChange={setPlace} /> : null}
      <Field label="Notes (optional)" value={notes} onChangeText={setNotes} placeholder="e.g. weekly round, new shops on main road" />
      {customers.map((c, i) => (
        <CustomerFields key={i} index={i} c={c} onChange={(v) => setCustomers((cs) => cs.map((x, j) => (j === i ? v : x)))}
          onRemove={() => setCustomers((cs) => cs.filter((_, j) => j !== i))} />
      ))}
      <SmallButton title="＋ Add customer approached" onPress={() => setCustomers((cs) => [...cs, blankCustomer()])} />
      <SmallButton icon="camera-outline" title={photo ? '✓ Photo taken — retake' : 'Photo of the market / shop (optional)'} onPress={() => void takePhoto()} />
      <Label muted>Your location is saved with the run (allow location when asked).</Label>
      <Button title="Save market run" onPress={() => save.mutate()} busy={save.isPending} disabled={place.trim().length < 2 || bad} />
    </Card>
  );
}

function SingleCustomerForm() {
  const qc = useQueryClient();
  const [c, setC] = useState<CustomerDraft>(blankCustomer());
  const [place, setPlace] = useState('');
  const [openForm, setOpenForm] = useState(false);
  const save = useMutation({
    mutationFn: () => rpc('add_customer_visit', { p: { ...c, place: place.trim() || null } }),
    onSuccess: () => { notify('Customer saved'); setC(blankCustomer()); setPlace(''); setOpenForm(false); void qc.invalidateQueries({ queryKey: ['my-field'] }); },
    onError: fail,
  });
  return (
    <Card title="Customer approached (not on a market run)">
      {!openForm ? <SmallButton title="＋ Add a customer" onPress={() => setOpenForm(true)} /> : (
        <>
          <CustomerFields c={c} onChange={setC} />
          <Field label="Place (optional)" value={place} onChangeText={setPlace} placeholder="e.g. at the shop counter" />
          <Toolbar>
            <SmallButton title="Save customer" kind="primary" onPress={() => save.mutate()} disabled={save.isPending || c.customerName.trim().length < 2} />
            <SmallButton title="Cancel" onPress={() => setOpenForm(false)} />
          </Toolbar>
        </>
      )}
    </Card>
  );
}

function MyMonth() {
  const t = useTheme();
  const qc = useQueryClient();
  const att = useQuery({ queryKey: ['my-attendance'], queryFn: () => rpc<{ open: Shift | null; days: Shift[] }>('my_attendance') });
  const field = useQuery({ queryKey: ['my-field'], queryFn: () => rpc<{ runs: Run[]; loose_visits: Visit[] }>('my_field_month') });
  const runs = field.data?.runs ?? [];
  const byPlace = new Map<string, number>();
  runs.forEach((r) => { const k = r.place.trim().toLowerCase(); byPlace.set(k, (byPlace.get(k) ?? 0) + 1); });
  const nameOf = (k: string) => runs.find((r) => r.place.trim().toLowerCase() === k)?.place ?? k;
  const days = new Set((att.data?.days ?? []).map((d) => d.work_date)).size;
  const customers = runs.reduce((a, r) => a + r.visits.length, 0) + (field.data?.loose_visits.length ?? 0);
  const del = async (kind: 'run' | 'visit', id: string, what: string) => {
    if (await confirmAsk(`Delete ${what}?`, 'Only entries made today can be deleted.', 'Delete')) {
      rpc('delete_my_field_entry', { p_kind: kind, p_id: id }).then(() => void qc.invalidateQueries({ queryKey: ['my-field'] }), fail);
    }
  };
  const isToday = (ts?: string) => !!ts && new Date(new Date(ts).getTime() + 5.5 * 3600_000).toISOString().slice(0, 10) === todayIST();

  return (
    <>
      <Card title={`My ${monthLong(todayIST())}`}>
        <Row left="Days present" right={String(days)} />
        <Row left="Market runs" right={String(runs.length)} sub={[...byPlace.entries()].map(([k, v]) => `${nameOf(k)} ×${v}`).join(' · ') || undefined} />
        <Row left="Customers approached" right={String(customers)} />
      </Card>
      <Card title="My attendance this month">
        {(att.data?.days ?? []).map((d) => (
          <Row key={d.id} left={dmy(d.work_date)} right={d.clock_out_at ? hoursLabel(d.hours) : '—'}
            sub={`${timeIST(d.clock_in_at)} → ${d.clock_out_at ? timeIST(d.clock_out_at) : 'still clocked in'}`} />
        ))}
        {!att.data?.days.length ? <Label muted>No clock-ins yet this month</Label> : null}
      </Card>
      <Card title="My market runs this month">
        {runs.map((r) => (
          <View key={r.id} style={{ gap: 4, paddingBottom: 8, borderBottomWidth: 0.5, borderColor: t.border }}>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
              <Text style={{ flex: 1, color: t.text, fontWeight: '700' }}>{r.place} · {dmy(r.run_date)}</Text>
              {isToday(r.created_at) ? <SmallButton title="Delete" kind="danger" onPress={() => void del('run', r.id, `the run to ${r.place}`)} /> : null}
            </View>
            {r.notes ? <Label muted>{r.notes}</Label> : null}
            {r.visits.map((v) => <VisitRow key={v.id} v={v} />)}
          </View>
        ))}
        {(field.data?.loose_visits ?? []).length ? <Label>Other customers approached</Label> : null}
        {(field.data?.loose_visits ?? []).map((v) => (
          <View key={v.id} style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
            <View style={{ flex: 1 }}><VisitRow v={v} showDate /></View>
            {isToday(v.created_at) ? <SmallButton title="Delete" kind="danger" onPress={() => void del('visit', v.id, v.customer_name)} /> : null}
          </View>
        ))}
        {!runs.length && !field.data?.loose_visits.length ? <Label muted>{field.isLoading ? 'Loading…' : 'Nothing logged yet this month'}</Label> : null}
      </Card>
    </>
  );
}

/** Owner: employees' leave and clock-time correction requests (approve / reject), add leave, and visit plans. */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Linking, Text, View } from 'react-native';
import { rpc } from '../api/client';
import type { Party } from '../api/types';
import { dmy, timeIST } from '../lib/dates';
import { askText, notify } from '../lib/dialogs';
import { todayIST } from '../lib/ids';
import { useTheme } from '../theme';
import { PartyPicker } from './PartyPicker';
import { Sheet } from './Sheet';
import { Button, Card, Chips, Field, Label, Row, SmallButton, Toolbar } from './ui';

interface Leave { id: string; user_id: string; employee: string; date: string; reason: string | null; status: string; owner_note: string | null }
interface Fix { id: string; employee: string; date: string; want_in: string | null; want_out: string | null; reason: string; status: string; current_in: string | null; current_out: string | null }
export interface Plan { id: string; user_id: string; employee: string; plan_date: string; customer_id: string | null; customer_name: string; place: string | null;
  purpose: string | null; status: 'PLANNED' | 'DONE' | 'SKIPPED'; result_note: string | null; planned_by: string; phone: string | null }
const toIso = (d: string) => { const m = d.trim().match(/^(\d{1,2})[-/.](\d{1,2})[-/.](\d{4})$/); return m ? `${m[3]}-${m[2]!.padStart(2, '0')}-${m[1]!.padStart(2, '0')}` : null; };
const addDays = (iso: string, d: number) => new Date(new Date(`${iso}T00:00:00Z`).getTime() + d * 86400_000).toISOString().slice(0, 10);

export function OwnerRequests({ employees }: { employees: { id: string; full_name: string }[] }) {
  const t = useTheme();
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['owner-requests'], queryFn: () => rpc<{ leave: Leave[]; clock: Fix[] }>('owner_requests', { p_all: false }), refetchInterval: 120_000 });
  const [adding, setAdding] = useState(false);
  const refresh = () => { for (const k of ['owner-requests', 'employees-month', 'employee-month']) void qc.invalidateQueries({ queryKey: [k] }); };
  const fail = (e: unknown) => notify('Not done', e instanceof Error ? e.message : String(e));
  // group a person's consecutive leave days into one request
  const groups = Object.values((q.data?.leave ?? []).reduce<Record<string, Leave[]>>((a, l) => { (a[`${l.user_id}|${l.reason ?? ''}`] ??= []).push(l); return a; }, {}));
  const decideLeave = async (ls: Leave[], ok: boolean) => {
    const note = ok ? '' : await askText('Reason (sent to the employee)', undefined, { optional: true });
    if (note === null) return;
    rpc('owner_decide_leave', { p_ids: ls.map((l) => l.id), p_approve: ok, p_note: note || null }).then(refresh, fail);
  };
  const decideFix = async (f: Fix, ok: boolean) => {
    const note = ok ? '' : await askText('Reason (sent to the employee)', undefined, { optional: true });
    if (note === null) return;
    rpc('owner_decide_clock_fix', { p_id: f.id, p_approve: ok, p_note: note || null }).then(refresh, fail);
  };
  const pending = groups.length + (q.data?.clock ?? []).length;
  return (
    <Card title={pending ? `Requests waiting for you (${pending})` : 'Leave & clock requests'} icon="mail-unread-outline" tone={pending ? 'warning' : undefined}
      subtitle="Employees ask from their phone; you approve here. Approved leave stops the clock-in reminder for those days.">
      {groups.map((ls) => (
        <View key={ls[0]!.id} style={{ gap: 4, paddingVertical: 6, borderBottomWidth: 0.5, borderColor: t.border }}>
          <Text style={{ color: t.text, fontWeight: '700' }}>🌴 {ls[0]!.employee} — leave {dmy(ls[0]!.date)}{ls.length > 1 ? ` to ${dmy(ls[ls.length - 1]!.date)} (${ls.length} days)` : ''}</Text>
          {ls[0]!.reason ? <Label muted>{ls[0]!.reason}</Label> : null}
          <Toolbar>
            <SmallButton title="Approve" kind="primary" onPress={() => void decideLeave(ls, true)} />
            <SmallButton title="Reject" kind="danger" onPress={() => void decideLeave(ls, false)} />
          </Toolbar>
        </View>
      ))}
      {(q.data?.clock ?? []).map((f) => (
        <View key={f.id} style={{ gap: 4, paddingVertical: 6, borderBottomWidth: 0.5, borderColor: t.border }}>
          <Text style={{ color: t.text, fontWeight: '700' }}>⏰ {f.employee} — {dmy(f.date)}</Text>
          <Label muted>{`Wants: ${[f.want_in && `in ${timeIST(f.want_in)}`, f.want_out && `out ${timeIST(f.want_out)}`].filter(Boolean).join(', ')}`
            + (f.current_in ? ` · now: in ${timeIST(f.current_in)}${f.current_out ? `, out ${timeIST(f.current_out)}` : ', no clock-out'}` : ' · no entry that day')}</Label>
          <Label muted>{f.reason}</Label>
          <Toolbar>
            <SmallButton title="Approve" kind="primary" onPress={() => void decideFix(f, true)} />
            <SmallButton title="Reject" kind="danger" onPress={() => void decideFix(f, false)} />
          </Toolbar>
        </View>
      ))}
      {!pending ? <Label muted>Nothing waiting</Label> : null}
      <SmallButton icon="add" title="Give leave to an employee" onPress={() => setAdding(true)} />
      <AddLeave visible={adding} employees={employees} onClose={() => { setAdding(false); refresh(); }} />
    </Card>
  );
}

function AddLeave({ visible, employees, onClose }: { visible: boolean; employees: { id: string; full_name: string }[]; onClose: () => void }) {
  const [who, setWho] = useState<string | null>(null);
  const [from, setFrom] = useState(dmy(todayIST())); const [to, setTo] = useState(dmy(todayIST())); const [why, setWhy] = useState('');
  const save = useMutation({
    mutationFn: () => rpc<number>('owner_add_leave', { p_user: who, p_from: toIso(from), p_to: toIso(to), p_reason: why || null }),
    onSuccess: (n) => { notify('Leave added', `${n} day(s)`); onClose(); },
    onError: (e) => notify('Not saved', e instanceof Error ? e.message : String(e)),
  });
  return (
    <Sheet visible={visible} title="Give leave" onClose={onClose}>
      <Chips options={employees.map((e) => e.id)} value={who} onChange={setWho} format={(v) => employees.find((e) => e.id === v)?.full_name ?? v} />
      <View style={{ flexDirection: 'row', gap: 8 }}>
        <Field label="From (DD-MM-YYYY)" value={from} onChangeText={setFrom} />
        <Field label="To (DD-MM-YYYY)" value={to} onChangeText={setTo} />
      </View>
      <Field label="Reason (optional)" value={why} onChangeText={setWhy} />
      <Button title="Save leave" onPress={() => save.mutate()} busy={save.isPending} disabled={!who || !toIso(from) || !toIso(to)} />
    </Sheet>
  );
}

export function OwnerVisitPlans({ employees }: { employees: { id: string; full_name: string }[] }) {
  const t = useTheme();
  const qc = useQueryClient();
  const [day, setDay] = useState(todayIST());
  const q = useQuery({ queryKey: ['owner-plans', day], queryFn: () => rpc<Plan[]>('owner_visit_plans', { p_from: day, p_to: day, p_user: null }) });
  const [who, setWho] = useState<string | null>(null);
  const [party, setParty] = useState<Party | null>(null); const [name, setName] = useState(''); const [place, setPlace] = useState(''); const [purpose, setPurpose] = useState('');
  const add = useMutation({
    mutationFn: () => rpc('save_visit_plan', { p: { userId: who, planDate: day, customerId: party?.id, customerName: party ? undefined : name, place, purpose } }),
    onSuccess: () => { setParty(null); setName(''); setPlace(''); setPurpose(''); void qc.invalidateQueries({ queryKey: ['owner-plans'] }); notify('Visit planned', 'The employee is told in the app.'); },
    onError: (e) => notify('Not saved', e instanceof Error ? e.message : String(e)),
  });
  const del = (p: Plan) => rpc('delete_visit_plan', { p_id: p.id }).then(() => void qc.invalidateQueries({ queryKey: ['owner-plans'] }), (e) => notify('Not deleted', String(e)));
  const ICON = { PLANNED: '🗓', DONE: '✅', SKIPPED: '⏭' } as const;
  return (
    <Card title="Visit plans" icon="map-outline" subtitle="Plan who visits which customer; see what was done">
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
        <SmallButton title="‹" onPress={() => setDay((d) => addDays(d, -1))} />
        <Text style={{ flex: 1, textAlign: 'center', color: t.text, fontWeight: '700' }}>{new Date(`${day}T00:00:00`).toLocaleDateString('en-IN', { weekday: 'long', day: 'numeric', month: 'short' })}</Text>
        <SmallButton title="›" onPress={() => setDay((d) => addDays(d, 1))} />
      </View>
      {(q.data ?? []).map((p) => (
        <Row key={p.id} left={`${ICON[p.status]} ${p.employee}: ${p.customer_name}`} sub={[p.place, p.purpose, p.result_note && `→ ${p.result_note}`, `by ${p.planned_by}`].filter(Boolean).join(' · ')}
          right={<Toolbar>{p.phone ? <SmallButton icon="call-outline" title="" onPress={() => void Linking.openURL(`tel:${p.phone}`)} /> : null}<SmallButton title="✕" kind="danger" onPress={() => void del(p)} /></Toolbar>} />
      ))}
      {!q.data?.length ? <Label muted>No visits planned for this day</Label> : null}
      <Label>Plan a visit</Label>
      <Chips options={employees.map((e) => e.id)} value={who} onChange={setWho} format={(v) => employees.find((e) => e.id === v)?.full_name ?? v} />
      <PartyPicker kind="customers" value={party} onChange={setParty} />
      {!party ? <Field label="…or a new shop's name" value={name} onChangeText={setName} /> : null}
      <View style={{ flexDirection: 'row', gap: 8 }}>
        <Field label="Place" value={place} onChangeText={setPlace} />
        <Field label="Purpose" value={purpose} onChangeText={setPurpose} placeholder="collect payment, new order…" />
      </View>
      <Button title="Add to plan" onPress={() => add.mutate()} busy={add.isPending} disabled={!who || (!party && name.trim().length < 2)} />
    </Card>
  );
}

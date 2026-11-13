/** Visit plan: whom to visit today and this week (yours, or planned by the owner) — call, directions, mark done. */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Linking, Text, View } from 'react-native';
import { rpc } from '../../src/api/client';
import type { Party } from '../../src/api/types';
import type { Plan } from '../../src/components/OwnerRequests';
import { PartyPicker } from '../../src/components/PartyPicker';
import { Button, Card, Chips, Field, Label, Screen, SmallButton, Toolbar } from '../../src/components/ui';
import { askText, notify } from '../../src/lib/dialogs';
import { todayIST } from '../../src/lib/ids';
import { useTheme } from '../../src/theme';

const addDays = (iso: string, d: number) => new Date(new Date(`${iso}T00:00:00Z`).getTime() + d * 86400_000).toISOString().slice(0, 10);
const dayName = (iso: string) => (iso === todayIST() ? 'Today' : iso === addDays(todayIST(), 1) ? 'Tomorrow'
  : new Date(`${iso}T00:00:00`).toLocaleDateString('en-IN', { weekday: 'short', day: 'numeric', month: 'short' }));

export default function VisitPlan() {
  const t = useTheme();
  const qc = useQueryClient();
  const today = todayIST();
  const q = useQuery({ queryKey: ['my-plan'], queryFn: () => rpc<Plan[]>('my_visit_plan', { p_from: addDays(today, -1), p_to: addDays(today, 7) }) });
  const days = Array.from({ length: 8 }, (_, i) => addDays(today, i));
  const [day, setDay] = useState(today);
  const [party, setParty] = useState<Party | null>(null); const [name, setName] = useState(''); const [place, setPlace] = useState(''); const [purpose, setPurpose] = useState('');
  const refresh = () => void qc.invalidateQueries({ queryKey: ['my-plan'] });
  const add = useMutation({
    mutationFn: () => rpc('save_visit_plan', { p: { planDate: day, customerId: party?.id, customerName: party ? undefined : name, place, purpose } }),
    onSuccess: () => { setParty(null); setName(''); setPlace(''); setPurpose(''); refresh(); },
    onError: (e) => notify('Not saved', e instanceof Error ? e.message : String(e)),
  });
  const mark = async (p: Plan, status: 'DONE' | 'SKIPPED' | 'PLANNED') => {
    const note = status === 'PLANNED' ? '' : await askText(status === 'DONE' ? 'What happened?' : 'Why skipped?', 'e.g. took order for 20 boxes / shop closed', { optional: true });
    if (note === null) return;
    rpc('set_visit_plan_status', { p_id: p.id, p_status: status, p_note: note || null }).then(refresh, (e) => notify('Not saved', String(e)));
  };
  const del = (p: Plan) => rpc('delete_visit_plan', { p_id: p.id }).then(refresh, (e) => notify('Not deleted', e instanceof Error ? e.message : String(e)));
  const list = (q.data ?? []).filter((p) => p.plan_date === day);
  return (
    <Screen>
      <Chips options={days} value={day} onChange={setDay} format={(d) => { const k = (q.data ?? []).filter((p) => p.plan_date === d && p.status === 'PLANNED').length; return `${dayName(d)}${k ? ` (${k})` : ''}`; }} />
      {list.map((p) => (
        <Card key={p.id}>
          <View style={{ flexDirection: 'row', gap: 8 }}>
            <View style={{ flex: 1 }}>
              <Text style={{ color: t.text, fontWeight: '700', fontSize: 16, textDecorationLine: p.status === 'PLANNED' ? 'none' : 'line-through' }}>
                {p.status === 'DONE' ? '✅ ' : p.status === 'SKIPPED' ? '⏭ ' : ''}{p.customer_name}</Text>
              <Label muted>{[p.place, p.purpose, p.planned_by !== p.employee ? `planned by ${p.planned_by}` : null].filter(Boolean).join(' · ')}</Label>
              {p.result_note ? <Label muted>→ {p.result_note}</Label> : null}
            </View>
          </View>
          <Toolbar>
            {p.phone ? <SmallButton icon="call-outline" title="Call" onPress={() => void Linking.openURL(`tel:${p.phone}`)} /> : null}
            {p.place ? <SmallButton icon="navigate-outline" title="Directions" onPress={() => void Linking.openURL(`https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(`${p.customer_name} ${p.place}`)}`)} /> : null}
            {p.status === 'PLANNED' ? <SmallButton title="Done" kind="primary" onPress={() => void mark(p, 'DONE')} /> : <SmallButton title="Undo" onPress={() => void mark(p, 'PLANNED')} />}
            {p.status === 'PLANNED' ? <SmallButton title="Skip" onPress={() => void mark(p, 'SKIPPED')} /> : null}
            {p.planned_by === p.employee ? <SmallButton title="✕" kind="danger" onPress={() => void del(p)} /> : null}
          </Toolbar>
        </Card>
      ))}
      {!list.length ? <Label muted>No visits planned for {dayName(day).toLowerCase()}</Label> : null}
      <Card title={`Add a visit for ${dayName(day).toLowerCase()}`}>
        <PartyPicker kind="customers" value={party} onChange={setParty} />
        {!party ? <Field label="…or a new shop's name" value={name} onChangeText={setName} /> : null}
        <View style={{ flexDirection: 'row', gap: 8 }}>
          <Field label="Place" value={place} onChangeText={setPlace} />
          <Field label="Purpose" value={purpose} onChangeText={setPurpose} placeholder="order, payment, new shop…" />
        </View>
        <Button title="Add to plan" onPress={() => add.mutate()} busy={add.isPending} disabled={!party && name.trim().length < 2} />
      </Card>
    </Screen>
  );
}

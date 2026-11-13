/** Ask the owner for leave, or to correct a clock-in / clock-out time. You get a notification when they decide. */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Text, View } from 'react-native';
import { rpc } from '../../src/api/client';
import { Button, Card, Chips, Field, Label, Row, Screen, SmallButton } from '../../src/components/ui';
import { dmy, timeIST } from '../../src/lib/dates';
import { notify } from '../../src/lib/dialogs';
import { todayIST } from '../../src/lib/ids';
import { useTheme } from '../../src/theme';

interface Mine { leave: { id: string; date: string; reason: string | null; status: string; owner_note: string | null }[];
  clock: { id: string; date: string; want_in: string | null; want_out: string | null; reason: string; status: string; owner_note: string | null }[] }
interface Att { id: string; work_date: string; clock_in_at: string; clock_out_at: string | null }
const toIso = (d: string) => { const m = d.trim().match(/^(\d{1,2})[-/.](\d{1,2})[-/.](\d{4})$/); return m ? `${m[3]}-${m[2]!.padStart(2, '0')}-${m[1]!.padStart(2, '0')}` : null; };
const hhmm = (s: string) => { const m = s.trim().match(/^(\d{1,2})[:.](\d{2})\s*(am|pm)?$/i); if (!m) return null; let h = Number(m[1]); const ap = m[3]?.toLowerCase();
  if (ap === 'pm' && h < 12) h += 12; if (ap === 'am' && h === 12) h = 0; return h < 24 && Number(m[2]) < 60 ? `${String(h).padStart(2, '0')}:${m[2]}` : null; };
const STATUS: Record<string, string> = { REQUESTED: '⏳ waiting', APPROVED: '✓ approved', REJECTED: '✕ not approved', CANCELLED: 'cancelled' };

export default function Requests() {
  const t = useTheme();
  const qc = useQueryClient();
  const mine = useQuery({ queryKey: ['my-requests'], queryFn: () => rpc<Mine>('my_requests') });
  const refresh = () => void qc.invalidateQueries({ queryKey: ['my-requests'] });
  const fail = (e: unknown) => notify('Not sent', e instanceof Error ? e.message : String(e));

  const [lf, setLf] = useState(dmy(todayIST())); const [lt, setLt] = useState(dmy(todayIST())); const [lr, setLr] = useState('');
  const leave = useMutation({ mutationFn: () => rpc<{ days: number }>('request_leave', { p_from: toIso(lf), p_to: toIso(lt), p_reason: lr }),
    onSuccess: (r) => { notify('Leave request sent', `${r.days} day(s). The owner will approve or reply.`); setLr(''); refresh(); }, onError: fail });

  const [cd, setCd] = useState(dmy(todayIST())); const [ci, setCi] = useState(''); const [co, setCo] = useState(''); const [cr, setCr] = useState('');
  const attMonth = (toIso(cd) ?? todayIST()).slice(0, 8) + '01';
  const att = useQuery({ queryKey: ['my-attendance-month', attMonth], queryFn: () => rpc<{ days: Att[] }>('my_attendance', { p_month: attMonth }) });
  const days: Att[] = att.data?.days ?? [];
  const entry = days.find((a) => a.work_date === toIso(cd));
  const fix = useMutation({ mutationFn: () => rpc('request_clock_fix', { p: { date: toIso(cd), attendanceId: entry?.id, clockIn: ci ? hhmm(ci) : null, clockOut: co ? hhmm(co) : null, reason: cr } }),
    onSuccess: () => { notify('Correction request sent', 'The owner will check and approve.'); setCi(''); setCo(''); setCr(''); refresh(); }, onError: fail });
  const cancel = (id: string) => rpc('cancel_leave_request', { p_id: id }).then(refresh, fail);

  return (
    <Screen>
      <Card title="Ask for leave" icon="airplane-outline">
        <View style={{ flexDirection: 'row', gap: 8 }}>
          <Field label="From (DD-MM-YYYY)" value={lf} onChangeText={setLf} error={lf && !toIso(lf) ? 'DD-MM-YYYY' : undefined} />
          <Field label="To (DD-MM-YYYY)" value={lt} onChangeText={setLt} error={lt && !toIso(lt) ? 'DD-MM-YYYY' : undefined} />
        </View>
        <Field label="Reason" value={lr} onChangeText={setLr} placeholder="e.g. family function, not well" />
        <Button title="Send leave request" onPress={() => leave.mutate()} busy={leave.isPending} disabled={!toIso(lf) || !toIso(lt) || lr.trim().length < 3} />
      </Card>
      <Card title="Fix a clock-in / clock-out time" icon="time-outline" subtitle="Forgot to clock in or out, or the time is wrong? Ask the owner to correct it.">
        <Field label="Day (DD-MM-YYYY)" value={cd} onChangeText={setCd} error={cd && !toIso(cd) ? 'DD-MM-YYYY' : undefined} />
        <Label muted>{entry ? `App shows: in ${timeIST(entry.clock_in_at)}${entry.clock_out_at ? `, out ${timeIST(entry.clock_out_at)}` : ', no clock-out'}` : 'No clock-in on this day — enter the time you started.'}</Label>
        <View style={{ flexDirection: 'row', gap: 8 }}>
          <Field label="Correct clock-in (e.g. 9:05 am)" value={ci} onChangeText={setCi} error={ci && !hhmm(ci) ? 'like 9:05 am' : undefined} />
          <Field label="Correct clock-out (e.g. 6:40 pm)" value={co} onChangeText={setCo} error={co && !hhmm(co) ? 'like 6:40 pm' : undefined} />
        </View>
        <Field label="Reason" value={cr} onChangeText={setCr} placeholder="e.g. phone battery was dead" />
        <Button title="Send correction request" onPress={() => fix.mutate()} busy={fix.isPending}
          disabled={!toIso(cd) || cr.trim().length < 3 || (!ci && !co) || (!!ci && !hhmm(ci)) || (!!co && !hhmm(co)) || (!entry && !ci)} />
      </Card>
      <Card title="My requests">
        {(mine.data?.leave ?? []).map((l) => (
          <Row key={l.id} left={`🌴 Leave ${dmy(l.date)}`} sub={[l.reason, l.owner_note && `owner: ${l.owner_note}`].filter(Boolean).join(' · ')}
            right={<View style={{ alignItems: 'flex-end', gap: 4 }}><Text style={{ color: l.status === 'APPROVED' ? t.good : l.status === 'REJECTED' ? t.danger : t.textSecondary }}>{STATUS[l.status]}</Text>
              {(l.status === 'REQUESTED' || l.status === 'APPROVED') && l.date >= todayIST() ? <SmallButton title="Cancel" onPress={() => void cancel(l.id)} /> : null}</View>} />
        ))}
        {(mine.data?.clock ?? []).map((c) => (
          <Row key={c.id} left={`⏰ ${dmy(c.date)}: ${[c.want_in && `in ${timeIST(c.want_in)}`, c.want_out && `out ${timeIST(c.want_out)}`].filter(Boolean).join(', ')}`}
            sub={[c.reason, c.owner_note && `owner: ${c.owner_note}`].filter(Boolean).join(' · ')}
            right={<Text style={{ color: c.status === 'APPROVED' ? t.good : c.status === 'REJECTED' ? t.danger : t.textSecondary }}>{STATUS[c.status]}</Text>} />
        ))}
        {!(mine.data?.leave ?? []).length && !(mine.data?.clock ?? []).length ? <Label muted>No requests yet</Label> : null}
      </Card>
    </Screen>
  );
}

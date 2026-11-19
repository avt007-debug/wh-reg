/**
 * Owner settings for the automatic phone notifications (also shown in the app's bell):
 * clock-in reminder, clock-out reminder, owner's daily summary; working days; extra owner numbers.
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { Pressable, Text, View } from 'react-native';
import { rpc } from '../api/client';
import { notify } from '../lib/dialogs';
import { useTheme } from '../theme';
import { Button, Card, Chips, Field, Label, SmallButton } from './ui';

interface Job { enabled: boolean; time: string }
interface Settings {
  clock_in: Job; clock_out: Job; summary: Job; work_days: number[]; summary_every_day: boolean; owner_numbers: string[];
  resolved_owner_numbers: string[]; employees_without_phone: string[]; whatsapp_connected: boolean;
}

const DAYS = [1, 2, 3, 4, 5, 6, 7] as const;
const DAY = ['', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const to12 = (hhmm: string) => { const [h, m] = hhmm.split(':').map(Number); return `${((h! + 11) % 12) + 1}:${String(m).padStart(2, '0')} ${h! < 12 ? 'AM' : 'PM'}`; };

function JobRow({ title, hint, job, onChange }: { title: string; hint: string; job: Job; onChange: (j: Job) => void }) {
  const t = useTheme();
  const ok = /^([01]\d|2[0-3]):[0-5]\d$/.test(job.time);
  return (
    <View style={{ gap: 6, paddingVertical: 8, borderBottomWidth: 0.5, borderColor: t.border }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
        <View style={{ flex: 1 }}>
          <Text style={{ color: t.text, fontWeight: '700' }}>{title}</Text>
          <Text style={{ color: t.textMuted, fontSize: 12.5 }}>{hint}</Text>
        </View>
        <Pressable onPress={() => onChange({ ...job, enabled: !job.enabled })} accessibilityRole="switch" accessibilityState={{ checked: job.enabled }}
          style={{ width: 52, height: 30, borderRadius: 15, padding: 3, backgroundColor: job.enabled ? t.accent : t.cardAlt, borderWidth: 1, borderColor: t.hairline, alignItems: job.enabled ? 'flex-end' : 'flex-start' }}>
          <View style={{ width: 22, height: 22, borderRadius: 11, backgroundColor: job.enabled ? t.yellow : '#fff' }} />
        </Pressable>
      </View>
      <View style={{ flexDirection: 'row', alignItems: 'flex-end', gap: 8 }}>
        <View style={{ width: 130 }}>
          <Field label="Time (24-hour)" value={job.time} onChangeText={(v) => onChange({ ...job, time: v })} placeholder="09:00" maxLength={5}
            error={ok ? undefined : 'e.g. 09:00 or 18:30'} style={{ width: 130 }} />
        </View>
        {ok ? <Label muted>= {to12(job.time)}</Label> : null}
      </View>
    </View>
  );
}

export function ReminderSettings() {
  const t = useTheme();
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['notif-settings'], queryFn: () => rpc<Settings>('owner_notification_settings') });
  const [s, setS] = useState<Settings | null>(null);
  useEffect(() => { if (q.data) setS(q.data); }, [q.data]);

  const save = useMutation({
    mutationFn: () => rpc<Settings>('owner_save_notification_settings', { p: {
      clock_in: s!.clock_in, clock_out: s!.clock_out, summary: s!.summary, work_days: s!.work_days,
      summary_every_day: s!.summary_every_day, owner_numbers: s!.owner_numbers ?? [],
    } }),
    onSuccess: (d) => { qc.setQueryData(['notif-settings'], d); notify('Saved', 'Reminder settings updated'); },
    onError: (e) => notify('Not saved', e instanceof Error ? e.message : String(e)),
  });
  const sendNow = useMutation({
    mutationFn: () => rpc<{ queued: boolean; text: string }>('owner_send_summary_now'),
    onSuccess: (r) => { void qc.invalidateQueries({ queryKey: ['notifications'] });
      notify('Summary sent', `${r.text}\n\nIt is in the bell, and on your phone if notifications are turned on.`); },
    onError: (e) => notify('Could not send', e instanceof Error ? e.message : String(e)),
  });

  if (!s) return <Card title="Reminders & daily summary" icon="alarm-outline"><Label muted>Loading…</Label></Card>;
  return (
    <Card title="Reminders & daily summary" icon="alarm-outline"
      subtitle="Sent as phone notifications from the WH Reg app and shown in the bell. Each person turns notifications on once on their phone.">
      <JobRow title="Clock-in reminder" hint="Phone notification to employees who have not clocked in yet" job={s.clock_in} onChange={(j) => setS({ ...s, clock_in: j })} />
      <JobRow title="Clock-out reminder" hint="Phone notification to employees still clocked in" job={s.clock_out} onChange={(j) => setS({ ...s, clock_out: j })} />
      <JobRow title="Daily summary to owner" hint="Phone notification to you: sales, money collected, purchases (and how many to approve), attendance, market runs, top customer" job={s.summary} onChange={(j) => setS({ ...s, summary: j })} />
      <Label>Working days (reminders are sent only on these days)</Label>
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6 }}>
        {DAYS.map((d) => {
          const on = s.work_days.includes(d);
          return (
            <Pressable key={d} onPress={() => setS({ ...s, work_days: on ? s.work_days.filter((x) => x !== d) : [...s.work_days, d].sort() })}
              style={{ paddingHorizontal: 12, paddingVertical: 8, borderRadius: 999, borderWidth: 1, borderColor: on ? t.accent : t.hairline, backgroundColor: on ? t.accentSoft : t.card }}>
              <Text style={{ color: on ? t.accent : t.text, fontWeight: on ? '800' : '500' }}>{DAY[d]}</Text>
            </Pressable>
          );
        })}
      </View>
      <Label>Daily summary on</Label>
      <Chips options={['every', 'work'] as const} value={s.summary_every_day ? 'every' : 'work'} onChange={(v) => setS({ ...s, summary_every_day: v === 'every' })}
        format={(v) => (v === 'every' ? 'Every day' : 'Working days only')} />
      <Button title="Save reminder settings" icon="checkmark" onPress={() => save.mutate()} busy={save.isPending} />
      <SmallButton title="Send today's summary now" icon="paper-plane-outline" onPress={() => sendNow.mutate()} disabled={sendNow.isPending} />

    </Card>
  );
}

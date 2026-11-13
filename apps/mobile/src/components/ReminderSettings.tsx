/**
 * Owner settings for the automatic WhatsApp + in-app messages:
 * clock-in reminder, clock-out reminder, owner's daily summary; working days; extra owner numbers.
 * Also the delivery log of the latest WhatsApp messages.
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { Pressable, Text, View } from 'react-native';
import { rpc } from '../api/client';
import { notify } from '../lib/dialogs';
import { dateTimeIST } from '../lib/dates';
import { useTheme } from '../theme';
import { Button, Card, Chips, Field, Label, Notice, Row, SmallButton } from './ui';

interface Job { enabled: boolean; time: string }
interface Settings {
  clock_in: Job; clock_out: Job; summary: Job; work_days: number[]; summary_every_day: boolean; owner_numbers: string[];
  resolved_owner_numbers: string[]; employees_without_phone: string[]; whatsapp_connected: boolean;
}
interface OutboxRow { id: number; event_type: string; kind: string | null; person: string | null; status: string; last_error: string | null; created_at: string; sent_to_numbers: string[] | null }

const DAYS = [1, 2, 3, 4, 5, 6, 7] as const;
const DAY = ['', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const KIND: Record<string, string> = { CLOCK_IN_REMINDER: 'Clock-in reminder', CLOCK_OUT_REMINDER: 'Clock-out reminder', DAILY_SUMMARY: 'Daily summary' };
const STATUS: Record<string, string> = { PENDING: 'Waiting', SENDING: 'Sending', SENT: 'Sent', DELIVERED: 'Delivered ✓', FAILED: 'Retrying', DEAD: 'Failed' };
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
  const log = useQuery({ queryKey: ['outbox'], queryFn: () => rpc<OutboxRow[]>('owner_notifications', { p_limit: 15 }), refetchInterval: 60_000 });
  const [s, setS] = useState<Settings | null>(null);
  const [extra, setExtra] = useState('');
  useEffect(() => { if (q.data) { setS(q.data); setExtra((q.data.owner_numbers ?? []).join(', ')); } }, [q.data]);

  const save = useMutation({
    mutationFn: () => rpc<Settings>('owner_save_notification_settings', { p: {
      clock_in: s!.clock_in, clock_out: s!.clock_out, summary: s!.summary, work_days: s!.work_days,
      summary_every_day: s!.summary_every_day, owner_numbers: extra.split(/[,\s]+/).map((x) => x.trim()).filter(Boolean),
    } }),
    onSuccess: (d) => { qc.setQueryData(['notif-settings'], d); notify('Saved', 'Reminder settings updated'); },
    onError: (e) => notify('Not saved', e instanceof Error ? e.message : String(e)),
  });
  const sendNow = useMutation({
    mutationFn: () => rpc<{ queued: boolean }>('owner_send_summary_now'),
    onSuccess: (r) => { void qc.invalidateQueries({ queryKey: ['outbox'] });
      notify(r.queued ? 'Summary queued' : 'No WhatsApp number', r.queued ? 'It goes out as soon as WhatsApp is connected.' : 'Add your mobile number to your login (Staff logins → Edit) or below.'); },
    onError: (e) => notify('Could not send', e instanceof Error ? e.message : String(e)),
  });

  if (!s) return <Card title="Reminders & daily summary" icon="alarm-outline"><Label muted>Loading…</Label></Card>;
  return (
    <Card title="Reminders & daily summary" icon="alarm-outline"
      subtitle="Sent on WhatsApp and shown in the app's bell. Employees get reminders on their own mobile number.">
      {!s.whatsapp_connected ? (
        <Notice tone="warning">WhatsApp is not connected yet, so these messages appear only in the app for now. Once your Meta WhatsApp Business number is connected they go out on WhatsApp automatically.</Notice>
      ) : <Notice tone="good">WhatsApp is connected — messages are being delivered.</Notice>}
      <JobRow title="Clock-in reminder" hint="To employees who have not clocked in yet" job={s.clock_in} onChange={(j) => setS({ ...s, clock_in: j })} />
      <JobRow title="Clock-out reminder" hint="To employees still clocked in" job={s.clock_out} onChange={(j) => setS({ ...s, clock_out: j })} />
      <JobRow title="Daily summary to owner" hint="Sales (to whom), purchases (from whom), attendance, market runs" job={s.summary} onChange={(j) => setS({ ...s, summary: j })} />
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
      <Field label="Extra numbers for the daily summary (optional)" value={extra} onChangeText={setExtra} keyboardType="phone-pad" placeholder="e.g. 9876543210, 9123456780" />
      <Label muted>Summary goes to: {s.resolved_owner_numbers.length ? s.resolved_owner_numbers.map((x) => `+${x}`).join(', ') : 'nobody yet — add your mobile number to your owner login or above'}</Label>
      {s.employees_without_phone.length ? (
        <Notice tone="warning">No mobile number for: {s.employees_without_phone.join(', ')}. They get reminders only in the app. Add numbers in Staff logins → Edit.</Notice>
      ) : null}
      <Button title="Save reminder settings" icon="checkmark" onPress={() => save.mutate()} busy={save.isPending} />
      <SmallButton title="Send today's summary now" icon="paper-plane-outline" onPress={() => sendNow.mutate()} disabled={sendNow.isPending} />

      <Label>Latest WhatsApp messages</Label>
      {(log.data ?? []).map((o) => (
        <Row key={o.id} left={`${KIND[o.kind ?? ''] ?? o.event_type.replaceAll('_', ' ').toLowerCase()}${o.person ? ` · ${o.person}` : ''}`}
          sub={o.last_error ? `${dateTimeIST(o.created_at)} · ${o.last_error}` : dateTimeIST(o.created_at)} right={STATUS[o.status] ?? o.status} />
      ))}
      {!log.data?.length ? <Label muted>None yet</Label> : null}
    </Card>
  );
}

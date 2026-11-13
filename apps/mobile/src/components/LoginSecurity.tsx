/**
 * Owner: login security — rules (auto-lock, login hours, new-phone approval, lock after wrong passwords),
 * locked User IDs, devices per person (approve / block / forget), log out everywhere, login history,
 * and the owner's own recovery codes.
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { Pressable, Text, View } from 'react-native';
import { rpc } from '../api/client';
import { confirmAsk, notify } from '../lib/dialogs';
import { dateTimeIST } from '../lib/dates';
import { useTheme } from '../theme';
import { Button, Card, Chips, Field, Label, Notice, Row, SmallButton, Toolbar } from './ui';

interface Sec { lock_after_failures: number; lock_minutes: number; require_device_approval: boolean; staff_hours: { enabled: boolean; from: string; to: string }; staff_idle_minutes: number; owner_idle_minutes: number }
interface Device { user_id: string; full_name: string; login_id: string; device_id: string; device_name: string | null; status: 'PENDING' | 'APPROVED' | 'BLOCKED'; first_seen: string; last_seen: string }
interface Activity {
  events: { id: number; login_id: string; full_name: string | null; success: boolean; device_name: string | null; note: string | null; created_at: string }[];
  devices: Device[]; locked: { login_id: string; until: string }[]; settings: Sec;
}

const IDLE = [0, 10, 30, 60, 120] as const;
const NOTE: Record<string, string> = {
  UNLOCKED: 'unlocked by owner', DEVICE_PENDING: 'new phone — waiting for approval', DEVICE_BLOCKED: 'blocked phone',
  OUTSIDE_HOURS: 'outside login hours', DISABLED: 'login turned off', RECOVERY_CODE_USED: 'recovery code used', RECOVERY_CODE_WRONG: 'wrong recovery code',
};

function Toggle({ on, onChange }: { on: boolean; onChange: (v: boolean) => void }) {
  const t = useTheme();
  return (
    <Pressable onPress={() => onChange(!on)} accessibilityRole="switch" accessibilityState={{ checked: on }}
      style={{ width: 52, height: 30, borderRadius: 15, padding: 3, backgroundColor: on ? t.accent : t.cardAlt, borderWidth: 1, borderColor: t.hairline, alignItems: on ? 'flex-end' : 'flex-start' }}>
      <View style={{ width: 22, height: 22, borderRadius: 11, backgroundColor: on ? t.yellow : '#fff' }} />
    </Pressable>
  );
}

export function LoginSecurity() {
  const t = useTheme();
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['login-activity'], queryFn: () => rpc<Activity>('owner_login_activity', { p_limit: 60 }), refetchInterval: 60_000 });
  const [s, setS] = useState<Sec | null>(null);
  const [showAll, setShowAll] = useState(false);
  useEffect(() => { if (q.data) setS(q.data.settings); }, [q.data]);
  const refresh = () => void qc.invalidateQueries({ queryKey: ['login-activity'] });
  const fail = (e: unknown) => notify('Not saved', e instanceof Error ? e.message : String(e));

  const save = useMutation({ mutationFn: () => rpc('owner_save_security_settings', { p: s }), onSuccess: () => { refresh(); notify('Saved', 'Login rules updated'); }, onError: fail });
  const device = useMutation({ mutationFn: (d: { user: string; id: string; status: string }) => rpc('owner_set_device', { p_user: d.user, p_device_id: d.id, p_status: d.status }), onSuccess: refresh, onError: fail });
  const unlock = useMutation({ mutationFn: (id: string) => rpc('owner_unlock_login', { p_login_id: id }), onSuccess: () => { refresh(); notify('Unlocked'); }, onError: fail });
  const kick = useMutation({ mutationFn: (u: string) => rpc('owner_logout_everywhere', { p_user: u }), onSuccess: () => notify('Done', 'They are signed out on every phone within 2 minutes.'), onError: fail });

  const d = q.data;
  const people = new Map<string, { name: string; login: string; devices: Device[] }>();
  for (const x of d?.devices ?? []) {
    const p = people.get(x.user_id) ?? { name: x.full_name, login: x.login_id, devices: [] };
    p.devices.push(x); people.set(x.user_id, p);
  }
  const pending = (d?.devices ?? []).filter((x) => x.status === 'PENDING');
  const failsToday = (d?.events ?? []).filter((e) => !e.success && !e.note && e.created_at.slice(0, 10) === new Date().toISOString().slice(0, 10)).length;

  return (
    <Card title="Login security" icon="shield-checkmark-outline" subtitle="Who logged in where, phones, locks and rules">
      {pending.length ? <Notice tone="warning">{pending.length} new phone(s) waiting for your approval below.</Notice> : null}
      {d?.locked.length ? d.locked.map((l) => (
        <Row key={l.login_id} left={`🔒 ${l.login_id}`} sub={`Locked after wrong passwords until ${dateTimeIST(l.until)}`}
          right={<SmallButton title="Unlock" kind="primary" onPress={() => unlock.mutate(l.login_id)} />} />
      )) : null}
      {failsToday ? <Label muted>{failsToday} wrong password attempt(s) today.</Label> : null}

      {s ? (
        <View style={{ gap: 10, paddingVertical: 6, borderTopWidth: 0.5, borderBottomWidth: 0.5, borderColor: t.border }}>
          <Text style={{ color: t.text, fontWeight: '700' }}>Rules</Text>
          <Label>Auto-lock employees' app after no use</Label>
          <Chips options={IDLE} value={s.staff_idle_minutes as (typeof IDLE)[number]} onChange={(v) => setS({ ...s, staff_idle_minutes: v })} format={(v) => (v ? `${v} min` : 'Never')} />
          <Label>Auto-lock my (owner) app after no use</Label>
          <Chips options={IDLE} value={s.owner_idle_minutes as (typeof IDLE)[number]} onChange={(v) => setS({ ...s, owner_idle_minutes: v })} format={(v) => (v ? `${v} min` : 'Never')} />
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
            <View style={{ flex: 1 }}>
              <Text style={{ color: t.text, fontWeight: '600' }}>New phones need my approval</Text>
              <Text style={{ color: t.textMuted, fontSize: 12.5 }}>An employee's first phone is approved automatically; any other phone waits for you.</Text>
            </View>
            <Toggle on={s.require_device_approval} onChange={(v) => setS({ ...s, require_device_approval: v })} />
          </View>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
            <View style={{ flex: 1 }}>
              <Text style={{ color: t.text, fontWeight: '600' }}>Employees can log in only during working hours</Text>
              <Text style={{ color: t.textMuted, fontSize: 12.5 }}>Outside these hours the app signs them out. You (owner) are never limited.</Text>
            </View>
            <Toggle on={s.staff_hours.enabled} onChange={(v) => setS({ ...s, staff_hours: { ...s.staff_hours, enabled: v } })} />
          </View>
          {s.staff_hours.enabled ? (
            <View style={{ flexDirection: 'row', gap: 8 }}>
              <Field label="From" value={s.staff_hours.from} onChangeText={(v) => setS({ ...s, staff_hours: { ...s.staff_hours, from: v } })} placeholder="07:00" maxLength={5} />
              <Field label="To" value={s.staff_hours.to} onChangeText={(v) => setS({ ...s, staff_hours: { ...s.staff_hours, to: v } })} placeholder="21:00" maxLength={5} />
            </View>
          ) : null}
          <Label>Lock a User ID after this many wrong passwords (for {s.lock_minutes} minutes)</Label>
          <Chips options={[3, 5, 8, 10] as const} value={s.lock_after_failures as 3 | 5 | 8 | 10} onChange={(v) => setS({ ...s, lock_after_failures: v })} />
          <Button title="Save login rules" icon="checkmark" onPress={() => save.mutate()} busy={save.isPending} />
        </View>
      ) : null}

      <Text style={{ color: t.text, fontWeight: '700' }}>Phones & computers</Text>
      {[...people.entries()].map(([uid, p]) => (
        <View key={uid} style={{ gap: 4, paddingVertical: 6, borderBottomWidth: 0.5, borderColor: t.border }}>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
            <Text style={{ flex: 1, color: t.text, fontWeight: '700' }}>{p.name} <Text style={{ color: t.textMuted, fontWeight: '400' }}>({p.login})</Text></Text>
            <SmallButton title="Log out everywhere" icon="log-out-outline"
              onPress={() => void confirmAsk(`Log ${p.name} out on every phone?`, 'They will need their password again.', 'Log out').then((ok) => { if (ok) kick.mutate(uid); })} />
          </View>
          {p.devices.map((x) => (
            <View key={x.device_id} style={{ flexDirection: 'row', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
              <Text style={{ flex: 1, minWidth: 180, color: x.status === 'BLOCKED' ? t.danger : t.textSecondary, fontSize: 13 }}>
                {x.status === 'PENDING' ? '⏳ ' : x.status === 'BLOCKED' ? '⛔ ' : '✓ '}{x.device_name ?? 'Device'} · last used {dateTimeIST(x.last_seen)}
              </Text>
              <Toolbar>
                {x.status !== 'APPROVED' ? <SmallButton title="Approve" kind="primary" onPress={() => device.mutate({ user: uid, id: x.device_id, status: 'APPROVED' })} /> : null}
                {x.status !== 'BLOCKED' ? <SmallButton title="Block" kind="danger" onPress={() => device.mutate({ user: uid, id: x.device_id, status: 'BLOCKED' })} /> : null}
                <SmallButton title="Forget" onPress={() => device.mutate({ user: uid, id: x.device_id, status: 'FORGET' })} />
              </Toolbar>
            </View>
          ))}
        </View>
      ))}
      {!people.size ? <Label muted>{q.isLoading ? 'Loading…' : 'No logins recorded yet (recorded from now on).'}</Label> : null}

      <Text style={{ color: t.text, fontWeight: '700' }}>Login history</Text>
      {(d?.events ?? []).slice(0, showAll ? 60 : 10).map((e) => (
        <Row key={e.id} left={`${e.success ? '✓' : '✕'} ${e.full_name ?? e.login_id}`}
          sub={`${dateTimeIST(e.created_at)}${e.device_name ? ` · ${e.device_name}` : ''}${e.note ? ` · ${NOTE[e.note] ?? e.note}` : !e.success ? ' · wrong password' : ''}`} />
      ))}
      {(d?.events.length ?? 0) > 10 ? <SmallButton title={showAll ? 'Show less' : 'Show more'} onPress={() => setShowAll(!showAll)} /> : null}
    </Card>
  );
}

/** Owner: one-time recovery codes for a forgotten owner password. */
export function RecoveryCodes() {
  const left = useQuery({ queryKey: ['recovery-left'], queryFn: () => rpc<number>('owner_recovery_codes_left') });
  const [codes, setCodes] = useState<string[] | null>(null);
  const make = useMutation({
    mutationFn: () => rpc<string[]>('owner_new_recovery_codes'),
    onSuccess: (c) => { setCodes(c); void left.refetch(); },
    onError: (e) => notify('Not created', e instanceof Error ? e.message : String(e)),
  });
  const n = Number(left.data ?? 0);
  return (
    <Card title="Owner recovery codes" icon="key-outline" tone={n ? undefined : 'warning'}
      subtitle="If you ever forget your owner password: login screen → “Forgot owner password?” → User ID + one code → new password.">
      {codes ? (
        <>
          <Notice tone="warning">Write these down or print them now and keep them somewhere safe. They are shown only once. Each code works once.</Notice>
          <Text selectable style={{ fontFamily: 'monospace', fontSize: 17, lineHeight: 28 }}>{codes.join('\n')}</Text>
        </>
      ) : <Label muted>{n ? `${n} unused code(s) left.` : 'You have no recovery codes yet — create them now.'}</Label>}
      <Button title={n ? 'Make new codes (old ones stop working)' : 'Create recovery codes'} icon="key-outline" kind={n ? 'secondary' : 'primary'}
        onPress={() => void (n ? confirmAsk('Make new recovery codes?', 'Your current unused codes will stop working.', 'Make new') : Promise.resolve(true)).then((ok) => { if (ok) make.mutate(); })}
        busy={make.isPending} />
    </Card>
  );
}

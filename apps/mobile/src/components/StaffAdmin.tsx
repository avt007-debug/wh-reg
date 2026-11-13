/**
 * Owner: staff logins — see each employee's login ID, password (the one the
 * owner last set), last login and clock-in/out; edit name / login ID / phone /
 * warehouse; reset a password and send it on WhatsApp; disable, remove or
 * restore; add new staff.
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Text, View } from 'react-native';
import { edge, rpc } from '../api/client';
import { dateTimeIST, timeIST } from '../lib/dates';
import { confirmAsk, notify } from '../lib/dialogs';
import { useWarehouses } from '../lib/warehouse';
import { openWhatsApp } from '../lib/whatsapp';
import { useTheme } from '../theme';
import { Button, Card, Chips, Field, Label, Row, SmallButton, Toolbar } from './ui';

export interface StaffRow {
  id: string; login_id: string; full_name: string; phone: string | null; role: 'OWNER' | 'ADMIN' | 'EMPLOYEE';
  is_active: boolean; removed_at: string | null; warehouse_id: string | null; warehouse_name: string | null;
  last_sign_in_at: string | null; has_override_pin: boolean; has_saved_password: boolean;
  last_shift: { clock_in_at: string; clock_out_at: string | null } | null;
}

const APP_URL = 'https://avt007-debug.github.io/wh-reg/';
const loginMessage = (name: string, loginId: string, password: string) =>
  `Hello ${name},\nYour WH Reg login:\nUser ID: ${loginId}\nPassword: ${password}\nOpen: ${APP_URL}`;

/** Same style as the server's generator: easy to read out, letters + digits. */
function generatePassword() {
  const letters = 'abcdefghjkmnpqrstuvwxyz';
  const r = (k: number) => Math.floor(Math.random() * k);
  const w = Array.from({ length: 4 }, () => letters[r(letters.length)]).join('');
  const d = Array.from({ length: 4 }, () => String(2 + r(8))).join('');
  return `${w[0]!.toUpperCase()}${w.slice(1)}-${d}-${letters[r(23)]}${letters[r(23)]}`;
}

export function StaffAdmin() {
  const t = useTheme();
  const qc = useQueryClient();
  const users = useQuery({ queryKey: ['users'], queryFn: () => rpc<StaffRow[]>('owner_list_users') });
  const [showRemoved, setShowRemoved] = useState(false);
  const refresh = () => { void qc.invalidateQueries({ queryKey: ['users'] }); void qc.invalidateQueries({ queryKey: ['employees-month'] }); };

  const list = users.data ?? [];
  const current = list.filter((u) => !u.removed_at);
  const removed = list.filter((u) => u.removed_at);

  return (
    <>
      <Card title={`Staff logins (${current.filter((u) => u.role !== 'OWNER').length})`}>
        {current.map((u) => <StaffCard key={u.id} u={u} onChanged={refresh} />)}
        {!current.length ? <Label muted>{users.isLoading ? 'Loading…' : 'No logins yet'}</Label> : null}
        {removed.length ? (
          <SmallButton title={showRemoved ? 'Hide removed staff' : `Show removed staff (${removed.length})`} onPress={() => setShowRemoved((v) => !v)} />
        ) : null}
        {showRemoved ? removed.map((u) => (
          <Row key={u.id} left={`${u.full_name} (${u.login_id})`} sub={`Removed ${dateTimeIST(u.removed_at)} · history is kept`}
            right={<SmallButton title="Restore" onPress={() => edge('admin-users', { action: 'restore', userId: u.id })
              .then(() => { refresh(); notify('Restored', `${u.full_name} can log in again with the same password.`); },
                (e) => notify('Not restored', e instanceof Error ? e.message : String(e)))} />} />
        )) : null}
      </Card>
      <AddStaff onCreated={refresh} />
      <Text style={{ color: t.textMuted, fontSize: 12 }}>
        Passwords you set here are saved encrypted so you can look them up; staff cannot see each other's passwords.
      </Text>
    </>
  );
}

function StaffCard({ u, onChanged }: { u: StaffRow; onChanged: () => void }) {
  const t = useTheme();
  const whs = useWarehouses();
  const [pw, setPw] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(u.full_name);
  const [loginId, setLoginId] = useState(u.login_id);
  const [phone, setPhone] = useState(u.phone ?? '');
  const [wh, setWh] = useState<string | null>(u.warehouse_id);
  const fail = (e: unknown) => notify('Not saved', e instanceof Error ? e.message : String(e));
  const isOwner = u.role === 'OWNER';

  const showPassword = async () => {
    if (pw) { setPw(null); return; }
    try {
      const v = await rpc<string | null>('owner_staff_password', { p_user: u.id });
      if (!v) notify('Password not saved', 'This password was set before passwords were kept. Use "Reset password" to set a new one you can see.');
      else setPw(v);
    } catch (e) { fail(e); }
  };

  const reset = useMutation({
    mutationFn: () => edge<{ password: string; loginId: string; fullName: string; phone: string | null }>('admin-users', { action: 'set_password', userId: u.id }),
    onSuccess: (r) => { setPw(r.password); onChanged(); },
    onError: fail,
  });
  const doReset = async () => {
    if (await confirmAsk(`Reset password for ${u.full_name}?`, 'A new password is made now; the old one stops working.', 'Reset')) reset.mutate();
  };
  const save = useMutation({
    mutationFn: () => edge('admin-users', {
      action: 'update_profile', userId: u.id, fullName: name.trim(), loginId: loginId.trim(), phone: phone.trim(),
      ...(u.role === 'EMPLOYEE' ? { primaryWarehouseId: wh } : {}),
    }),
    onSuccess: () => { setEditing(false); onChanged(); notify('Saved', loginId.trim() !== u.login_id ? `${u.full_name} now logs in as "${loginId.trim()}".` : undefined); },
    onError: fail,
  });
  const toggle = () => edge('admin-users', { action: 'set_active', userId: u.id, active: !u.is_active }).then(onChanged, fail);
  const remove = async () => {
    if (await confirmAsk(`Remove ${u.full_name}?`, 'They can no longer log in. Their sales, purchases and attendance history are kept. You can restore them later.', 'Remove')) {
      edge('admin-users', { action: 'remove', userId: u.id }).then(onChanged, fail);
    }
  };

  const shift = u.last_shift;
  const shiftText = !shift ? 'No clock-in yet'
    : !shift.clock_out_at ? `🟢 Clocked in since ${dateTimeIST(shift.clock_in_at)}`
    : `Last shift ${dateTimeIST(shift.clock_in_at)} → ${timeIST(shift.clock_out_at)}`;

  return (
    <View style={{ borderWidth: 0.5, borderColor: t.border, borderRadius: 10, padding: 12, gap: 8 }}>
      <View style={{ flexDirection: 'row', gap: 8, alignItems: 'flex-start' }}>
        <View style={{ flex: 1, gap: 2 }}>
          <Text style={{ color: t.text, fontSize: 16, fontWeight: '700' }}>{u.full_name}</Text>
          <Text style={{ color: t.textSecondary }}>User ID: <Text style={{ fontWeight: '700', color: t.text }} selectable>{u.login_id}</Text></Text>
          <Text style={{ color: t.textMuted, fontSize: 12 }}>
            {u.role === 'EMPLOYEE' ? u.warehouse_name ?? '—' : u.role === 'OWNER' ? 'Owner · all warehouses' : 'Admin · all warehouses'}
            {u.phone ? ` · ${u.phone}` : ''} · last login {u.last_sign_in_at ? dateTimeIST(u.last_sign_in_at) : 'never'}
          </Text>
          {!isOwner ? <Text style={{ color: t.textSecondary, fontSize: 12 }}>{shiftText}</Text> : null}
        </View>
        <Text style={{ color: u.is_active ? t.good : t.danger, fontWeight: '700' }}>{u.is_active ? u.role : 'DISABLED'}</Text>
      </View>

      {!isOwner ? (
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
          <Text style={{ color: t.textSecondary }}>Password:</Text>
          <Text selectable style={{ color: t.text, fontWeight: '700', fontFamily: 'monospace' }}>
            {pw ?? (u.has_saved_password ? '••••••••••' : 'not saved')}
          </Text>
          <SmallButton title={pw ? 'Hide' : 'Show'} onPress={() => void showPassword()} />
          {pw ? <SmallButton title="Send on WhatsApp" onPress={() => void openWhatsApp(u.phone, loginMessage(u.full_name, u.login_id, pw))} /> : null}
        </View>
      ) : null}

      {editing ? (
        <View style={{ gap: 8 }}>
          <Field label="Name" value={name} onChangeText={setName} />
          <Field label="User ID (what they type to log in)" value={loginId} onChangeText={setLoginId} autoCapitalize="none" />
          <Field label="Mobile (for WhatsApp)" value={phone} onChangeText={setPhone} keyboardType="phone-pad" maxLength={14} />
          {u.role === 'EMPLOYEE' ? (
            <>
              <Label>Warehouse</Label>
              <Chips options={(whs.data ?? []).map((w) => w.id)} value={wh} onChange={setWh} format={(v) => whs.data?.find((w) => w.id === v)?.name ?? v} />
            </>
          ) : null}
          <Toolbar>
            <SmallButton title="Save" kind="primary" onPress={() => save.mutate()} disabled={save.isPending || !name.trim() || !/^[A-Za-z0-9._-]{3,32}$/.test(loginId.trim())} />
            <SmallButton title="Cancel" onPress={() => { setEditing(false); setName(u.full_name); setLoginId(u.login_id); setPhone(u.phone ?? ''); setWh(u.warehouse_id); }} />
          </Toolbar>
        </View>
      ) : (
        <Toolbar>
          <SmallButton title="✎ Edit name / ID" onPress={() => setEditing(true)} />
          {!isOwner ? <SmallButton title={reset.isPending ? 'Resetting…' : '🔑 Reset password'} onPress={() => void doReset()} disabled={reset.isPending} /> : null}
          {!isOwner ? <SmallButton title={u.is_active ? 'Disable login' : 'Enable login'} onPress={() => void toggle()} /> : null}
          {!isOwner ? <SmallButton title="Remove" kind="danger" onPress={() => void remove()} /> : null}
        </Toolbar>
      )}
    </View>
  );
}

function AddStaff({ onCreated }: { onCreated: () => void }) {
  const whs = useWarehouses();
  const [loginId, setLoginId] = useState('');
  const [fullName, setFullName] = useState('');
  const [phone, setPhone] = useState('');
  const [role, setRole] = useState<'EMPLOYEE' | 'ADMIN'>('EMPLOYEE');
  const [wh, setWh] = useState<string | null>(null);
  const [password, setPassword] = useState('');
  const [created, setCreated] = useState<{ name: string; loginId: string; password: string; phone: string } | null>(null);

  const create = useMutation({
    mutationFn: async () => {
      const body = { action: 'create', loginId: loginId.trim(), fullName: fullName.trim(), role, password, phone: phone.trim() || undefined,
        primaryWarehouseId: role === 'EMPLOYEE' ? wh : undefined };
      try {
        return await edge('admin-users', body);
      } catch (e) {
        // Same name or mobile already has a login → ask before making a second one.
        const dup = (e as { details?: { error?: string; duplicates?: { login_id: string; full_name: string; phone: string | null }[] } }).details;
        if (dup?.error !== 'duplicate') throw e;
        const list = (dup.duplicates ?? []).map((d) => `${d.full_name} (${d.login_id}${d.phone ? `, ${d.phone}` : ''})`).join(', ');
        if (!(await confirmAsk('Already has a login?', `Existing: ${list}. Create another login anyway?`, 'Create anyway'))) throw new Error('Not created — the person already has a login.');
        return edge('admin-users', { ...body, force: true });
      }
    },
    onSuccess: () => {
      setCreated({ name: fullName.trim(), loginId: loginId.trim(), password, phone: phone.trim() });
      setLoginId(''); setFullName(''); setPassword(''); setPhone('');
      onCreated();
    },
    onError: (e) => notify('Login not created', e instanceof Error ? e.message : String(e)),
  });
  const pwOk = password.length >= 8 && !/^\s|\s$/.test(password);

  return (
    <Card title="Add employee">
      {created ? (
        <View style={{ gap: 6 }}>
          <Label>✓ {created.name} can now log in — User ID “{created.loginId}”, password “{created.password}”.</Label>
          <Toolbar>
            <SmallButton title="Send login on WhatsApp" kind="primary"
              onPress={() => void openWhatsApp(created.phone, loginMessage(created.name, created.loginId, created.password))} />
            <SmallButton title="Done" onPress={() => setCreated(null)} />
          </Toolbar>
        </View>
      ) : null}
      <Field label="Full name" value={fullName} onChangeText={setFullName} placeholder="e.g. Suresh Kumar" />
      <Field label="User ID (what they type)" value={loginId} onChangeText={setLoginId} autoCapitalize="none" placeholder="e.g. suresh.ctr" />
      <Field label="Mobile (for WhatsApp, optional)" value={phone} onChangeText={setPhone} keyboardType="phone-pad" maxLength={14} />
      <Chips options={['EMPLOYEE', 'ADMIN'] as const} value={role} onChange={setRole} format={(r) => (r === 'EMPLOYEE' ? 'Employee' : 'Admin (sees everything)')} />
      {role === 'EMPLOYEE' ? (
        <>
          <Label>Warehouse</Label>
          <Chips options={(whs.data ?? []).map((w) => w.id)} value={wh} onChange={setWh} format={(v) => whs.data?.find((w) => w.id === v)?.name ?? v} />
        </>
      ) : null}
      <View style={{ flexDirection: 'row', gap: 8, alignItems: 'flex-end' }}>
        <Field label="Password (at least 8 characters, easy to type)" value={password} onChangeText={setPassword} autoCapitalize="none" />
        <SmallButton title="Make one" onPress={() => setPassword(generatePassword())} />
      </View>
      <Button title="Create login" onPress={() => create.mutate()} busy={create.isPending}
        disabled={!/^[A-Za-z0-9._-]{3,32}$/.test(loginId.trim()) || !fullName.trim() || !pwOk || (role === 'EMPLOYEE' && !wh)} />
    </Card>
  );
}

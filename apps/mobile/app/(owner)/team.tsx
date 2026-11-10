/**
 * Owner: staff logins, own Admin Override PIN, and WhatsApp delivery status.
 * Creating logins / passwords goes through the `admin-users` Edge Function
 * (Supabase Auth admin API never ships in the app).
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Alert } from 'react-native';
import { edge, q, rpc } from '../../src/api/client';
import type { Warehouse } from '../../src/api/types';
import { Button, Card, Chips, Field, Label, Row, Screen } from '../../src/components/ui';
import { supabase } from '../../src/lib/supabase';

interface StaffRow { id: string; login_id: string; full_name: string; role: string; is_active: boolean; warehouse_code: string | null; last_sign_in_at: string | null; has_override_pin: boolean }
interface OutboxRow { id: number; event_type: string; status: string; attempts: number; last_error: string | null; created_at: string }

export default function Team() {
  const qc = useQueryClient();
  const users = useQuery({ queryKey: ['users'], queryFn: () => rpc<StaffRow[]>('owner_list_users') });
  const whs = useQuery({ queryKey: ['warehouses'], queryFn: () => q<Warehouse[]>(supabase.from('warehouses').select('id, code, name, state_code').order('code')) });
  const outbox = useQuery({ queryKey: ['outbox'], queryFn: () => rpc<OutboxRow[]>('owner_notifications', { p_limit: 10 }) });

  const [loginId, setLoginId] = useState('');
  const [fullName, setFullName] = useState('');
  const [role, setRole] = useState<'EMPLOYEE' | 'ADMIN'>('EMPLOYEE');
  const [wh, setWh] = useState<string | null>(null);
  const [password, setPassword] = useState('');
  const [pin, setPin] = useState('');
  const refresh = () => void qc.invalidateQueries({ queryKey: ['users'] });
  const fail = (e: unknown) => Alert.alert('Not saved', e instanceof Error ? e.message : String(e));

  const create = useMutation({
    mutationFn: () => edge('admin-users', {
      action: 'create', loginId: loginId.trim(), fullName: fullName.trim(), role, password,
      primaryWarehouseId: whs.data?.find((w) => w.code === wh)?.id,
    }),
    onSuccess: () => { Alert.alert('Login created', `User ID: ${loginId}`); setLoginId(''); setFullName(''); setPassword(''); refresh(); },
    onError: fail,
  });
  const toggle = useMutation({
    mutationFn: (u: StaffRow) => edge('admin-users', { action: 'set_active', userId: u.id, active: !u.is_active }),
    onSuccess: refresh, onError: fail,
  });
  const resetPw = (u: StaffRow) => Alert.prompt?.('New password', `For ${u.login_id} (min 10 chars, letters + digits)`, (pw) => {
    if (pw) edge('admin-users', { action: 'set_password', userId: u.id, password: pw }).then(() => Alert.alert('Password changed'), fail);
  });
  const savePin = useMutation({
    mutationFn: () => rpc('owner_set_override_pin', { p_pin: pin }),
    onSuccess: () => { setPin(''); refresh(); Alert.alert('Override PIN saved'); }, onError: fail,
  });

  return (
    <Screen>
      <Card title="Staff logins">
        {users.data?.map((u) => (
          <Card key={u.id}>
            <Row left={`${u.full_name} (${u.login_id})`} right={u.is_active ? u.role : 'DISABLED'}
              sub={`${u.warehouse_code ?? 'All warehouses'} · last login ${u.last_sign_in_at?.slice(0, 10) ?? 'never'}${u.has_override_pin ? ' · PIN set' : ''}`} />
            <Button title={u.is_active ? 'Disable login' : 'Enable login'} kind="secondary" onPress={() => toggle.mutate(u)} />
            <Button title="Reset password" kind="secondary" onPress={() => resetPw(u)} />
          </Card>
        ))}
      </Card>

      <Card title="Add staff login">
        <Field label="User ID (what they type)" value={loginId} onChangeText={setLoginId} autoCapitalize="none" placeholder="e.g. suresh.wha" />
        <Field label="Full name" value={fullName} onChangeText={setFullName} />
        <Chips options={['EMPLOYEE', 'ADMIN'] as const} value={role} onChange={setRole} />
        {role === 'EMPLOYEE' ? <><Label>Warehouse</Label><Chips options={(whs.data ?? []).map((w) => w.code)} value={wh} onChange={setWh} /></> : null}
        <Field label="Temporary password" value={password} onChangeText={setPassword} secureTextEntry />
        <Button title="Create login" onPress={() => create.mutate()} busy={create.isPending}
          disabled={!loginId || !fullName || password.length < 10 || (role === 'EMPLOYEE' && !wh)} />
      </Card>

      <Card title="My Admin Override PIN">
        <Label muted>Staff need this PIN to dispatch more than the physical stock. 6–8 digits.</Label>
        <Field label="New PIN" value={pin} onChangeText={setPin} keyboardType="number-pad" secureTextEntry maxLength={8} />
        <Button title="Save PIN" onPress={() => savePin.mutate()} busy={savePin.isPending} disabled={!/^\d{6,8}$/.test(pin)} />
      </Card>

      <Card title="WhatsApp alerts (latest)">
        {outbox.data?.map((o) => (
          <Row key={o.id} left={o.event_type.replace('_', ' ').toLowerCase()} sub={o.last_error ?? o.created_at.slice(0, 16).replace('T', ' ')}
            right={o.status} />
        ))}
        {!outbox.data?.length ? <Label muted>No alerts yet</Label> : null}
      </Card>
    </Screen>
  );
}

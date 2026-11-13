/**
 * "My account" for everyone: change my password, app PIN on this device, lock now, switch user.
 */
import { useMutation } from '@tanstack/react-query';
import { useState } from 'react';
import { Text, View } from 'react-native';
import { edge } from '../api/client';
import { useAuth } from '../auth/store';
import { clearPin, deviceName, hasPin, setPin } from '../lib/device';
import { notify } from '../lib/dialogs';
import { useTheme } from '../theme';
import { Button, Card, Field, Label, SmallButton, Toolbar } from './ui';

export function MyAccount() {
  const t = useTheme();
  const user = useAuth((s) => s.user)!;
  const access = useAuth((s) => s.access);
  const lock = useAuth((s) => s.lock);
  const signOut = useAuth((s) => s.signOut);
  const [open, setOpen] = useState<'pw' | 'pin' | null>(null);
  const [cur, setCur] = useState('');
  const [next, setNext] = useState('');
  const [again, setAgain] = useState('');
  const [pin, setPinV] = useState('');
  const [pin2, setPin2] = useState('');
  const [, force] = useState(0);
  const pinOn = hasPin(user.id);

  const change = useMutation({
    mutationFn: () => edge('account', { action: 'change_password', currentPassword: cur, newPassword: next }),
    onSuccess: () => { setCur(''); setNext(''); setAgain(''); setOpen(null); notify('Password changed', 'Use the new password next time you log in.'); },
    onError: (e) => notify('Not changed', e instanceof Error ? e.message : String(e)),
  });
  const pwProblem = !next ? null : next.length < 8 ? 'At least 8 characters' : /^\s|\s$/.test(next) ? 'No space at the start or end' : null;

  return (
    <Card title="My account" icon="person-circle-outline" subtitle={`${user.fullName} · User ID ${user.loginId} · ${deviceName()}`}>
      <Toolbar>
        <SmallButton title="Change my password" icon="key-outline" kind={open === 'pw' ? 'primary' : 'secondary'} onPress={() => setOpen(open === 'pw' ? null : 'pw')} />
        <SmallButton title={pinOn ? 'App PIN: on' : 'Set app PIN'} icon="keypad-outline" kind={open === 'pin' ? 'primary' : 'secondary'} onPress={() => setOpen(open === 'pin' ? null : 'pin')} />
        <SmallButton title="Lock now" icon="lock-closed-outline" onPress={lock} />
        <SmallButton title="Switch user" icon="people-outline" onPress={() => void signOut()} />
      </Toolbar>
      {access?.idle_minutes ? <Label muted>The app locks itself after {access.idle_minutes} minutes without use.</Label> : null}

      {open === 'pw' ? (
        <View style={{ gap: 10 }}>
          <Field label="Current password" value={cur} onChangeText={setCur} secureTextEntry autoCapitalize="none" />
          <Field label="New password (at least 8 characters)" value={next} onChangeText={setNext} secureTextEntry autoCapitalize="none" error={pwProblem ?? undefined} />
          <Field label="New password again" value={again} onChangeText={setAgain} secureTextEntry autoCapitalize="none"
            error={again && again !== next ? 'Does not match' : undefined} />
          <Button title="Change password" icon="checkmark" onPress={() => change.mutate()} busy={change.isPending}
            disabled={!cur || !next || !!pwProblem || next !== again} />
        </View>
      ) : null}

      {open === 'pin' ? (
        <View style={{ gap: 10 }}>
          <Text style={{ color: t.textSecondary }}>
            An app PIN unlocks the app on this device after it locks, instead of typing the full password. It works only on {deviceName()}.
          </Text>
          {pinOn ? (
            <Button title="Remove app PIN" kind="secondary" onPress={() => { clearPin(); force((x) => x + 1); notify('App PIN removed'); }} />
          ) : (
            <>
              <Field label="New PIN (4–6 digits)" value={pin} onChangeText={(v) => setPinV(v.replace(/\D/g, ''))} keyboardType="number-pad" secureTextEntry maxLength={6} />
              <Field label="PIN again" value={pin2} onChangeText={(v) => setPin2(v.replace(/\D/g, ''))} keyboardType="number-pad" secureTextEntry maxLength={6}
                error={pin2 && pin2 !== pin ? 'Does not match' : undefined} />
              <Button title="Save app PIN" icon="checkmark" disabled={!/^\d{4,6}$/.test(pin) || pin !== pin2}
                onPress={() => void setPin(user.id, pin).then(() => { setPinV(''); setPin2(''); setOpen(null); force((x) => x + 1); notify('App PIN saved', 'Use it to unlock the app on this device.'); })} />
            </>
          )}
        </View>
      ) : null}
    </Card>
  );
}

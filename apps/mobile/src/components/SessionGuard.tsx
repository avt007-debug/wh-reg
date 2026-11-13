/**
 * Runs while someone is logged in:
 *  - asks the server every 2 minutes (and when the app comes back to the screen) whether this person may
 *    still use the app on this device — disabled, removed, new password, "log out everywhere", login hours;
 *  - locks the app after the inactivity time the owner set (PIN or password to continue);
 *  - shows the lock screen.
 */
import Ionicons from '@expo/vector-icons/Ionicons';
import { useEffect, useRef, useState } from 'react';
import { AppState, Modal, Platform, Pressable, Text, View } from 'react-native';
import { useAuth } from '../auth/store';
import { checkPin, hasPin } from '../lib/device';
import { loginEmail, supabase } from '../lib/supabase';
import { useTheme } from '../theme';
import { Button, Field, pageBg } from './ui';

export function SessionGuard() {
  const user = useAuth((s) => s.user);
  const access = useAuth((s) => s.access);
  const check = useAuth((s) => s.check);
  const lock = useAuth((s) => s.lock);
  const locked = useAuth((s) => s.locked);
  const last = useRef(Date.now());

  // server check: every 2 minutes + whenever the app is shown again
  useEffect(() => {
    if (!user) return;
    const id = setInterval(() => void check(), 120_000);
    const onShow = () => { if (Platform.OS !== 'web' || document.visibilityState === 'visible') void check(); };
    let sub: { remove: () => void } | null = null;
    if (Platform.OS === 'web') document.addEventListener('visibilitychange', onShow);
    else sub = AppState.addEventListener('change', (s) => { if (s === 'active') onShow(); });
    return () => { clearInterval(id); if (Platform.OS === 'web') document.removeEventListener('visibilitychange', onShow); sub?.remove(); };
  }, [user, check]);

  // inactivity lock
  const idle = Number(access?.idle_minutes ?? 0);
  useEffect(() => {
    if (!user || !idle) return;
    last.current = Date.now();
    const bump = () => { last.current = Date.now(); };
    const evs = ['pointerdown', 'keydown', 'wheel', 'touchstart'];
    if (Platform.OS === 'web') evs.forEach((e) => window.addEventListener(e, bump, { capture: true, passive: true }));
    let bg = 0;
    const sub = Platform.OS === 'web' ? null : AppState.addEventListener('change', (s) => {
      if (s !== 'active') bg = Date.now();
      else if (bg && Date.now() - bg > idle * 60_000) lock();
    });
    const id = setInterval(() => { if (Date.now() - last.current > idle * 60_000) lock(); }, 20_000);
    return () => { clearInterval(id); if (Platform.OS === 'web') evs.forEach((e) => window.removeEventListener(e, bump, { capture: true })); sub?.remove(); };
  }, [user, idle, lock]);

  return user && locked ? <LockScreen /> : null;
}

function LockScreen() {
  const t = useTheme();
  const user = useAuth((s) => s.user)!;
  const unlock = useAuth((s) => s.unlock);
  const signOut = useAuth((s) => s.signOut);
  const [usePin, setUsePin] = useState(hasPin(user.id));
  const [value, setValue] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const go = async () => {
    setBusy(true); setErr(null);
    try {
      if (usePin) {
        const ok = await checkPin(user.id, value);
        if (ok) { setValue(''); unlock(); return; }
        if (ok === null) { setUsePin(false); setErr('Too many wrong PINs. Enter your password instead.'); }
        else setErr('Wrong PIN');
      } else {
        const { error } = await supabase.auth.signInWithPassword({ email: loginEmail(user.loginId), password: value.trim() });
        if (error) setErr('Wrong password'); else { setValue(''); unlock(); return; }
      }
      setValue('');
    } finally { setBusy(false); }
  };

  return (
    <Modal visible animationType="fade" onRequestClose={() => undefined}>
      <View style={[{ flex: 1, alignItems: 'center', justifyContent: 'center', padding: 24 }, pageBg(t)]}>
        <View style={{ width: '100%', maxWidth: 380, gap: 14, alignItems: 'stretch' }}>
          <View style={{ alignItems: 'center', gap: 6 }}>
            <View style={{ width: 64, height: 64, borderRadius: 32, backgroundColor: t.accent, alignItems: 'center', justifyContent: 'center', borderWidth: 3, borderColor: t.yellow }}>
              <Ionicons name="lock-closed" size={28} color={t.yellow} />
            </View>
            <Text style={{ color: t.text, fontSize: 20, fontWeight: '800' }}>Locked</Text>
            <Text style={{ color: t.textSecondary, textAlign: 'center' }}>{user.fullName} · locked after no use for a while</Text>
          </View>
          <Field label={usePin ? 'App PIN' : 'Password'} value={value} onChangeText={setValue} secureTextEntry autoFocus
            keyboardType={usePin ? 'number-pad' : 'default'} maxLength={usePin ? 6 : 72} autoCapitalize="none" error={err ?? undefined}
            onSubmitEditing={() => void go()} />
          <Button title="Unlock" icon="lock-open-outline" onPress={() => void go()} busy={busy} disabled={!value} />
          {hasPin(user.id) ? (
            <Pressable onPress={() => { setUsePin(!usePin); setValue(''); setErr(null); }}>
              <Text style={{ color: t.accent, textAlign: 'center', fontWeight: '600' }}>{usePin ? 'Use password instead' : 'Use app PIN instead'}</Text>
            </Pressable>
          ) : null}
          <Button title="Switch user / Log out" kind="secondary" icon="people-outline" onPress={() => void signOut()} />
        </View>
      </View>
    </Modal>
  );
}

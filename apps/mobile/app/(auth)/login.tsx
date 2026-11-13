import { useState } from 'react';
import Ionicons from '@expo/vector-icons/Ionicons';
import { Pressable, Text, View } from 'react-native';
import { edge } from '../../src/api/client';
import { useAuth } from '../../src/auth/store';
import { Button, Field, glass, Notice, Screen, ThemeSwitch } from '../../src/components/ui';
import { forgetId, recentIds } from '../../src/lib/device';
import { versionLabel } from '../../src/lib/version';
import { useTheme } from '../../src/theme';

export default function Login() {
  const t = useTheme();
  const signIn = useAuth((s) => s.signIn);
  const notice = useAuth((s) => s.notice);
  const [ids, setIds] = useState<string[]>(() => recentIds());
  const [loginId, setLoginId] = useState(() => recentIds()[0] ?? '');
  const [password, setPassword] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [show, setShow] = useState(false);
  const [recover, setRecover] = useState(false);

  async function submit() {
    if (!loginId.trim() || !password.trim()) return;
    setBusy(true); setErr(null);
    try {
      // spaces copied by mistake around the ID or password are removed; the ID ignores capitals
      await signIn(loginId.trim().toLowerCase(), password.trim());   // root gate routes to owner or staff area by role
    } catch (e) {
      const m = e instanceof Error ? e.message : '';
      setErr(/invalid/i.test(m)
        ? 'Wrong User ID or password. Check the spelling (passwords are case-sensitive) or ask the owner to reset it in Settings.'
        : m || 'Cannot reach server. Check Wi-Fi / data.');
    } finally { setBusy(false); }
  }

  const card = [{ backgroundColor: t.card, borderColor: t.border, borderWidth: 1, borderRadius: 18, padding: 18, gap: 14 }, glass(t, 22),
    t.glass ? ({ boxShadow: `0 10px 40px ${t.shadow}` } as object) : null];

  return (
    <Screen>
      <View style={{ width: '100%', maxWidth: 420, alignSelf: 'center', gap: 14, marginTop: 50 }}>
        <View style={{ alignItems: 'flex-end' }}><View style={{ width: 220 }}><ThemeSwitch /></View></View>
        <View style={{ alignItems: 'center', gap: 8, marginBottom: 6 }}>
          <View style={{ width: 68, height: 68, borderRadius: 20, backgroundColor: t.accent, alignItems: 'center', justifyContent: 'center', borderWidth: 3, borderColor: t.yellow }}>
            <Ionicons name="cube" size={32} color={t.yellow} />
          </View>
          <Text style={{ color: t.text, fontSize: 28, fontWeight: '800' }}>WH Reg</Text>
          <Text style={{ color: t.textSecondary, textAlign: 'center' }}>Stock, sales, purchases and payments for your warehouses</Text>
        </View>
        {notice ? <Notice tone="warning" icon="information-circle-outline">{notice}</Notice> : null}
        {recover ? <Recover onDone={(id) => { setRecover(false); setLoginId(id); setErr(null); }} style={card} /> : (
          <View style={card}>
            {ids.length ? (
              <View style={{ gap: 6 }}>
                <Text style={{ color: t.textSecondary, fontSize: 12.5 }}>Used on this phone — tap to pick</Text>
                <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
                  {ids.map((id) => (
                    <View key={id} style={{ flexDirection: 'row', alignItems: 'center', borderRadius: 999, borderWidth: 1,
                      borderColor: id === loginId ? t.accent : t.border, backgroundColor: id === loginId ? t.accentSoft : 'transparent' }}>
                      <Pressable onPress={() => setLoginId(id)} style={{ paddingLeft: 12, paddingRight: 6, paddingVertical: 7 }}>
                        <Text style={{ color: t.text, fontWeight: '700' }}>{id}</Text>
                      </Pressable>
                      <Pressable onPress={() => { forgetId(id); setIds(recentIds()); if (loginId === id) setLoginId(''); }}
                        accessibilityLabel={`Forget ${id}`} style={{ paddingRight: 10, paddingVertical: 7 }}>
                        <Ionicons name="close" size={14} color={t.textMuted} />
                      </Pressable>
                    </View>
                  ))}
                </View>
              </View>
            ) : null}
            <Field label="User ID" value={loginId} onChangeText={setLoginId} autoCapitalize="none" autoCorrect={false} placeholder="e.g. ravi" />
            <Field label="Password" value={password} onChangeText={setPassword} secureTextEntry={!show} autoCapitalize="none" autoCorrect={false}
              error={err ?? undefined} onSubmitEditing={submit} autoFocus={!!loginId} />
            <Pressable onPress={() => setShow((v) => !v)} style={{ flexDirection: 'row', alignItems: 'center', gap: 6, alignSelf: 'flex-start' }} accessibilityRole="checkbox" accessibilityState={{ checked: show }}>
              <Ionicons name={show ? 'eye-off-outline' : 'eye-outline'} size={18} color={t.textSecondary} />
              <Text style={{ color: t.textSecondary }}>{show ? 'Hide password' : 'Show password'}</Text>
            </Pressable>
            <Button title="Log in" icon="log-in-outline" onPress={submit} busy={busy} disabled={!loginId.trim() || !password.trim()} />
          </View>
        )}
        <Text style={{ color: t.textMuted, textAlign: 'center', fontSize: 12.5 }}>Employees: forgot your password? Ask the owner to reset it from Settings.</Text>
        {!recover ? (
          <Pressable onPress={() => setRecover(true)} style={{ alignSelf: 'center' }}>
            <Text style={{ color: t.accent, fontWeight: '700' }}>Owner: forgot password? Use a recovery code</Text>
          </Pressable>
        ) : null}
        <Text style={{ color: t.textMuted, textAlign: 'center', fontSize: 11 }}>Version {versionLabel()}</Text>
      </View>
    </Screen>
  );
}

function Recover({ onDone, style }: { onDone: (id: string) => void; style: object }) {
  const t = useTheme();
  const [id, setId] = useState('owner');
  const [code, setCode] = useState('');
  const [pw, setPw] = useState('');
  const [pw2, setPw2] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const [ok, setOk] = useState(false);
  const [busy, setBusy] = useState(false);
  async function go() {
    if (pw.length < 8) return setErr('New password: at least 8 characters');
    if (pw !== pw2) return setErr('The two new passwords do not match');
    setBusy(true); setErr(null);
    try {
      await edge('account', { action: 'recover', loginId: id.trim().toLowerCase(), code: code.trim(), newPassword: pw });
      setOk(true);
    } catch (e) { setErr(e instanceof Error ? e.message : 'Could not reset'); } finally { setBusy(false); }
  }
  return (
    <View style={style}>
      <Text style={{ color: t.text, fontSize: 18, fontWeight: '800' }}>Reset owner password</Text>
      {ok ? (
        <>
          <Notice tone="good" icon="checkmark-circle-outline">Password changed. That recovery code is now used up. Log in with the new password; every other device was logged out.</Notice>
          <Button title="Back to log in" icon="log-in-outline" onPress={() => onDone(id.trim().toLowerCase())} />
        </>
      ) : (
        <>
          <Text style={{ color: t.textSecondary }}>Use one of the recovery codes you saved from Settings → Security. Each code works once.</Text>
          <Field label="Owner User ID" value={id} onChangeText={setId} autoCapitalize="none" autoCorrect={false} />
          <Field label="Recovery code" value={code} onChangeText={setCode} autoCapitalize="characters" autoCorrect={false} placeholder="XXXX-XXXX" />
          <Field label="New password (8+ characters)" value={pw} onChangeText={setPw} secureTextEntry autoCapitalize="none" />
          <Field label="New password again" value={pw2} onChangeText={setPw2} secureTextEntry autoCapitalize="none" error={err ?? undefined} onSubmitEditing={go} />
          <Button title="Set new password" icon="key-outline" onPress={go} busy={busy} disabled={!id.trim() || !code.trim() || !pw} />
          <Button title="Cancel" kind="secondary" onPress={() => onDone(id.trim().toLowerCase())} />
        </>
      )}
    </View>
  );
}

import { useState } from 'react';
import Ionicons from '@expo/vector-icons/Ionicons';
import { Pressable, Text, View } from 'react-native';
import { useAuth } from '../../src/auth/store';
import { Button, Field, glass, Screen, ThemeSwitch } from '../../src/components/ui';
import { useTheme } from '../../src/theme';

export default function Login() {
  const t = useTheme();
  const signIn = useAuth((s) => s.signIn);
  const [loginId, setLoginId] = useState('');
  const [password, setPassword] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [show, setShow] = useState(false);

  async function submit() {
    setBusy(true); setErr(null);
    try {
      // spaces copied by mistake around the ID or password are removed; the ID ignores capitals
      await signIn(loginId.trim(), password.trim());   // root gate routes to owner or staff area by role
    } catch (e) {
      const m = e instanceof Error ? e.message : '';
      setErr(/invalid/i.test(m)
        ? 'Wrong User ID or password. Check the spelling (passwords are case-sensitive) or ask the owner to reset it in Settings.'
        : m || 'Cannot reach server. Check Wi-Fi / data.');
    } finally { setBusy(false); }
  }

  return (
    <Screen>
      <View style={{ width: '100%', maxWidth: 420, alignSelf: 'center', gap: 14, marginTop: 60 }}>
        <View style={{ alignItems: 'flex-end' }}><View style={{ width: 220 }}><ThemeSwitch /></View></View>
        <View style={{ alignItems: 'center', gap: 8, marginBottom: 6 }}>
          <View style={{ width: 68, height: 68, borderRadius: 20, backgroundColor: t.accent, alignItems: 'center', justifyContent: 'center', borderWidth: 3, borderColor: t.yellow }}>
            <Ionicons name="cube" size={32} color={t.yellow} />
          </View>
          <Text style={{ color: t.text, fontSize: 28, fontWeight: '800' }}>WH Reg</Text>
          <Text style={{ color: t.textSecondary, textAlign: 'center' }}>Stock, sales, purchases and payments for your warehouses</Text>
        </View>
        <View style={[{ backgroundColor: t.card, borderColor: t.border, borderWidth: 1, borderRadius: 18, padding: 18, gap: 14 }, glass(t, 22),
          t.glass ? ({ boxShadow: `0 10px 40px ${t.shadow}` } as object) : null]}>
          <Field label="User ID" value={loginId} onChangeText={setLoginId} autoCapitalize="none" autoCorrect={false} placeholder="e.g. ravi" />
          <Field label="Password" value={password} onChangeText={setPassword} secureTextEntry={!show} autoCapitalize="none" autoCorrect={false}
            error={err ?? undefined} onSubmitEditing={submit} />
          <Pressable onPress={() => setShow((v) => !v)} style={{ flexDirection: 'row', alignItems: 'center', gap: 6, alignSelf: 'flex-start' }} accessibilityRole="checkbox" accessibilityState={{ checked: show }}>
            <Ionicons name={show ? 'eye-off-outline' : 'eye-outline'} size={18} color={t.textSecondary} />
            <Text style={{ color: t.textSecondary }}>{show ? 'Hide password' : 'Show password'}</Text>
          </Pressable>
          <Button title="Log in" icon="log-in-outline" onPress={submit} busy={busy} disabled={!loginId.trim() || password.trim().length < 6} />
        </View>
        <Text style={{ color: t.textMuted, textAlign: 'center', fontSize: 12.5 }}>Forgot your password? Ask the owner to reset it from Settings.</Text>
      </View>
    </Screen>
  );
}

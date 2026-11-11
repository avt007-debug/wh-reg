import { useState } from 'react';
import Ionicons from '@expo/vector-icons/Ionicons';
import { Text, View } from 'react-native';
import { useAuth } from '../../src/auth/store';
import { Button, Field, Screen, ThemeSwitch } from '../../src/components/ui';
import { useTheme } from '../../src/theme';

export default function Login() {
  const t = useTheme();
  const signIn = useAuth((s) => s.signIn);
  const [loginId, setLoginId] = useState('');
  const [password, setPassword] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit() {
    setBusy(true); setErr(null);
    try {
      await signIn(loginId, password);        // root gate routes to owner or staff area by role
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Cannot reach server. Check Wi-Fi / data.');
    } finally { setBusy(false); }
  }

  return (
    <Screen>
      <View style={{ width: '100%', maxWidth: 420, alignSelf: 'center', gap: 14, marginTop: 60 }}>
        <View style={{ alignItems: 'flex-end' }}><View style={{ width: 220 }}><ThemeSwitch /></View></View>
        <View style={{ alignItems: 'center', gap: 8, marginBottom: 6 }}>
          <View style={{ width: 64, height: 64, borderRadius: 18, backgroundColor: t.accent, alignItems: 'center', justifyContent: 'center' }}>
            <Ionicons name="cube" size={32} color="#fff" />
          </View>
          <Text style={{ color: t.text, fontSize: 28, fontWeight: '800' }}>WH Reg</Text>
          <Text style={{ color: t.textSecondary, textAlign: 'center' }}>Stock, sales, purchases and payments for your warehouses</Text>
        </View>
        <View style={{ backgroundColor: t.card, borderColor: t.border, borderWidth: 1, borderRadius: 16, padding: 18, gap: 14 }}>
          <Field label="User ID" value={loginId} onChangeText={setLoginId} autoCapitalize="none" autoCorrect={false} placeholder="e.g. ravi" />
          <Field label="Password" value={password} onChangeText={setPassword} secureTextEntry error={err ?? undefined} onSubmitEditing={submit} />
          <Button title="Log in" icon="log-in-outline" onPress={submit} busy={busy} disabled={!loginId || password.length < 6} />
        </View>
        <Text style={{ color: t.textMuted, textAlign: 'center', fontSize: 12.5 }}>Forgot your password? Ask the owner to reset it from Settings.</Text>
      </View>
    </Screen>
  );
}

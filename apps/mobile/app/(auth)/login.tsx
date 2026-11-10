import { useState } from 'react';
import { Text } from 'react-native';
import { useAuth } from '../../src/auth/store';
import { Button, Field, Screen } from '../../src/components/ui';
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
      <Text style={{ color: t.text, fontSize: 28, fontWeight: '800', marginTop: 80 }}>WH Reg</Text>
      <Text style={{ color: t.textSecondary, marginBottom: 24 }}>Inventory & Dispatch</Text>
      <Field label="User ID" value={loginId} onChangeText={setLoginId} autoCapitalize="none" autoCorrect={false} />
      <Field label="Password" value={password} onChangeText={setPassword} secureTextEntry error={err ?? undefined} onSubmitEditing={submit} />
      <Button title="Log in" onPress={submit} busy={busy} disabled={!loginId || password.length < 6} />
    </Screen>
  );
}

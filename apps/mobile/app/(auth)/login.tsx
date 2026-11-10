import { useState } from 'react';
import { Text } from 'react-native';
import { api, ApiError } from '../../src/api/client';
import { useAuth, type SessionUser } from '../../src/auth/store';
import { Button, Field, Screen } from '../../src/components/ui';
import { useTheme } from '../../src/theme';

export default function Login() {
  const t = useTheme();
  const setSession = useAuth((s) => s.setSession);
  const [loginId, setLoginId] = useState('');
  const [password, setPassword] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit() {
    setBusy(true); setErr(null);
    try {
      const r = await api<{ accessToken: string; refreshToken: string; user: SessionUser }>('/auth/login', {
        body: { loginId: loginId.trim(), password, deviceLabel: 'mobile' }, auth: false,
      });
      await setSession(r);                    // root gate routes to owner or staff area by role
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : 'Cannot reach server. Check Wi-Fi / data.');
    } finally { setBusy(false); }
  }

  return (
    <Screen>
      <Text style={{ color: t.text, fontSize: 28, fontWeight: '800', marginTop: 80 }}>WH Reg</Text>
      <Text style={{ color: t.textSecondary, marginBottom: 24 }}>Inventory & Dispatch</Text>
      <Field label="User ID" value={loginId} onChangeText={setLoginId} autoCapitalize="none" autoCorrect={false} />
      <Field label="Password" value={password} onChangeText={setPassword} secureTextEntry error={err ?? undefined} onSubmitEditing={submit} />
      <Button title="Log in" onPress={submit} busy={busy} disabled={!loginId || password.length < 8} />
    </Screen>
  );
}

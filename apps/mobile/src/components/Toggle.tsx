import { Pressable, Text, View } from 'react-native';
import { useTheme } from '../theme';

/** On / off switch with a label. */
export function Toggle({ label, on, onChange, hint }: { label: string; on: boolean; onChange: (v: boolean) => void; hint?: string }) {
  const t = useTheme();
  return (
    <Pressable onPress={() => onChange(!on)} accessibilityRole="switch" accessibilityState={{ checked: on }}
      style={{ flexDirection: 'row', alignItems: 'center', gap: 10, paddingVertical: 6 }}>
      <View style={{ flex: 1 }}>
        <Text style={{ color: t.text, fontWeight: '600' }}>{label}</Text>
        {hint ? <Text style={{ color: t.textMuted, fontSize: 12 }}>{hint}</Text> : null}
      </View>
      <View style={{ width: 52, height: 30, borderRadius: 15, padding: 3, backgroundColor: on ? t.accent : t.cardAlt, borderWidth: 1, borderColor: t.hairline, alignItems: on ? 'flex-end' : 'flex-start' }}>
        <View style={{ width: 22, height: 22, borderRadius: 11, backgroundColor: on ? t.yellow : '#fff' }} />
      </View>
    </Pressable>
  );
}

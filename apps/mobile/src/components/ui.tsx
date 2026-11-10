/** Minimal primitives — large touch targets for gloved/dusty warehouse use. */
import type { ReactNode } from 'react';
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, TextInput, View, type TextInputProps } from 'react-native';
import { useTheme } from '../theme';

export function Screen({ children, scroll = true }: { children: ReactNode; scroll?: boolean }) {
  const t = useTheme();
  // Centered column on wide (desktop browser) screens; full width on phones.
  const body = <View style={{ padding: 16, gap: 12, width: '100%', maxWidth: 960, alignSelf: 'center' }}>{children}</View>;
  return scroll
    ? <ScrollView style={{ flex: 1, backgroundColor: t.surface }} keyboardShouldPersistTaps="handled">{body}</ScrollView>
    : <View style={{ flex: 1, backgroundColor: t.surface }}>{body}</View>;
}

export function Card({ children, title }: { children: ReactNode; title?: string }) {
  const t = useTheme();
  return (
    <View style={[s.card, { backgroundColor: t.card, borderColor: t.border }]}>
      {title ? <Text style={[s.cardTitle, { color: t.text }]}>{title}</Text> : null}
      {children}
    </View>
  );
}

export function Label({ children, muted }: { children: ReactNode; muted?: boolean }) {
  const t = useTheme();
  return <Text style={{ color: muted ? t.textMuted : t.textSecondary, fontSize: 13 }}>{children}</Text>;
}

export function Field({ label, error, ...props }: TextInputProps & { label: string; error?: string }) {
  const t = useTheme();
  return (
    <View style={{ gap: 4, flex: props.style ? undefined : 1 }}>
      <Label>{label}</Label>
      <TextInput
        placeholderTextColor={t.textMuted}
        {...props}
        style={[s.input, { color: t.text, borderColor: error ? t.danger : t.border, backgroundColor: t.card }, props.style]}
      />
      {error ? <Text style={{ color: t.danger, fontSize: 12 }}>{error}</Text> : null}
    </View>
  );
}

export function Button({ title, onPress, kind = 'primary', busy, disabled }: {
  title: string; onPress: () => void; kind?: 'primary' | 'secondary' | 'danger'; busy?: boolean; disabled?: boolean;
}) {
  const t = useTheme();
  const bg = kind === 'primary' ? t.accent : kind === 'danger' ? t.danger : 'transparent';
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled || busy}
      style={({ pressed }) => [s.btn, { backgroundColor: bg, borderColor: kind === 'secondary' ? t.border : bg, opacity: disabled ? 0.5 : pressed ? 0.8 : 1 }]}
    >
      {busy ? <ActivityIndicator color="#fff" /> : <Text style={{ color: kind === 'secondary' ? t.text : '#fff', fontWeight: '600', fontSize: 16 }}>{title}</Text>}
    </Pressable>
  );
}

export function Chips<T extends string | number>({ options, value, onChange, format }: {
  options: readonly T[]; value: T | null; onChange: (v: T) => void; format?: (v: T) => string;
}) {
  const t = useTheme();
  return (
    <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
      {options.map((o) => {
        const on = o === value;
        return (
          <Pressable key={String(o)} onPress={() => onChange(o)}
            style={[s.chip, { borderColor: on ? t.accent : t.border, backgroundColor: on ? t.accent : t.card }]}>
            <Text style={{ color: on ? '#fff' : t.text, fontWeight: on ? '600' : '400' }}>{format ? format(o) : String(o)}</Text>
          </Pressable>
        );
      })}
    </View>
  );
}

export function Row({ left, right, sub }: { left: ReactNode; right?: ReactNode; sub?: ReactNode }) {
  const t = useTheme();
  return (
    <View style={[s.row, { borderBottomColor: t.border }]}>
      <View style={{ flex: 1, gap: 2 }}>
        <Text style={{ color: t.text, fontSize: 15 }}>{left}</Text>
        {sub ? <Text style={{ color: t.textMuted, fontSize: 12 }}>{sub}</Text> : null}
      </View>
      {right ? <Text style={{ color: t.text, fontVariant: ['tabular-nums'], fontWeight: '600' }}>{right}</Text> : null}
    </View>
  );
}

export function Stat({ label, value, sub }: { label: string; value: string; sub?: string }) {
  const t = useTheme();
  return (
    <View style={[s.card, { flex: 1, backgroundColor: t.card, borderColor: t.border, gap: 2 }]}>
      <Label muted>{label}</Label>
      <Text style={{ color: t.text, fontSize: 22, fontWeight: '700', fontVariant: ['tabular-nums'] }}>{value}</Text>
      {sub ? <Label muted>{sub}</Label> : null}
    </View>
  );
}

const s = StyleSheet.create({
  card: { borderWidth: StyleSheet.hairlineWidth, borderRadius: 12, padding: 14, gap: 10 },
  cardTitle: { fontSize: 16, fontWeight: '700' },
  input: { borderWidth: 1, borderRadius: 10, paddingHorizontal: 12, paddingVertical: 12, fontSize: 16, minHeight: 48 },
  btn: { borderWidth: 1, borderRadius: 10, minHeight: 52, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 16 },
  chip: { borderWidth: 1, borderRadius: 999, paddingHorizontal: 14, paddingVertical: 10, minHeight: 44, justifyContent: 'center' },
  row: { flexDirection: 'row', alignItems: 'center', paddingVertical: 10, borderBottomWidth: StyleSheet.hairlineWidth, gap: 12 },
});

/**
 * Single-series horizontal bar (ranking). One hue, value printed in text ink
 * beside the bar, so no legend is needed and nothing relies on colour.
 */
export function HBar({ label, value, max, display, sub }: { label: string; value: number; max: number; display: string; sub?: string }) {
  const t = useTheme();
  const pct = max > 0 ? Math.max(2, (value / max) * 100) : 0;
  return (
    <View style={{ gap: 4, paddingVertical: 6 }}>
      <View style={{ flexDirection: 'row', justifyContent: 'space-between', gap: 8 }}>
        <Text style={{ color: t.text, flex: 1 }} numberOfLines={1}>{label}</Text>
        <Text style={{ color: t.text, fontWeight: '600', fontVariant: ['tabular-nums'] }}>{display}</Text>
      </View>
      <View style={{ height: 8, borderRadius: 4, backgroundColor: t.border }}>
        <View style={{ width: `${pct}%`, height: 8, borderRadius: 4, backgroundColor: t.series[0] }} />
      </View>
      {sub ? <Text style={{ color: t.textMuted, fontSize: 12 }}>{sub}</Text> : null}
    </View>
  );
}

/** Shared building blocks — large touch targets for gloved/dusty warehouse use, themed for Day / Night. */
import Ionicons from '@expo/vector-icons/Ionicons';
import type { ComponentProps, ReactNode } from 'react';
import { ActivityIndicator, Platform, Pressable, ScrollView, StyleSheet, Text, TextInput, View, useWindowDimensions, type TextInputProps, type ViewStyle } from 'react-native';
import { useTheme, useThemeMode, type Theme, type ThemeMode } from '../theme';

export type IconName = ComponentProps<typeof Ionicons>['name'];

const shadow = (t: Theme): ViewStyle => Platform.OS === 'web'
  ? ({ boxShadow: `0 1px 2px ${t.shadow}, 0 4px 14px ${t.shadow}` } as ViewStyle)
  : { shadowColor: '#000', shadowOpacity: t.dark ? 0.35 : 0.06, shadowRadius: 8, shadowOffset: { width: 0, height: 2 }, elevation: 2 };

export function Screen({ children, scroll = true }: { children: ReactNode; scroll?: boolean }) {
  const t = useTheme();
  // Centered column on wide (desktop browser) screens; full width on phones.
  const body = <View style={{ padding: 16, paddingBottom: 32, gap: 14, width: '100%', maxWidth: 1100, alignSelf: 'center' }}>{children}</View>;
  return scroll
    ? <ScrollView style={{ flex: 1, backgroundColor: t.bg }} keyboardShouldPersistTaps="handled">{body}</ScrollView>
    : <View style={{ flex: 1, backgroundColor: t.bg }}>{body}</View>;
}

/** Rounded panel. Optional icon, title, one-line description and something on the right (e.g. a button). */
export function Card({ children, title, subtitle, icon, right, tone }: {
  children?: ReactNode; title?: string; subtitle?: string; icon?: IconName; right?: ReactNode;
  tone?: 'accent' | 'danger' | 'warning' | 'good';
}) {
  const t = useTheme();
  icon = icon ?? (title ? cardIcon(title) : undefined);
  const toneColor = tone === 'danger' ? t.danger : tone === 'warning' ? t.warning : tone === 'good' ? t.good : tone === 'accent' ? t.accent : null;
  return (
    <View style={[s.card, shadow(t), { backgroundColor: t.card, borderColor: t.border }, toneColor ? { borderLeftWidth: 4, borderLeftColor: toneColor } : null]}>
      {title || right ? (
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
          {icon ? (
            <View style={[s.iconBubble, { backgroundColor: toneColor ? `${toneColor}22` : t.accentSoft }]}>
              <Ionicons name={icon} size={17} color={toneColor ?? t.accent} />
            </View>
          ) : null}
          <View style={{ flex: 1, gap: 1 }}>
            {title ? <Text style={[s.cardTitle, { color: t.text }]}>{title}</Text> : null}
            {subtitle ? <Text style={{ color: t.textMuted, fontSize: 12.5 }}>{subtitle}</Text> : null}
          </View>
          {right}
        </View>
      ) : null}
      {children}
    </View>
  );
}

/** Picks a sensible icon from a card title so every panel is easy to recognise. */
function cardIcon(title: string): IconName | undefined {
  const rules: [RegExp, IconName][] = [
    [/waiting|approval/i, 'hourglass-outline'], [/late|unpaid|30 days/i, 'alarm-outline'],
    [/attendance|clock/i, 'time-outline'], [/market run|place/i, 'map-outline'], [/customer|approached/i, 'people-outline'],
    [/vs payments|per month|months/i, 'bar-chart-outline'], [/payment|collect|statement|credit used/i, 'wallet-outline'], [/credit note/i, 'pricetag-outline'],
    [/gst|tax/i, 'calculator-outline'], [/discount/i, 'pricetag-outline'], [/charges/i, 'car-outline'],
    [/top sellers|sales agents|performance/i, 'trophy-outline'], [/sales per month|months|vs payments/i, 'bar-chart-outline'],
    [/margin/i, 'trending-up'], [/dead stock/i, 'snow-outline'], [/stock|units|reorder|item/i, 'cube-outline'],
    [/transfer|inbound/i, 'swap-horizontal'], [/inward/i, 'arrow-down-circle-outline'], [/outward/i, 'arrow-up-circle-outline'],
    [/warehouse/i, 'business-outline'], [/login|employee|staff/i, 'person-outline'], [/pin|override/i, 'key-outline'],
    [/whatsapp|alert/i, 'logo-whatsapp'], [/hidden|compan/i, 'pricetags-outline'], [/invoice|bill|seller/i, 'document-text-outline'],
    [/preview|recent|notes/i, 'list-outline'], [/approved/i, 'checkmark-done-outline'],
  ];
  return rules.find(([re]) => re.test(title))?.[1];
}

/** Small uppercase heading that groups several cards on a page. */
export function Section({ title, hint }: { title: string; hint?: string }) {
  const t = useTheme();
  return (
    <View style={{ marginTop: 6, gap: 2 }}>
      <Text style={{ color: t.textMuted, fontSize: 12, fontWeight: '700', letterSpacing: 0.8, textTransform: 'uppercase' }}>{title}</Text>
      {hint ? <Text style={{ color: t.textMuted, fontSize: 12.5 }}>{hint}</Text> : null}
    </View>
  );
}

/** Friendly "nothing here yet" message with an icon. */
export function Empty({ text, icon = 'file-tray-outline' }: { text: string; icon?: IconName }) {
  const t = useTheme();
  return (
    <View style={{ alignItems: 'center', paddingVertical: 18, gap: 6 }}>
      <Ionicons name={icon} size={26} color={t.textMuted} />
      <Text style={{ color: t.textMuted, textAlign: 'center' }}>{text}</Text>
    </View>
  );
}

/** Coloured info / warning strip. */
export function Notice({ children, tone = 'accent', icon }: { children: ReactNode; tone?: 'accent' | 'danger' | 'warning' | 'good'; icon?: IconName }) {
  const t = useTheme();
  const fg = tone === 'danger' ? t.danger : tone === 'warning' ? t.warning : tone === 'good' ? t.good : t.accent;
  const bg = tone === 'danger' ? t.dangerSoft : tone === 'warning' ? t.warningSoft : tone === 'good' ? t.goodSoft : t.accentSoft;
  const ic: IconName = icon ?? (tone === 'danger' ? 'alert-circle' : tone === 'warning' ? 'warning' : tone === 'good' ? 'checkmark-circle' : 'information-circle');
  return (
    <View style={{ flexDirection: 'row', gap: 8, alignItems: 'flex-start', backgroundColor: bg, borderRadius: 10, padding: 12 }}>
      <Ionicons name={ic} size={18} color={fg} />
      <Text style={{ color: t.text, flex: 1, fontSize: 13.5 }}>{children}</Text>
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
    <View style={{ gap: 5, flex: props.style ? undefined : 1 }}>
      <Text style={{ color: t.textSecondary, fontSize: 13, fontWeight: '600' }}>{label}</Text>
      <TextInput
        placeholderTextColor={t.textMuted}
        {...props}
        style={[s.input, { color: t.text, borderColor: error ? t.danger : t.border, backgroundColor: t.cardAlt }, props.style]}
      />
      {error ? <Text style={{ color: t.danger, fontSize: 12 }}>{error}</Text> : null}
    </View>
  );
}

export function Button({ title, onPress, kind = 'primary', busy, disabled, icon }: {
  title: string; onPress: () => void; kind?: 'primary' | 'secondary' | 'danger'; busy?: boolean; disabled?: boolean; icon?: IconName;
}) {
  const t = useTheme();
  const bg = kind === 'primary' ? t.accent : kind === 'danger' ? t.danger : t.card;
  const fg = kind === 'secondary' ? t.text : t.onAccent;
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled || busy}
      style={({ pressed }) => [s.btn, { backgroundColor: bg, borderColor: kind === 'secondary' ? t.border : bg, opacity: disabled ? 0.5 : pressed ? 0.85 : 1 }]}
    >
      {busy ? <ActivityIndicator color={fg} /> : (
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
          {icon ? <Ionicons name={icon} size={18} color={fg} /> : null}
          <Text style={{ color: fg, fontWeight: '600', fontSize: 16 }}>{title}</Text>
        </View>
      )}
    </Pressable>
  );
}

/** Ionicon names used by older call sites that passed an emoji/text icon. */
const ICON_ALIASES: Record<string, IconName> = { '⬇': 'download-outline', '✎': 'create-outline', '+': 'add', '✓': 'checkmark', '✕': 'close' };

/** Compact button for toolbars ("Export to Excel", "Edit"). */
export function SmallButton({ title, onPress, icon, kind = 'secondary', disabled }: {
  title: string; onPress: () => void; icon?: string; kind?: 'primary' | 'secondary' | 'danger'; disabled?: boolean;
}) {
  const t = useTheme();
  const bg = kind === 'primary' ? t.accent : kind === 'danger' ? t.danger : t.card;
  const fg = kind === 'secondary' ? t.text : t.onAccent;
  const ion = icon ? (ICON_ALIASES[icon] ?? (/^[a-z-]+$/.test(icon) ? icon as IconName : null)) : null;
  // Auto-pick an icon for common actions so toolbars read at a glance.
  const auto: IconName | null = ion ?? (/excel|export/i.test(title) ? 'download-outline' : /^edit/i.test(title) ? 'create-outline' : /^(add|new)\b/i.test(title) ? 'add' : null);
  return (
    <Pressable onPress={onPress} disabled={disabled}
      style={({ pressed }) => [s.small, { backgroundColor: bg, borderColor: kind === 'secondary' ? t.border : bg, opacity: disabled ? 0.5 : pressed ? 0.85 : 1 }]}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
        {auto ? <Ionicons name={auto} size={16} color={fg} /> : icon && !ion ? <Text style={{ color: fg }}>{icon}</Text> : null}
        <Text style={{ color: fg, fontWeight: '600' }}>{title}</Text>
      </View>
    </Pressable>
  );
}

export function Toolbar({ children }: { children: ReactNode }) {
  return <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8, alignItems: 'center' }}>{children}</View>;
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
            style={[s.chip, { borderColor: on ? t.accent : t.border, backgroundColor: on ? t.accentSoft : t.card }]}>
            <Text style={{ color: on ? t.accent : t.text, fontWeight: on ? '700' : '500' }}>{format ? format(o) : String(o)}</Text>
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
        <Text style={{ color: t.text, fontSize: 15, fontWeight: '500' }}>{left}</Text>
        {sub ? <Text style={{ color: t.textMuted, fontSize: 12.5 }}>{sub}</Text> : null}
      </View>
      {right == null || right === false ? null : typeof right === 'string' || typeof right === 'number'
        ? <Text style={{ color: t.text, fontVariant: ['tabular-nums'], fontWeight: '700' }}>{right}</Text>
        : right}
    </View>
  );
}

/** Headline number tile. Icon is picked from the label when not given. */
export function Stat({ label, value, sub, icon, tone }: { label: string; value: string; sub?: string; icon?: IconName; tone?: 'accent' | 'danger' | 'warning' | 'good' }) {
  const t = useTheme();
  const auto: IconName = icon ?? (
    /late|overdue|due/i.test(label) ? 'alarm-outline'
    : /collect|balance|outstanding|pending/i.test(label) ? 'wallet-outline'
    : /stock|valu/i.test(label) ? 'cube-outline'
    : /purchase|bought/i.test(label) ? 'receipt-outline'
    : /sale|revenue|sold/i.test(label) ? 'trending-up'
    : /credit/i.test(label) ? 'pricetag-outline'
    : /hour|attend|present|clock/i.test(label) ? 'time-outline'
    : /customer|visit/i.test(label) ? 'people-outline'
    : 'analytics-outline');
  const narrow = useWindowDimensions().width < 520;
  const fg = tone === 'danger' ? t.danger : tone === 'warning' ? t.warning : tone === 'good' ? t.good : t.accent;
  const bg = tone === 'danger' ? t.dangerSoft : tone === 'warning' ? t.warningSoft : tone === 'good' ? t.goodSoft : t.accentSoft;
  return (
    <View style={[s.card, shadow(t), { flex: 1, minWidth: narrow ? 150 : 280, padding: narrow ? 12 : 16, backgroundColor: t.card, borderColor: t.border, gap: 6 }]}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
        <View style={[s.iconBubble, { backgroundColor: bg }]}><Ionicons name={auto} size={16} color={fg} /></View>
        <Text style={{ color: t.textSecondary, fontSize: 13, fontWeight: '600', flex: 1 }} numberOfLines={2}>{label}</Text>
      </View>
      <Text style={{ color: t.text, fontSize: narrow ? (value.length > 11 ? 17 : 20) : 24, fontWeight: '800', fontVariant: ['tabular-nums'] }} numberOfLines={1}>{value}</Text>
      {sub ? <Text style={{ color: t.textMuted, fontSize: 12.5 }}>{sub}</Text> : null}
    </View>
  );
}

/** Day / Auto / Night switch. */
export function ThemeSwitch({ compact }: { compact?: boolean }) {
  const t = useTheme();
  const { mode, setMode } = useThemeMode();
  const opts: { m: ThemeMode; icon: IconName; label: string }[] = [
    { m: 'light', icon: 'sunny', label: 'Day' },
    { m: 'system', icon: 'contrast', label: 'Auto' },
    { m: 'dark', icon: 'moon', label: 'Night' },
  ];
  return (
    <View style={{ flexDirection: 'row', backgroundColor: t.cardAlt, borderRadius: 10, padding: 3, borderWidth: StyleSheet.hairlineWidth, borderColor: t.border }}
      accessibilityRole="radiogroup" accessibilityLabel="Day or night mode">
      {opts.map((o) => {
        const on = mode === o.m;
        return (
          <Pressable key={o.m} onPress={() => setMode(o.m)} accessibilityRole="radio" accessibilityState={{ checked: on }} accessibilityLabel={`${o.label} mode`}
            style={{ flex: 1, flexDirection: 'row', gap: 5, alignItems: 'center', justifyContent: 'center', paddingVertical: 7, paddingHorizontal: compact ? 8 : 10, borderRadius: 8, backgroundColor: on ? t.card : 'transparent' }}>
            <Ionicons name={o.icon} size={15} color={on ? t.accent : t.textMuted} />
            {compact ? null : <Text style={{ color: on ? t.text : t.textMuted, fontSize: 13, fontWeight: on ? '700' : '500' }}>{o.label}</Text>}
          </Pressable>
        );
      })}
    </View>
  );
}

/** One-tap Day ⇄ Night button for headers. */
export function ThemeToggleButton() {
  const t = useTheme();
  const setMode = useThemeMode((s) => s.setMode);
  return (
    <Pressable onPress={() => setMode(t.dark ? 'light' : 'dark')} accessibilityLabel={t.dark ? 'Switch to day mode' : 'Switch to night mode'}
      style={({ pressed }) => ({ width: 40, height: 40, borderRadius: 20, alignItems: 'center', justifyContent: 'center', backgroundColor: pressed ? t.cardAlt : 'transparent' })}>
      <Ionicons name={t.dark ? 'sunny' : 'moon'} size={20} color={t.text} />
    </Pressable>
  );
}

const s = StyleSheet.create({
  card: { borderWidth: StyleSheet.hairlineWidth, borderRadius: 14, padding: 16, gap: 10 },
  cardTitle: { fontSize: 16, fontWeight: '700' },
  iconBubble: { width: 30, height: 30, borderRadius: 9, alignItems: 'center', justifyContent: 'center' },
  input: { borderWidth: 1, borderRadius: 10, paddingHorizontal: 12, paddingVertical: 12, fontSize: 16, minHeight: 48 },
  btn: { borderWidth: 1, borderRadius: 12, minHeight: 52, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 18 },
  small: { borderWidth: 1, borderRadius: 9, paddingHorizontal: 12, paddingVertical: 8, minHeight: 40, justifyContent: 'center' },
  chip: { borderWidth: 1, borderRadius: 999, paddingHorizontal: 14, paddingVertical: 9, minHeight: 42, justifyContent: 'center' },
  row: { flexDirection: 'row', alignItems: 'center', paddingVertical: 11, borderBottomWidth: StyleSheet.hairlineWidth, gap: 12 },
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

/** Target progress bar: green at 100 %+, accent below. Percentage is printed so colour is not the only cue. */
export function Progress({ value, max, height = 12 }: { value: number; max: number; height?: number }) {
  const t = useTheme();
  const pct = max > 0 ? Math.min(100, (value / max) * 100) : 0;
  const done = max > 0 && value >= max;
  return (
    <View style={{ height, borderRadius: height / 2, backgroundColor: t.cardAlt, borderWidth: StyleSheet.hairlineWidth, borderColor: t.border, overflow: 'hidden' }}
      accessibilityRole="progressbar" accessibilityValue={{ min: 0, max: 100, now: Math.round(pct) }}>
      <View style={{ width: `${pct}%`, height: '100%', borderRadius: height / 2, backgroundColor: done ? t.good : t.accent }} />
    </View>
  );
}

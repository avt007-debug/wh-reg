/**
 * App frame shared by the owner and employee areas:
 *  - wide screens (computer / tablet ≥ 900px): left sidebar grouped into sections,
 *    with the signed-in person, Day / Night switch and Log out at the bottom;
 *  - phones: bottom bar with the main tabs + "More" sheet for the rest.
 *  - every page gets a header with its title, a one-line explanation and a Day/Night button.
 */
import Ionicons from '@expo/vector-icons/Ionicons';
import { useState, type ReactNode } from 'react';
import { Modal, Pressable, ScrollView, Text, View, useWindowDimensions } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useAuth } from '../auth/store';
import { useTheme } from '../theme';
import { glass, pageBgFixed, ThemeSwitch, ThemeToggleButton, type IconName } from './ui';

export interface NavItem { name: string; title: string; icon: IconName; hint: string }
export interface NavSection { title: string; items: NavItem[] }

/** The parts of the navigator's tab-bar props this frame uses. */
type BottomTabBarProps = {
  state: { index: number; routes: { key: string; name: string; params?: object }[] };
  descriptors: Record<string, { options: { tabBarBadge?: unknown } } | undefined>;
  emitter: { emit: (e: { type: 'tabPress'; target: string; canPreventDefault: true }) => { defaultPrevented: boolean } };
  navigateToTab: (routeKey: string) => void;
};
type HeaderProps = { route: { name: string }; options: { title?: string } };

export const WIDE = 900;
export const useWide = () => useWindowDimensions().width >= WIDE;

function initials(name: string) {
  return name.replace(/[^\p{L}\s]/gu, ' ').split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]!.toUpperCase()).join('') || '?';
}

function Badge({ n }: { n: unknown }) {
  const t = useTheme();
  if (n == null || n === '' || n === 0) return null;
  return (
    <View style={{ minWidth: 20, height: 20, borderRadius: 10, backgroundColor: t.danger, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 5 }}>
      <Text style={{ color: '#fff', fontSize: 11, fontWeight: '800' }}>{String(n)}</Text>
    </View>
  );
}

function UserBlock({ roleLabel }: { roleLabel: string }) {
  const t = useTheme();
  const user = useAuth((s) => s.user);
  const signOut = useAuth((s) => s.signOut);
  return (
    <View style={{ gap: 10 }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
        <View style={{ width: 36, height: 36, borderRadius: 18, backgroundColor: t.accentSoft, alignItems: 'center', justifyContent: 'center' }}>
          <Text style={{ color: t.accent, fontWeight: '800' }}>{initials(user?.fullName ?? '')}</Text>
        </View>
        <View style={{ flex: 1 }}>
          <Text style={{ color: t.text, fontWeight: '700' }} numberOfLines={1}>{user?.fullName ?? ''}</Text>
          <Text style={{ color: t.textMuted, fontSize: 12 }}>{roleLabel}</Text>
        </View>
        <Pressable onPress={() => void signOut()} accessibilityLabel="Log out"
          style={({ pressed }) => ({ padding: 8, borderRadius: 8, backgroundColor: pressed ? t.cardAlt : 'transparent' })}>
          <Ionicons name="log-out-outline" size={20} color={t.textSecondary} />
        </Pressable>
      </View>
      <ThemeSwitch />
    </View>
  );
}

function NavRow({ item, active, badge, onPress, wide }: { item: NavItem; active: boolean; badge?: unknown; onPress: () => void; wide?: boolean }) {
  const t = useTheme();
  return (
    <Pressable onPress={onPress} accessibilityRole="link" accessibilityState={{ selected: active }} accessibilityLabel={item.title}
      style={({ pressed, hovered }: { pressed: boolean; hovered?: boolean }) => ({
        flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: wide ? 9 : 13, paddingHorizontal: 12, borderRadius: 10,
        backgroundColor: active ? t.accentSoft : pressed || hovered ? t.cardAlt : 'transparent',
      })}>
      {active && wide ? <View style={{ position: 'absolute', left: 0, top: 8, bottom: 8, width: 4, borderRadius: 2, backgroundColor: t.yellow }} /> : null}
      <Ionicons name={active ? item.icon : (`${item.icon}-outline` as IconName)} size={20} color={active ? t.accent : t.textSecondary} />
      <View style={{ flex: 1 }}>
        <Text style={{ color: active ? t.accent : t.text, fontWeight: active ? '700' : '500', fontSize: 14.5 }}>{item.title}</Text>
        {!wide ? <Text style={{ color: t.textMuted, fontSize: 12 }} numberOfLines={1}>{item.hint}</Text> : null}
      </View>
      <Badge n={badge} />
    </Pressable>
  );
}

/** Custom tab bar: sidebar on wide screens, bottom bar + More sheet on phones. */
export function AppTabBar({ state, descriptors, emitter, navigateToTab, sections, primary, roleLabel }: BottomTabBarProps & {
  sections: NavSection[]; primary: string[]; roleLabel: string;
}) {
  const t = useTheme();
  const wide = useWide();
  const insets = useSafeAreaInsets();
  const [more, setMore] = useState(false);
  const current = state.routes[state.index]?.name;
  const go = (name: string) => {
    const route = state.routes.find((r) => r.name === name);
    if (!route) return;
    const ev = emitter.emit({ type: 'tabPress', target: route.key, canPreventDefault: true });
    if (!ev.defaultPrevented) navigateToTab(route.key);
    setMore(false);
  };
  const badgeOf = (name: string) => {
    const route = state.routes.find((r) => r.name === name);
    return route ? descriptors[route.key]?.options.tabBarBadge : undefined;
  };
  const all = sections.flatMap((s) => s.items);

  if (wide) {
    return (
      <View style={[{ width: 248, backgroundColor: t.nav, borderRightWidth: 1, borderRightColor: t.border, paddingTop: insets.top + 16, paddingBottom: insets.bottom + 14 }, glass(t, 24)]}>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal: 18, marginBottom: 14 }}>
          <View style={{ width: 36, height: 36, borderRadius: 11, backgroundColor: t.accent, alignItems: 'center', justifyContent: 'center', borderWidth: 2, borderColor: t.yellow }}>
            <Ionicons name="cube" size={18} color={t.yellow} />
          </View>
          <View>
            <Text style={{ color: t.text, fontWeight: '800', fontSize: 17 }}>WH Reg</Text>
            <Text style={{ color: t.textMuted, fontSize: 12 }}>Inventory · Billing · Team</Text>
          </View>
        </View>
        <ScrollView style={{ flex: 1 }} contentContainerStyle={{ paddingHorizontal: 10, gap: 2 }}>
          {sections.map((sec) => (
            <View key={sec.title} style={{ marginTop: 10, gap: 2 }}>
              <Text style={{ color: t.textMuted, fontSize: 11, fontWeight: '700', letterSpacing: 0.8, textTransform: 'uppercase', paddingHorizontal: 12, marginBottom: 2 }}>{sec.title}</Text>
              {sec.items.map((it) => <NavRow key={it.name} item={it} wide active={current === it.name} badge={badgeOf(it.name)} onPress={() => go(it.name)} />)}
            </View>
          ))}
        </ScrollView>
        <View style={{ paddingHorizontal: 14, paddingTop: 12, borderTopWidth: 1, borderTopColor: t.border }}>
          <UserBlock roleLabel={roleLabel} />
        </View>
      </View>
    );
  }

  const prim = primary.map((n) => all.find((i) => i.name === n)!).filter(Boolean);
  const inMore = !primary.includes(current ?? '');
  const moreBadge = all.filter((i) => !primary.includes(i.name)).some((i) => badgeOf(i.name));
  return (
    <>
      <View style={[{ flexDirection: 'row', backgroundColor: t.nav, borderTopWidth: 1, borderTopColor: t.border, paddingBottom: insets.bottom, paddingTop: 4 }, glass(t, 24)]}>
        {[...prim, { name: '__more', title: 'More', icon: 'grid' as IconName, hint: '' }].map((it) => {
          const active = it.name === '__more' ? inMore : current === it.name;
          const b = it.name === '__more' ? (moreBadge ? '•' : undefined) : badgeOf(it.name);
          return (
            <Pressable key={it.name} onPress={() => (it.name === '__more' ? setMore(true) : go(it.name))}
              accessibilityRole="tab" accessibilityState={{ selected: active }} accessibilityLabel={it.title}
              style={{ flex: 1, alignItems: 'center', paddingVertical: 6, gap: 2 }}>
              <View>
                <View style={{ paddingHorizontal: 14, paddingVertical: 3, borderRadius: 999, backgroundColor: active ? t.accentSoft : 'transparent' }}>
                  <Ionicons name={active ? it.icon : (`${it.icon}-outline` as IconName)} size={22} color={active ? t.accent : t.textSecondary} />
                </View>
                {b ? <View style={{ position: 'absolute', right: 2, top: -2 }}><Badge n={b} /></View> : null}
              </View>
              <Text style={{ color: active ? t.accent : t.textSecondary, fontSize: 11.5, fontWeight: active ? '700' : '500' }} numberOfLines={1}>{it.title}</Text>
            </Pressable>
          );
        })}
      </View>
      <Modal visible={more} transparent animationType="slide" onRequestClose={() => setMore(false)}>
        <Pressable style={{ flex: 1, backgroundColor: t.overlay }} onPress={() => setMore(false)} />
        <View style={[{ backgroundColor: t.dark ? 'rgba(30,12,14,0.86)' : 'rgba(255,255,255,0.86)', borderTopLeftRadius: 20, borderTopRightRadius: 20, paddingTop: 10, paddingBottom: insets.bottom + 14, maxHeight: '85%' }, glass(t, 28)]}>
          <View style={{ alignSelf: 'center', width: 40, height: 4, borderRadius: 2, backgroundColor: t.border, marginBottom: 8 }} />
          <ScrollView contentContainerStyle={{ paddingHorizontal: 14, gap: 2 }}>
            {sections.map((sec) => (
              <View key={sec.title} style={{ marginTop: 8, gap: 2 }}>
                <Text style={{ color: t.textMuted, fontSize: 11, fontWeight: '700', letterSpacing: 0.8, textTransform: 'uppercase', paddingHorizontal: 12 }}>{sec.title}</Text>
                {sec.items.map((it) => <NavRow key={it.name} item={it} active={current === it.name} badge={badgeOf(it.name)} onPress={() => go(it.name)} />)}
              </View>
            ))}
            <View style={{ marginTop: 14, paddingTop: 14, borderTopWidth: 1, borderTopColor: t.border, paddingHorizontal: 4 }}>
              <UserBlock roleLabel={roleLabel} />
            </View>
          </ScrollView>
        </View>
      </Modal>
    </>
  );
}

/** Page header: title + what the page is for, Day/Night button on the right. */
export function AppHeader({ route, options, sections, right }: HeaderProps & { sections: NavSection[]; right?: ReactNode }) {
  const t = useTheme();
  const wide = useWide();
  const insets = useSafeAreaInsets();
  const item = sections.flatMap((s) => s.items).find((i) => i.name === route.name);
  return (
    <View style={pageBgFixed(t)}>
    <View style={[{ backgroundColor: wide ? 'transparent' : t.nav, paddingTop: insets.top + (wide ? 18 : 8), paddingBottom: 6, borderBottomWidth: wide ? 0 : 1, borderBottomColor: t.border }]}>
      <View style={{ position: 'absolute', top: 0, left: 0, right: 0, height: 3, flexDirection: 'row' }}>
        <View style={{ flex: 3, backgroundColor: t.accent }} /><View style={{ flex: 1, backgroundColor: t.yellow }} />
      </View>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal: 16, width: '100%', maxWidth: 1100, alignSelf: 'center' }}>
        {!wide && item ? (
          <View style={{ width: 34, height: 34, borderRadius: 10, backgroundColor: t.accentSoft, alignItems: 'center', justifyContent: 'center' }}>
            <Ionicons name={item.icon} size={18} color={t.accent} />
          </View>
        ) : null}
        <View style={{ flex: 1 }}>
          <Text accessibilityRole="header" style={{ color: t.text, fontSize: wide ? 24 : 19, fontWeight: '800' }} numberOfLines={1}>{options.title ?? item?.title ?? route.name}</Text>
          {item?.hint ? <Text style={{ color: t.textMuted, fontSize: 13 }} numberOfLines={wide ? 1 : 2}>{item.hint}</Text> : null}
        </View>
        {right}
        <ThemeToggleButton />
      </View>
    </View>
    </View>
  );
}

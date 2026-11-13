import { Tabs } from 'expo-router';
import { AppHeader, AppTabBar, useWide, type NavSection } from '../../src/components/AppShell';
import { pageBgFixed } from '../../src/components/ui';
import { useTheme } from '../../src/theme';

/** Floor staff: physical stock + data entry + own log. No owner financial screens exist here. */
const SECTIONS: NavSection[] = [
  { title: 'Overview', items: [
    { name: 'home', title: 'Dashboard', icon: 'speedometer', hint: 'Your clock in / out, sales target, monthly attendance and summary' },
  ] },
  { title: 'Daily work', items: [
    { name: 'stock', title: 'Stock', icon: 'cube', hint: 'What is in stock at every warehouse — search by Material No. or name' },
    { name: 'outward', title: 'Sales', icon: 'arrow-up-circle', hint: 'Make a customer bill — items, discount %, GST and charges' },
    { name: 'inward', title: 'Purchases', icon: 'arrow-down-circle', hint: 'Enter a supplier bill — the owner approves it before stock is added' },
    { name: 'transfers', title: 'Transfers', icon: 'swap-horizontal', hint: 'Move stock between warehouses' },
  ] },
  { title: 'Customers & me', items: [
    { name: 'payments', title: 'Payments', icon: 'wallet', hint: 'Record money received and see what each customer still owes' },
    { name: 'work', title: 'Clock & Visits', icon: 'time', hint: 'Clock in / out, market runs and customers visited' },
    { name: 'log', title: 'My Day', icon: 'today', hint: 'Everything you entered today' },
  ] },
];

export default function StaffLayout() {
  const t = useTheme();
  const wide = useWide();
  return (
    <Tabs
      tabBar={(p) => <AppTabBar {...p} sections={SECTIONS} primary={['home', 'outward', 'stock', 'payments']} roleLabel="Employee" />}
      screenOptions={{
        tabBarPosition: wide ? 'left' : 'bottom',
        header: (p) => <AppHeader {...p} sections={SECTIONS} />,
        sceneStyle: pageBgFixed(t),
      }}>
      {SECTIONS.flatMap((s) => s.items).map((it) => <Tabs.Screen key={it.name} name={it.name} options={{ title: it.title }} />)}
    </Tabs>
  );
}

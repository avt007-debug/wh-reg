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
    { name: 'bills', title: 'My bills', icon: 'receipt', hint: 'Print or WhatsApp a bill, mark it delivered with photo and signature' },
    { name: 'inward', title: 'Purchases', icon: 'arrow-down-circle', hint: 'Enter a supplier bill — the owner approves it before stock is added' },
    { name: 'transfers', title: 'Transfers', icon: 'swap-horizontal', hint: 'Move stock between warehouses' },
    { name: 'count', title: 'Stock count', icon: 'clipboard', hint: 'Count the shelves; the owner applies the count' },
  ] },
  { title: 'Customers & me', items: [
    { name: 'customers', title: 'Customers', icon: 'storefront', hint: 'Call or WhatsApp a customer, see what they owe, directions' },
    { name: 'payments', title: 'Payments', icon: 'wallet', hint: 'Record money received, send a receipt, see what each customer owes' },
    { name: 'plan', title: 'Visit plan', icon: 'map', hint: 'Whom to visit today and this week' },
    { name: 'work', title: 'Clock & Visits', icon: 'time', hint: 'Clock in / out, market runs (with location) and customers visited' },
    { name: 'requests', title: 'Leave & fixes', icon: 'mail', hint: 'Ask for leave or to correct a clock-in / clock-out time' },
    { name: 'log', title: 'My Day', icon: 'today', hint: 'Everything you entered today, your account and settings' },
  ] },
];

export default function StaffLayout() {
  const t = useTheme();
  const wide = useWide();
  return (
    <Tabs
      tabBar={(p) => <AppTabBar {...p} sections={SECTIONS} primary={['home', 'outward', 'bills', 'stock', 'payments', 'work', 'log']} roleLabel="Employee" />}
      screenOptions={{
        tabBarPosition: wide ? 'left' : 'bottom',
        header: (p) => <AppHeader {...p} sections={SECTIONS} />,
        sceneStyle: pageBgFixed(t),
      }}>
      {SECTIONS.flatMap((s) => s.items).map((it) => <Tabs.Screen key={it.name} name={it.name} options={{ title: it.title }} />)}
    </Tabs>
  );
}

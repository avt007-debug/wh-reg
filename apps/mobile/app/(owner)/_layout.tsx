import { useQuery } from '@tanstack/react-query';
import { Tabs } from 'expo-router';
import { rpc } from '../../src/api/client';
import { AppHeader, AppTabBar, useWide, type NavSection } from '../../src/components/AppShell';
import { pageBgFixed } from '../../src/components/ui';
import { useTheme } from '../../src/theme';

/** Owner menu, grouped. "hint" is the one-line explanation shown under each page title. */
const SECTIONS: NavSection[] = [
  { title: 'Overview', items: [
    { name: 'dashboard', title: 'Dashboard', icon: 'stats-chart', hint: "Today's sales, stock value, monthly trend, top sellers and who is clocked in" },
    { name: 'report', title: 'Daily report', icon: 'document-text', hint: 'Sales, purchases, attendance and market runs for any day — same as the 8 pm WhatsApp summary' },
    { name: 'insights', title: 'Insights', icon: 'bulb', hint: 'Margins by category, dead stock and staff performance this month' },
  ] },
  { title: 'Inventory', items: [
    { name: 'stock', title: 'Stock', icon: 'cube', hint: 'Every item per warehouse — search, filter by company, edit, add stock, export' },
    { name: 'reorder', title: 'Reorder', icon: 'cart', hint: 'Items at or below their reorder level, with suggested quantities' },
  ] },
  { title: 'Billing & money', items: [
    { name: 'purchases', title: 'Purchases', icon: 'receipt', hint: 'Supplier bills, approvals, discounts and credit notes' },
    { name: 'sales', title: 'Sales', icon: 'pricetags', hint: 'Customer bills by month — GST billed and Non-GST billed' },
    { name: 'ledger', title: 'Ledger', icon: 'book', hint: 'Payments received, balances to collect and late payers' },
  ] },
  { title: 'People', items: [
    { name: 'employees', title: 'Employees', icon: 'people', hint: 'Monthly sales targets, attendance, sales, market runs and customer visits per employee' },
    { name: 'team', title: 'Settings', icon: 'settings', hint: 'Logins, passwords, warehouses and Day / Night mode' },
  ] },
];

export default function OwnerLayout() {
  const t = useTheme();
  const wide = useWide();
  // Badge on Purchases: staff purchases waiting for approval (re-checked every minute).
  const pending = useQuery({ queryKey: ['pending-purchases'], queryFn: () => rpc<unknown[]>('owner_pending_purchases'), refetchInterval: 60_000 });
  const nPending = pending.data?.length ?? 0;
  return (
    <Tabs
      tabBar={(p) => <AppTabBar {...p} sections={SECTIONS} primary={['dashboard', 'purchases', 'sales', 'stock', 'ledger']} roleLabel="Owner" />}
      screenOptions={{
        tabBarPosition: wide ? 'left' : 'bottom',
        header: (p) => <AppHeader {...p} sections={SECTIONS} />,
        sceneStyle: pageBgFixed(t),
      }}>
      {SECTIONS.flatMap((s) => s.items).map((it) => (
        <Tabs.Screen key={it.name} name={it.name}
          options={{ title: it.title, tabBarBadge: it.name === 'purchases' ? nPending || undefined : undefined }} />
      ))}
    </Tabs>
  );
}

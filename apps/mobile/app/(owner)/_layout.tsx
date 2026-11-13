import { useQuery } from '@tanstack/react-query';
import { Tabs } from 'expo-router';
import { rpc } from '../../src/api/client';
import { AppHeader, AppTabBar, useWide, type NavSection } from '../../src/components/AppShell';
import { pageBgFixed } from '../../src/components/ui';
import { useAuth } from '../../src/auth/store';
import { useTheme } from '../../src/theme';

/** Owner menu, grouped. "hint" is the one-line explanation shown under each page title. */
const SECTIONS: NavSection[] = [
  { title: 'Overview', items: [
    { name: 'dashboard', title: 'Dashboard', icon: 'stats-chart', hint: "Today's sales, stock value, monthly trend, top sellers and who is clocked in" },
    { name: 'report', title: 'Daily report', icon: 'document-text', hint: 'Sales, purchases, attendance and market runs for any day — same as the 8 pm WhatsApp summary' },
    { name: 'insights', title: 'Insights', icon: 'bulb', hint: 'Margins by category, dead stock and staff performance this month' },
    { name: 'activity', title: 'Activity', icon: 'list', hint: 'Who did what and when — bills, payments, stock changes, logins' },
  ] },
  { title: 'Inventory', items: [
    { name: 'stock', title: 'Stock', icon: 'cube', hint: 'Every item per warehouse — search, edit, photos, hide / merge, prices, export' },
    { name: 'reorder', title: 'Reorder', icon: 'cart', hint: 'Items at or below their reorder level, with suggested quantities; set levels in bulk' },
    { name: 'transfers', title: 'Transfers', icon: 'swap-horizontal', hint: 'Move stock between warehouses, receive, cancel' },
    { name: 'count', title: 'Stock count', icon: 'clipboard', hint: 'Count the shelves and correct the stock in one go' },
  ] },
  { title: 'Billing & money', items: [
    { name: 'purchases', title: 'Purchases', icon: 'receipt', hint: 'Supplier bills, approvals, discounts, credit notes and returns' },
    { name: 'sales', title: 'Sales', icon: 'pricetags', hint: 'Customer bills — print / WhatsApp, edit, returns, e-way bill and e-invoice files' },
    { name: 'returns', title: 'Returns', icon: 'return-down-back', hint: 'Credit notes (from customers) and debit notes (to suppliers)' },
    { name: 'ledger', title: 'Ledger', icon: 'book', hint: 'Payments received, balances to collect and late payers' },
    { name: 'customers', title: 'Customers', icon: 'storefront', hint: 'Edit details, credit limits and due days, merge duplicates, call / WhatsApp' },
    { name: 'suppliers', title: 'Suppliers', icon: 'business', hint: 'What you owe each supplier, payments, statements, usual discount' },
    { name: 'money', title: 'Money', icon: 'wallet', hint: 'Expenses, cash book and profit & loss' },
    { name: 'gst', title: 'GST', icon: 'calculator', hint: 'GSTR-1, GSTR-3B and HSN for any month — Excel or the portal file' },
  ] },
  { title: 'People', items: [
    { name: 'employees', title: 'Employees', icon: 'people', hint: 'Targets, attendance, leave & clock requests, visit plans, market runs per employee' },
    { name: 'team', title: 'Settings', icon: 'settings', hint: 'Your account, business details, logins, security, reminders, warehouses' },
  ] },
];

export default function OwnerLayout() {
  const t = useTheme();
  const wide = useWide();
  const role = useAuth((s) => s.user?.role);
  // Badge on Purchases: staff purchases waiting for approval (re-checked every minute).
  const pending = useQuery({ queryKey: ['pending-purchases'], queryFn: () => rpc<unknown[]>('owner_pending_purchases'), refetchInterval: 60_000 });
  const nPending = pending.data?.length ?? 0;
  return (
    <Tabs
      tabBar={(p) => <AppTabBar {...p} sections={SECTIONS} primary={['dashboard', 'purchases', 'sales', 'stock', 'ledger']} roleLabel={role === 'ADMIN' ? 'Manager' : 'Owner'} />}
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

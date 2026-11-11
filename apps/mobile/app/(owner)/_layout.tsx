import Ionicons from '@expo/vector-icons/Ionicons';
import { useQuery } from '@tanstack/react-query';
import { Tabs } from 'expo-router';
import { rpc } from '../../src/api/client';
import { useTheme } from '../../src/theme';

export default function OwnerLayout() {
  const t = useTheme();
  // Badge on Purchases: staff purchases waiting for approval (re-checked every minute).
  const pending = useQuery({ queryKey: ['pending-purchases'], queryFn: () => rpc<unknown[]>('owner_pending_purchases'), refetchInterval: 60_000 });
  const nPending = pending.data?.length ?? 0;
  return (
    <Tabs screenOptions={{ tabBarActiveTintColor: t.accent, headerStyle: { backgroundColor: t.surface }, headerTintColor: t.text }}>
      <Tabs.Screen name="dashboard" options={{ title: 'Dashboard', tabBarIcon: ({ color, size }) => <Ionicons name="stats-chart" color={color as string} size={size} /> }} />
      <Tabs.Screen name="reorder" options={{ title: 'Reorder', tabBarIcon: ({ color, size }) => <Ionicons name="cart" color={color as string} size={size} /> }} />
      <Tabs.Screen name="stock" options={{ title: 'Stock', tabBarIcon: ({ color, size }) => <Ionicons name="cube" color={color as string} size={size} /> }} />
      <Tabs.Screen name="purchases" options={{ title: 'Purchases', tabBarBadge: nPending || undefined, tabBarIcon: ({ color, size }) => <Ionicons name="receipt" color={color as string} size={size} /> }} />
      <Tabs.Screen name="sales" options={{ title: 'Sales', tabBarIcon: ({ color, size }) => <Ionicons name="pricetags" color={color as string} size={size} /> }} />
      <Tabs.Screen name="ledger" options={{ title: 'Ledger', tabBarIcon: ({ color, size }) => <Ionicons name="book" color={color as string} size={size} /> }} />
      <Tabs.Screen name="insights" options={{ title: 'Insights', tabBarIcon: ({ color, size }) => <Ionicons name="bulb" color={color as string} size={size} /> }} />
      <Tabs.Screen name="employees" options={{ title: 'Employees', tabBarIcon: ({ color, size }) => <Ionicons name="people" color={color as string} size={size} /> }} />
      <Tabs.Screen name="team" options={{ title: 'Settings', tabBarIcon: ({ color, size }) => <Ionicons name="settings" color={color as string} size={size} /> }} />
    </Tabs>
  );
}

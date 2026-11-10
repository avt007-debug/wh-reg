import Ionicons from '@expo/vector-icons/Ionicons';
import { Tabs } from 'expo-router';
import { useTheme } from '../../src/theme';

/** Floor staff: physical stock + data entry + own log. No financial screens exist here. */
export default function StaffLayout() {
  const t = useTheme();
  return (
    <Tabs screenOptions={{ tabBarActiveTintColor: t.accent, headerStyle: { backgroundColor: t.surface }, headerTintColor: t.text }}>
      <Tabs.Screen name="stock" options={{ title: 'Stock', tabBarIcon: ({ color, size }) => <Ionicons name="cube" color={color as string} size={size} /> }} />
      <Tabs.Screen name="outward" options={{ title: 'Outward', tabBarIcon: ({ color, size }) => <Ionicons name="arrow-up-circle" color={color as string} size={size} /> }} />
      <Tabs.Screen name="inward" options={{ title: 'Inward', tabBarIcon: ({ color, size }) => <Ionicons name="arrow-down-circle" color={color as string} size={size} /> }} />
      <Tabs.Screen name="transfers" options={{ title: 'Transfers', tabBarIcon: ({ color, size }) => <Ionicons name="swap-horizontal" color={color as string} size={size} /> }} />
      <Tabs.Screen name="work" options={{ title: 'Clock & Visits', tabBarIcon: ({ color, size }) => <Ionicons name="time" color={color as string} size={size} /> }} />
      <Tabs.Screen name="log" options={{ title: 'My Day', tabBarIcon: ({ color, size }) => <Ionicons name="today" color={color as string} size={size} /> }} />
    </Tabs>
  );
}

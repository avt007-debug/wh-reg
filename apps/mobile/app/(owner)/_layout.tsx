import Ionicons from '@expo/vector-icons/Ionicons';
import { Tabs } from 'expo-router';
import { useTheme } from '../../src/theme';

export default function OwnerLayout() {
  const t = useTheme();
  return (
    <Tabs screenOptions={{ tabBarActiveTintColor: t.accent, headerStyle: { backgroundColor: t.surface }, headerTintColor: t.text }}>
      <Tabs.Screen name="dashboard" options={{ title: 'Dashboard', tabBarIcon: ({ color, size }) => <Ionicons name="stats-chart" color={color as string} size={size} /> }} />
      <Tabs.Screen name="reorder" options={{ title: 'Reorder', tabBarIcon: ({ color, size }) => <Ionicons name="cart" color={color as string} size={size} /> }} />
      <Tabs.Screen name="stock" options={{ title: 'Stock', tabBarIcon: ({ color, size }) => <Ionicons name="cube" color={color as string} size={size} /> }} />
      <Tabs.Screen name="purchases" options={{ title: 'Purchases', tabBarIcon: ({ color, size }) => <Ionicons name="receipt" color={color as string} size={size} /> }} />
      <Tabs.Screen name="insights" options={{ title: 'Insights', tabBarIcon: ({ color, size }) => <Ionicons name="bulb" color={color as string} size={size} /> }} />
      <Tabs.Screen name="team" options={{ title: 'Team', tabBarIcon: ({ color, size }) => <Ionicons name="people" color={color as string} size={size} /> }} />
    </Tabs>
  );
}

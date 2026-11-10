import { Tabs } from 'expo-router';
import { useTheme } from '../../src/theme';

/** Floor staff: physical stock + data entry + own log. No financial screens exist here. */
export default function StaffLayout() {
  const t = useTheme();
  return (
    <Tabs screenOptions={{ tabBarActiveTintColor: t.accent, headerStyle: { backgroundColor: t.surface }, headerTintColor: t.text }}>
      <Tabs.Screen name="stock" options={{ title: 'Stock' }} />
      <Tabs.Screen name="outward" options={{ title: 'Outward' }} />
      <Tabs.Screen name="inward" options={{ title: 'Inward' }} />
      <Tabs.Screen name="transfers" options={{ title: 'Transfers' }} />
      <Tabs.Screen name="log" options={{ title: 'My Day' }} />
    </Tabs>
  );
}

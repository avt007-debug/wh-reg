import { Tabs } from 'expo-router';
import { useTheme } from '../../src/theme';

export default function OwnerLayout() {
  const t = useTheme();
  return (
    <Tabs screenOptions={{ tabBarActiveTintColor: t.accent, headerStyle: { backgroundColor: t.surface }, headerTintColor: t.text }}>
      <Tabs.Screen name="dashboard" options={{ title: 'Dashboard' }} />
      <Tabs.Screen name="reorder" options={{ title: 'Reorder' }} />
      <Tabs.Screen name="stock" options={{ title: 'Stock' }} />
      <Tabs.Screen name="purchases" options={{ title: 'Purchases' }} />
      <Tabs.Screen name="insights" options={{ title: 'Insights' }} />
    </Tabs>
  );
}

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Stack } from 'expo-router';
import { useEffect } from 'react';
import { ActivityIndicator, View } from 'react-native';
import { isOwner, useAuth } from '../src/auth/store';
import { PromptHost } from '../src/lib/dialogs';

const queryClient = new QueryClient({
  defaultOptions: { queries: { retry: 1, staleTime: 30_000 } },
});

/**
 * Sign-in guard (Expo Router Stack.Protected). It only decides which screens
 * are reachable — it is NOT the security boundary. Supabase RLS and the
 * owner_* RPC checks refuse owner data to employees whatever the app shows.
 */
function Navigator() {
  const { user, hydrated, hydrate } = useAuth();       // session from Supabase Auth
  useEffect(() => { void hydrate(); }, [hydrate]);

  if (!hydrated) return <View style={{ flex: 1, justifyContent: 'center' }}><ActivityIndicator /></View>;
  const owner = isOwner(user);
  return (
    <Stack screenOptions={{ headerShown: false }}>
      <Stack.Screen name="index" />
      <Stack.Protected guard={!user}>
        <Stack.Screen name="(auth)/login" />
      </Stack.Protected>
      <Stack.Protected guard={!!user && owner}>
        <Stack.Screen name="(owner)" />
      </Stack.Protected>
      <Stack.Protected guard={!!user && !owner}>
        <Stack.Screen name="(staff)" />
      </Stack.Protected>
    </Stack>
  );
}

export default function RootLayout() {
  return (
    <QueryClientProvider client={queryClient}>
      <Navigator />
      <PromptHost />
    </QueryClientProvider>
  );
}

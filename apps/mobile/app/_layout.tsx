import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Redirect, Stack, useSegments } from 'expo-router';
import { useEffect } from 'react';
import { ActivityIndicator, View } from 'react-native';
import { isOwner, useAuth } from '../src/auth/store';

const queryClient = new QueryClient({
  defaultOptions: { queries: { retry: 1, staleTime: 30_000 } },
});

/**
 * Role gate. NOTE: this only decides which screens are shown — it is NOT the
 * security boundary. The API (JWT role check) and Postgres (GRANTs + RLS) refuse
 * owner data to employees regardless of what the app renders.
 */
function Gate() {
  const { user, hydrated, hydrate } = useAuth();
  const seg = useSegments();
  useEffect(() => { void hydrate(); }, [hydrate]);

  if (!hydrated) return <View style={{ flex: 1, justifyContent: 'center' }}><ActivityIndicator /></View>;
  const group = seg[0];
  if (!user && group !== '(auth)') return <Redirect href="/(auth)/login" />;
  if (user && isOwner(user) && group !== '(owner)') return <Redirect href="/(owner)/dashboard" />;
  if (user && !isOwner(user) && group !== '(staff)') return <Redirect href="/(staff)/stock" />;
  return <Stack screenOptions={{ headerShown: false }} />;
}

export default function RootLayout() {
  return (
    <QueryClientProvider client={queryClient}>
      <Gate />
    </QueryClientProvider>
  );
}

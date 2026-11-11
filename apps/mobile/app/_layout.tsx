import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Stack } from 'expo-router';
import { useEffect } from 'react';
import { ActivityIndicator, Platform, StatusBar, View } from 'react-native';
import { useTheme } from '../src/theme';
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
  const t = useTheme();
  const { user, hydrated, hydrate } = useAuth();       // session from Supabase Auth
  useEffect(() => { void hydrate(); }, [hydrate]);

  if (!hydrated) return <View style={{ flex: 1, justifyContent: 'center', backgroundColor: t.bg }}><ActivityIndicator color={t.accent} /></View>;
  const owner = isOwner(user);
  return (
    <Stack screenOptions={{ headerShown: false, contentStyle: { backgroundColor: t.bg } }}>
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

/** Keeps the phone status bar and the browser page colour in step with Day / Night mode. */
function ThemeChrome() {
  const t = useTheme();
  useEffect(() => {
    if (Platform.OS !== 'web' || typeof document === 'undefined') return;
    document.documentElement.style.colorScheme = t.dark ? 'dark' : 'light';
    document.body.style.backgroundColor = t.bg;
    document.querySelector('meta[name="theme-color"]')?.setAttribute('content', t.nav);
  }, [t]);
  return <StatusBar barStyle={t.dark ? 'light-content' : 'dark-content'} />;
}

export default function RootLayout() {
  return (
    <QueryClientProvider client={queryClient}>
      <ThemeChrome />
      <Navigator />
      <PromptHost />
    </QueryClientProvider>
  );
}

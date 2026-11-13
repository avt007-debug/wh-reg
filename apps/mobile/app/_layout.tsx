import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { DarkTheme, DefaultTheme, Stack, ThemeProvider } from 'expo-router';
import { useEffect } from 'react';
import { ActivityIndicator, Platform, StatusBar, View } from 'react-native';
import { useTheme } from '../src/theme';
import { isOwner, useAuth } from '../src/auth/store';
import { PromptHost } from '../src/lib/dialogs';
import { pageBgFixed } from '../src/components/ui';

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

  if (!hydrated) return <View style={[{ flex: 1, justifyContent: 'center' }, pageBgFixed(t)]}><ActivityIndicator color={t.accent} /></View>;
  const owner = isOwner(user);
  // Navigation containers must be see-through so the red/yellow glow behind the glass shows.
  const base = t.dark ? DarkTheme : DefaultTheme;
  const navTheme = { ...base, colors: { ...base.colors, background: t.bg, card: t.nav, primary: t.accent, text: t.text, border: t.border } };
  return (
    <ThemeProvider value={navTheme}>
    <Stack screenOptions={{ headerShown: false, contentStyle: pageBgFixed(t) }}>
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
    </ThemeProvider>
  );
}

/** Keeps the phone status bar and the browser page colour in step with Day / Night mode. */
function ThemeChrome() {
  const t = useTheme();
  useEffect(() => {
    if (Platform.OS !== 'web' || typeof document === 'undefined') return;
    document.documentElement.style.colorScheme = t.dark ? 'dark' : 'light';
    document.body.style.backgroundColor = t.bg;
    document.body.style.backgroundImage = t.bgImage;
    document.body.style.backgroundAttachment = 'fixed';
    document.body.style.backgroundSize = 'cover';
    document.querySelector('meta[name="theme-color"]')?.setAttribute('content', t.dark ? t.bg : '#D40000');
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

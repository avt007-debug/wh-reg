/**
 * Web / home-screen app: checks every 5 minutes (and when the app is shown again) whether a newer version
 * has been published, and offers a one-tap refresh. Nothing to download or install.
 */
import Ionicons from '@expo/vector-icons/Ionicons';
import { useEffect, useState } from 'react';
import { Platform, Pressable, Text, View } from 'react-native';
import { BUILD_ID } from '../lib/version';
import { useTheme } from '../theme';

function versionUrl(): string | null {
  const src = (document.querySelector('script[src*="/_expo/"]') as HTMLScriptElement | null)?.src;
  if (!src) return null;
  return `${src.slice(0, src.indexOf('/_expo/'))}/version.json`;
}

export function UpdateBanner() {
  const t = useTheme();
  const [fresh, setFresh] = useState(false);
  useEffect(() => {
    if (Platform.OS !== 'web' || BUILD_ID === 'dev') return;
    const url = versionUrl();
    if (!url) return;
    const look = () => void fetch(`${url}?t=${Date.now()}`, { cache: 'no-store' })
      .then((r) => (r.ok ? r.json() : null)).then((v: { build?: string } | null) => { if (v?.build && v.build !== BUILD_ID) setFresh(true); })
      .catch(() => undefined);
    look();
    const id = setInterval(look, 5 * 60_000);
    const onShow = () => { if (document.visibilityState === 'visible') look(); };
    document.addEventListener('visibilitychange', onShow);
    return () => { clearInterval(id); document.removeEventListener('visibilitychange', onShow); };
  }, []);
  if (!fresh) return null;
  return (
    <View style={{ position: 'absolute', left: 12, right: 12, bottom: 84, alignItems: 'center' }} pointerEvents="box-none">
      <Pressable onPress={() => location.reload()} accessibilityRole="button"
        style={{ flexDirection: 'row', alignItems: 'center', gap: 8, backgroundColor: t.accent, paddingHorizontal: 16, paddingVertical: 12, borderRadius: 999, borderWidth: 2, borderColor: t.yellow, maxWidth: 460 }}>
        <Ionicons name="refresh" size={18} color="#fff" />
        <Text style={{ color: '#fff', fontWeight: '800' }}>A new version of the app is ready — tap to update</Text>
      </Pressable>
    </View>
  );
}

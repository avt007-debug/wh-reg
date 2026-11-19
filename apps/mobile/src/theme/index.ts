import { Platform, useColorScheme } from 'react-native';
import { create } from 'zustand';

/**
 * Day / Night mode.
 *   'system' follows the phone or computer setting; 'light' / 'dark' force it.
 * The choice is remembered on this device (localStorage in the browser,
 * secure storage on phones) and applies to every screen instantly.
 */
export type ThemeMode = 'system' | 'light' | 'dark';
const KEY = 'whreg.theme';

async function load(): Promise<ThemeMode | null> {
  try {
    if (Platform.OS === 'web') return (globalThis.localStorage?.getItem(KEY) as ThemeMode) ?? null;
    const SecureStore = await import('expo-secure-store');
    return (await SecureStore.getItemAsync(KEY)) as ThemeMode | null;
  } catch { return null; }
}
async function save(mode: ThemeMode) {
  try {
    if (Platform.OS === 'web') { globalThis.localStorage?.setItem(KEY, mode); return; }
    const SecureStore = await import('expo-secure-store');
    await SecureStore.setItemAsync(KEY, mode);
  } catch { /* not fatal: the choice just won't be remembered */ }
}

function initialMode(): ThemeMode {
  try {
    if (Platform.OS === 'web') {
      const v = globalThis.localStorage?.getItem(KEY);
      if (v === 'light' || v === 'dark' || v === 'system') return v;
    }
  } catch { /* ignore */ }
  return 'system';
}

export const useThemeMode = create<{ mode: ThemeMode; setMode: (m: ThemeMode) => void }>((set) => ({
  mode: initialMode(),
  setMode: (mode) => { set({ mode }); void save(mode); },
}));
// Phones: read the saved choice once at start-up.
if (Platform.OS !== 'web') void load().then((m) => { if (m) useThemeMode.setState({ mode: m }); });

/**
 * Chart series colours are assigned by WAREHOUSE (entity), in fixed order of
 * warehouse code — never by rank — so a warehouse keeps its colour everywhere.
 * Palette validated for CVD separation (light + dark). Every chart ships with
 * a legend and a value table beneath it.
 */
const SERIES_LIGHT = ['#2a78d6', '#eb6834', '#1baf7a', '#eda100', '#e87ba4', '#008300'];
const SERIES_DARK = ['#3987e5', '#d95926', '#199e70', '#c98500', '#d55181', '#008300'];

/*
 * "Ocean & Sunrise" (chosen 19-Nov-2026): deep teal with warm amber highlights, easy on the eyes
 * by day and night, with a frosted-glass finish. On the web (browser / home-screen app) panels are
 * see-through with a blur over a soft teal-and-amber glow; on native phones the same colours are
 * used without the blur.
 *   accent  = teal (buttons, links, active tab)      yellow = amber (highlights, icon, toggle knob)
 */
const WEB = Platform.OS === 'web';

const LIGHT = {
  dark: false,
  glass: WEB,
  bg: '#F3F7F8', screenBg: WEB ? 'transparent' : '#F3F7F8',
  bgImage: `radial-gradient(1000px 600px at -5% -10%, rgba(15,110,122,0.26), transparent 60%),
    radial-gradient(900px 560px at 105% 0%, rgba(255,181,71,0.42), transparent 62%),
    radial-gradient(800px 600px at 60% 115%, rgba(15,110,122,0.14), transparent 60%),
    linear-gradient(180deg, #F8FBFB 0%, #EEF3F4 100%)`,
  surface: '#F7FAFA', card: WEB ? 'rgba(255,255,255,0.66)' : '#FFFFFF', cardAlt: WEB ? 'rgba(255,255,255,0.58)' : '#F0F5F6',
  border: WEB ? 'rgba(255,255,255,0.9)' : '#DCE6E8', hairline: 'rgba(14,42,48,0.12)',
  text: '#0E2A30', textSecondary: '#2F4A50', textMuted: '#62797E',
  accent: '#0F6E7A', accentSoft: 'rgba(15,110,122,0.12)', onAccent: '#FFFFFF',
  yellow: '#FFB547', onYellow: '#0E2A30',
  danger: '#B3261E', dangerSoft: 'rgba(179,38,30,0.10)', warning: '#8A5A00', warningSoft: 'rgba(255,181,71,0.24)',
  good: '#1E7A46', goodSoft: 'rgba(30,122,70,0.12)',
  nav: WEB ? 'rgba(255,255,255,0.62)' : '#FFFFFF', shadow: 'rgba(14,42,48,0.10)', overlay: 'rgba(8,24,28,0.40)',
  series: SERIES_LIGHT,
};
const DARK: typeof LIGHT = {
  dark: true,
  glass: WEB,
  bg: '#0C1A1F', screenBg: WEB ? 'transparent' : '#0C1A1F',
  bgImage: `radial-gradient(1000px 620px at -5% -10%, rgba(15,110,122,0.55), transparent 60%),
    radial-gradient(900px 560px at 105% 0%, rgba(255,181,71,0.14), transparent 62%),
    radial-gradient(800px 600px at 60% 115%, rgba(15,110,122,0.30), transparent 60%),
    linear-gradient(180deg, #0A161A 0%, #10222A 100%)`,
  surface: '#0F1E24', card: WEB ? 'rgba(22,44,52,0.58)' : '#13262D', cardAlt: WEB ? 'rgba(255,255,255,0.06)' : '#183038',
  border: WEB ? 'rgba(255,255,255,0.10)' : '#22404A', hairline: 'rgba(255,255,255,0.09)',
  text: '#EEF6F7', textSecondary: '#C6D8DB', textMuted: '#87A2A7',
  accent: '#4FD1C5', accentSoft: 'rgba(79,209,197,0.16)', onAccent: '#0C1A1F',
  yellow: '#FFB547', onYellow: '#0C1A1F',
  danger: '#FF8A80', dangerSoft: 'rgba(255,138,128,0.14)', warning: '#FFC94D', warningSoft: 'rgba(255,201,77,0.14)',
  good: '#7EE2A8', goodSoft: 'rgba(126,226,168,0.14)',
  nav: WEB ? 'rgba(12,26,31,0.62)' : '#0F1E24', shadow: 'rgba(0,0,0,0.45)', overlay: 'rgba(0,0,0,0.6)',
  series: SERIES_DARK,
};


export function useTheme() {
  const system = useColorScheme();
  const mode = useThemeMode((s) => s.mode);
  const dark = mode === 'dark' || (mode === 'system' && system === 'dark');
  return dark ? DARK : LIGHT;
}
export type Theme = ReturnType<typeof useTheme>;

/** Stable colour for a warehouse given the full sorted list of warehouse codes. */
export const seriesColor = (t: Theme, allCodes: string[], code: string) =>
  t.series[[...allCodes].sort().indexOf(code) % t.series.length] ?? t.textMuted;

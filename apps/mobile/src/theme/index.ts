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

const LIGHT = {
  dark: false,
  bg: '#f3f4f7',          // page background
  surface: '#f3f4f7',
  card: '#ffffff',
  cardAlt: '#f7f8fa',     // inner panels, table headers
  border: '#e2e4ea',
  text: '#11141a',
  textSecondary: '#4a5060',
  textMuted: '#7b8190',
  accent: '#2563eb',
  accentSoft: '#e6eefd',
  onAccent: '#ffffff',
  danger: '#c5221f',
  dangerSoft: '#fde8e7',
  warning: '#a86500',
  warningSoft: '#fff3dc',
  good: '#0f7b3a',
  goodSoft: '#e3f5ea',
  nav: '#ffffff',         // sidebar / tab bar
  shadow: 'rgba(16,24,40,0.08)',
  overlay: 'rgba(0,0,0,0.45)',
  series: SERIES_LIGHT,
};
const DARK: typeof LIGHT = {
  dark: true,
  bg: '#0f1115',
  surface: '#0f1115',
  card: '#181b21',
  cardAlt: '#1f232b',
  border: '#2c313b',
  text: '#eef0f4',
  textSecondary: '#b8bdc8',
  textMuted: '#868c99',
  accent: '#5b8ff9',
  accentSoft: '#1c2a45',
  onAccent: '#ffffff',
  danger: '#ff6b5e',
  dangerSoft: '#3a1d1b',
  warning: '#f2b33d',
  warningSoft: '#3a2c12',
  good: '#3ccf7a',
  goodSoft: '#16301f',
  nav: '#14171c',
  shadow: 'rgba(0,0,0,0.5)',
  overlay: 'rgba(0,0,0,0.65)',
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

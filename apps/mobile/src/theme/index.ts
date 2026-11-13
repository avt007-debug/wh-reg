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
 * Racing red, white and yellow, with a frosted-glass finish.
 * On the web (browser / home-screen app) panels are see-through with a blur over a soft
 * red-and-yellow glow; on native phones the same colours are used without the blur.
 */
const WEB = Platform.OS === 'web';
const RED = '#D40000';          // rosso
const YELLOW = '#FFCC00';       // giallo

const LIGHT = {
  dark: false,
  glass: WEB,
  bg: '#FFF9F3',                                   // solid page colour (status bar, native)
  screenBg: WEB ? 'transparent' : '#FFF9F3',       // pages let the glow show through on web
  bgImage: `radial-gradient(1100px 620px at -5% -10%, rgba(212,0,0,0.30), transparent 60%),
    radial-gradient(900px 560px at 105% 0%, rgba(255,204,0,0.55), transparent 62%),
    radial-gradient(800px 600px at 60% 115%, rgba(212,0,0,0.16), transparent 60%),
    linear-gradient(180deg, #FFFDF8 0%, #FFF4EE 100%)`,
  surface: '#FFFAF5',                              // full-screen sheets (always solid)
  card: WEB ? 'rgba(255,255,255,0.58)' : '#FFFFFF',
  cardAlt: WEB ? 'rgba(255,255,255,0.55)' : '#FFF6EE',
  border: WEB ? 'rgba(255,255,255,0.85)' : '#F1E3D8',
  hairline: 'rgba(120,20,20,0.12)',
  text: '#1A0B0B',
  textSecondary: '#4E3434',
  textMuted: '#806666',
  accent: RED,
  accentSoft: 'rgba(212,0,0,0.10)',
  onAccent: '#FFFFFF',
  yellow: YELLOW,
  onYellow: '#1A0B0B',
  danger: '#8E0A1C',
  dangerSoft: 'rgba(142,10,28,0.10)',
  warning: '#9A6200',
  warningSoft: 'rgba(255,204,0,0.22)',
  good: '#0E7A3A',
  goodSoft: 'rgba(14,122,58,0.12)',
  nav: WEB ? 'rgba(255,255,255,0.55)' : '#FFFFFF',
  shadow: 'rgba(120,10,10,0.10)',
  overlay: 'rgba(40,0,0,0.40)',
  series: SERIES_LIGHT,
};
const DARK: typeof LIGHT = {
  dark: true,
  glass: WEB,
  bg: '#120709',
  screenBg: WEB ? 'transparent' : '#120709',
  bgImage: `radial-gradient(1100px 620px at -5% -10%, rgba(212,0,0,0.42), transparent 60%),
    radial-gradient(900px 560px at 105% 0%, rgba(255,204,0,0.16), transparent 62%),
    radial-gradient(800px 600px at 60% 115%, rgba(212,0,0,0.22), transparent 60%),
    linear-gradient(180deg, #0E0607 0%, #170A0C 100%)`,
  surface: '#160A0C',
  card: WEB ? 'rgba(40,18,20,0.52)' : '#1E0F11',
  cardAlt: WEB ? 'rgba(255,255,255,0.06)' : '#261416',
  border: WEB ? 'rgba(255,255,255,0.12)' : '#3A2224',
  hairline: 'rgba(255,255,255,0.10)',
  text: '#FFF6F2',
  textSecondary: '#E2C9C6',
  textMuted: '#AE8E8B',
  accent: '#FF2A2A',
  accentSoft: 'rgba(255,42,42,0.16)',
  onAccent: '#FFFFFF',
  yellow: '#FFD60A',
  onYellow: '#1A0B0B',
  danger: '#FF7A85',
  dangerSoft: 'rgba(255,122,133,0.14)',
  warning: '#FFD60A',
  warningSoft: 'rgba(255,214,10,0.14)',
  good: '#46D484',
  goodSoft: 'rgba(70,212,132,0.14)',
  nav: WEB ? 'rgba(24,10,12,0.55)' : '#160A0C',
  shadow: 'rgba(0,0,0,0.45)',
  overlay: 'rgba(0,0,0,0.60)',
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

import { useColorScheme } from 'react-native';

/**
 * Chart series colours are assigned by WAREHOUSE (entity), in fixed order of
 * warehouse code — never by rank — so "WHA" is always slot 1 everywhere.
 * Palette validated for CVD separation (light + dark). Slots 3–4 are below 3:1
 * contrast on the light surface, so every chart ships with a legend and a
 * value table beneath it (see components/Chart.tsx).
 */
const SERIES_LIGHT = ['#2a78d6', '#eb6834', '#1baf7a', '#eda100', '#e87ba4', '#008300'];
const SERIES_DARK = ['#3987e5', '#d95926', '#199e70', '#c98500', '#d55181', '#008300'];

export function useTheme() {
  const dark = useColorScheme() === 'dark';
  return {
    dark,
    surface: dark ? '#1a1a19' : '#fcfcfb',
    card: dark ? '#242423' : '#ffffff',
    border: dark ? '#3a3a38' : '#e4e3df',
    text: dark ? '#f0efec' : '#0b0b0b',
    textSecondary: dark ? '#c3c2b7' : '#52514e',
    textMuted: dark ? '#8f8e86' : '#7a7973',
    accent: dark ? '#3987e5' : '#2a78d6',
    danger: dark ? '#ff6b5e' : '#c5221f',
    warning: dark ? '#f2b33d' : '#b06f00',
    good: '#008300',
    series: dark ? SERIES_DARK : SERIES_LIGHT,
  };
}
export type Theme = ReturnType<typeof useTheme>;

/** Stable colour for a warehouse given the full sorted list of warehouse codes. */
export const seriesColor = (t: Theme, allCodes: string[], code: string) =>
  t.series[[...allCodes].sort().indexOf(code) % t.series.length] ?? t.textMuted;

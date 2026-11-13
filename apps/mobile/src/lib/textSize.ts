/** Bigger text option: scales the whole app on this phone (saved on the phone). */
import { Platform } from 'react-native';
import { create } from 'zustand';

export const SIZES = [1, 1.15, 1.3] as const;
const KEY = 'whreg.textScale';
const read = (): number => { try { const v = Number(Platform.OS === 'web' ? localStorage.getItem(KEY) : 1); return (SIZES as readonly number[]).includes(v) ? v : 1; } catch { return 1; } };
export function applyScale(v: number) {
  if (Platform.OS !== 'web') return;
  const root = document.getElementById('root') ?? document.body;
  (root.style as CSSStyleDeclaration & { zoom: string }).zoom = v === 1 ? '' : String(v);
}
export const useTextSize = create<{ scale: number; set: (v: number) => void }>((set) => ({
  scale: read(),
  set: (v) => { try { if (Platform.OS === 'web') localStorage.setItem(KEY, String(v)); } catch { /* ignore */ } applyScale(v); set({ scale: v }); },
}));

/**
 * This phone / computer: a random ID kept on the device (for login history and device approval),
 * a readable name ("Android phone · Chrome"), the User IDs recently used here, and the optional
 * app PIN that unlocks the app after it auto-locks.
 */
import * as Crypto from 'expo-crypto';
import { Platform } from 'react-native';

const KEY_ID = 'whreg.device';
const KEY_IDS = 'whreg.recentIds';
const KEY_PIN = 'whreg.pin';

const ls = (): Storage | null => { try { return Platform.OS === 'web' ? globalThis.localStorage ?? null : null; } catch { return null; } };
const mem = new Map<string, string>();
const get = (k: string) => ls()?.getItem(k) ?? mem.get(k) ?? null;
const set = (k: string, v: string) => { try { ls()?.setItem(k, v); } catch { /* private mode */ } mem.set(k, v); };
const del = (k: string) => { try { ls()?.removeItem(k); } catch { /* ignore */ } mem.delete(k); };

export function deviceId(): string {
  let id = get(KEY_ID);
  if (!id) { id = `dev-${Crypto.randomUUID()}`; set(KEY_ID, id); }
  return id;
}

export function deviceName(): string {
  if (Platform.OS !== 'web') return `${Platform.OS === 'ios' ? 'iPhone' : 'Android'} app`;
  const ua = globalThis.navigator?.userAgent ?? '';
  const os = /Android/i.test(ua) ? 'Android phone' : /iPhone|iPad/i.test(ua) ? 'iPhone' : /Windows/i.test(ua) ? 'Windows computer'
    : /Mac OS/i.test(ua) ? 'Mac' : /Linux/i.test(ua) ? 'Linux computer' : 'Browser';
  const br = /Edg\//.test(ua) ? 'Edge' : /SamsungBrowser/.test(ua) ? 'Samsung Internet' : /Chrome\//.test(ua) ? 'Chrome'
    : /Firefox\//.test(ua) ? 'Firefox' : /Safari\//.test(ua) ? 'Safari' : '';
  const installed = globalThis.matchMedia?.('(display-mode: standalone)').matches ? ' (home-screen app)' : '';
  return `${os}${br ? ` · ${br}` : ''}${installed}`;
}
export const userAgent = () => (Platform.OS === 'web' ? globalThis.navigator?.userAgent ?? '' : Platform.OS);

/** User IDs that logged in on this device, most recent first (max 5). */
export function recentIds(): string[] {
  try { return JSON.parse(get(KEY_IDS) ?? '[]') as string[]; } catch { return []; }
}
export function rememberId(id: string) {
  const v = id.trim().toLowerCase();
  set(KEY_IDS, JSON.stringify([v, ...recentIds().filter((x) => x !== v)].slice(0, 5)));
}
export function forgetId(id: string) { set(KEY_IDS, JSON.stringify(recentIds().filter((x) => x !== id))); }

// ---- app PIN (per person, per device). Stored as a salted SHA-256 hash, never the PIN itself.
interface PinRec { user: string; salt: string; hash: string; fails: number }
const hashPin = (pin: string, salt: string) => Crypto.digestStringAsync(Crypto.CryptoDigestAlgorithm.SHA256, `${salt}:${pin}`);
function pinRec(): PinRec | null { try { return JSON.parse(get(KEY_PIN) ?? 'null') as PinRec | null; } catch { return null; } }
export const hasPin = (userId: string) => pinRec()?.user === userId;
export async function setPin(userId: string, pin: string) {
  const salt = Crypto.randomUUID();
  set(KEY_PIN, JSON.stringify({ user: userId, salt, hash: await hashPin(pin, salt), fails: 0 } satisfies PinRec));
}
export const clearPin = () => del(KEY_PIN);
/** true = correct; false = wrong; null = too many wrong tries (PIN removed, password needed). */
export async function checkPin(userId: string, pin: string): Promise<boolean | null> {
  const r = pinRec();
  if (!r || r.user !== userId) return null;
  if (r.hash === await hashPin(pin, r.salt)) { set(KEY_PIN, JSON.stringify({ ...r, fails: 0 })); return true; }
  if (r.fails + 1 >= 5) { clearPin(); return null; }
  set(KEY_PIN, JSON.stringify({ ...r, fails: r.fails + 1 }));
  return false;
}

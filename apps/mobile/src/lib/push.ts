/**
 * Phone notifications (Web Push) for the installed web app.
 *   • Android (Chrome / installed app): works directly.
 *   • iPhone: iOS 16.4+ and only after "Add to Home Screen" — opened from the Home Screen icon.
 * The subscription is saved per person; signing out removes it from this phone.
 */
import { Platform } from 'react-native';
import { rpc } from '../api/client';

export type PushState = 'unsupported' | 'ios-needs-install' | 'denied' | 'off' | 'on';

const web = () => Platform.OS === 'web' && typeof window !== 'undefined' && typeof navigator !== 'undefined';

/** Folder the app is served from (e.g. /wh-reg/), taken from the manifest link. */
export function appBase(): string {
  if (!web()) return '/';
  const href = document.querySelector('link[rel="manifest"]')?.getAttribute('href');
  if (href) return new URL(href.replace(/manifest\.webmanifest$/, ''), location.href).pathname;
  return '/';
}

export const isIOS = () => web() && /iPad|iPhone|iPod/.test(navigator.userAgent);
export const isStandalone = () => web() && (window.matchMedia?.('(display-mode: standalone)').matches || (navigator as { standalone?: boolean }).standalone === true);

export function deviceLabel(): string {
  if (!web()) return 'Phone';
  const ua = navigator.userAgent;
  const os = /Android/.test(ua) ? 'Android phone' : /iPhone/.test(ua) ? 'iPhone' : /iPad/.test(ua) ? 'iPad'
    : /Windows/.test(ua) ? 'Windows computer' : /Mac/.test(ua) ? 'Mac' : 'Device';
  const br = /Edg\//.test(ua) ? 'Edge' : /SamsungBrowser/.test(ua) ? 'Samsung Internet' : /Firefox/.test(ua) ? 'Firefox'
    : /Chrome\//.test(ua) ? 'Chrome' : /Safari/.test(ua) ? 'Safari' : 'Browser';
  return `${os} · ${br}${isStandalone() ? ' (home-screen app)' : ''}`;
}

const supported = () => web() && 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;

let regPromise: Promise<ServiceWorkerRegistration | null> | null = null;
/** Registers the service worker once (called at app start). */
export function registerServiceWorker(): Promise<ServiceWorkerRegistration | null> {
  if (!web() || !('serviceWorker' in navigator)) return Promise.resolve(null);
  regPromise ??= navigator.serviceWorker.register(`${appBase()}sw.js`, { scope: appBase() }).catch(() => null);
  return regPromise;
}

export async function pushState(): Promise<PushState> {
  if (!supported()) return isIOS() && !isStandalone() ? 'ios-needs-install' : 'unsupported';
  if (Notification.permission === 'denied') return 'denied';
  const reg = await registerServiceWorker();
  const sub = await reg?.pushManager.getSubscription();
  return sub && Notification.permission === 'granted' ? 'on' : 'off';
}

function keyBytes(b64: string): Uint8Array<ArrayBuffer> {
  const p = b64.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((b64.length + 3) % 4);
  const bin = atob(p);
  const out = new Uint8Array(new ArrayBuffer(bin.length));
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** Ask permission, subscribe this phone and save it for the signed-in person. */
export async function enablePush(): Promise<PushState> {
  if (!supported()) return isIOS() && !isStandalone() ? 'ios-needs-install' : 'unsupported';
  const perm = await Notification.requestPermission();
  if (perm !== 'granted') return perm === 'denied' ? 'denied' : 'off';
  const key = await rpc<string | null>('push_public_key');
  if (!key) throw new Error('Phone notifications are not switched on for this business yet.');
  const reg = await registerServiceWorker();
  if (!reg) throw new Error('This browser could not start notifications. Open the app from its home-screen icon and try again.');
  await navigator.serviceWorker.ready;
  let sub = await reg.pushManager.getSubscription();
  const want = keyBytes(key);
  const have = sub?.options.applicationServerKey ? new Uint8Array(sub.options.applicationServerKey) : null;
  if (sub && (!have || have.length !== want.length || have.some((b, i) => b !== want[i]))) { await sub.unsubscribe(); sub = null; }
  sub ??= await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: want });
  const j = sub.toJSON();
  await rpc('save_push_subscription', { p: { endpoint: j.endpoint, p256dh: j.keys?.p256dh, auth: j.keys?.auth, device: deviceLabel() } });
  return 'on';
}

/** Re-save the subscription after sign-in (another person may have used this phone before). */
export async function refreshPushOwner(): Promise<void> {
  try {
    if (!supported() || Notification.permission !== 'granted') return;
    const reg = await registerServiceWorker();
    const sub = await reg?.pushManager.getSubscription();
    if (!sub) return;
    const j = sub.toJSON();
    await rpc('save_push_subscription', { p: { endpoint: j.endpoint, p256dh: j.keys?.p256dh, auth: j.keys?.auth, device: deviceLabel() } });
  } catch { /* best effort */ }
}

/** On sign-out: stop this phone getting the person's notifications. */
export async function disablePush(): Promise<void> {
  try {
    if (!supported()) return;
    const reg = await registerServiceWorker();
    const sub = await reg?.pushManager.getSubscription();
    if (!sub) return;
    await rpc('delete_push_subscription', { p_endpoint: sub.endpoint }).catch(() => undefined);
    await sub.unsubscribe();
  } catch { /* best effort */ }
}

/**
 * Bills saved with no internet wait here (on this phone) and are sent automatically when the connection is back.
 * Safe to retry: every bill carries its own id (clientTxnId), so the server never saves it twice.
 */
import { Platform } from 'react-native';
import { create } from 'zustand';

export interface QueuedBill { id: string; fn: 'create_dispatch' | 'create_purchase' | 'record_customer_payment'; args: Record<string, unknown>;
  label: string; queuedAt: string; error?: string }
const KEY = 'whreg.outbox';
const read = (): QueuedBill[] => { try { return Platform.OS === 'web' ? JSON.parse(localStorage.getItem(KEY) ?? '[]') : []; } catch { return []; } };
const write = (q: QueuedBill[]) => { try { if (Platform.OS === 'web') localStorage.setItem(KEY, JSON.stringify(q)); } catch { /* full */ } };

export const useOutbox = create<{ items: QueuedBill[]; add: (b: QueuedBill) => void; remove: (id: string) => void; fail: (id: string, e: string) => void; retry: (id: string) => void; reload: () => void }>((set) => ({
  items: read(),
  add: (b) => set((s) => { const items = [...s.items.filter((x) => x.id !== b.id), b]; write(items); return { items }; }),
  remove: (id) => set((s) => { const items = s.items.filter((x) => x.id !== id); write(items); return { items }; }),
  fail: (id, e) => set((s) => { const items = s.items.map((x) => (x.id === id ? { ...x, error: e } : x)); write(items); return { items }; }),
  retry: (id) => set((s) => { const items = s.items.map((x) => (x.id === id ? { ...x, error: undefined } : x)); write(items); return { items }; }),
  reload: () => set({ items: read() }),
}));

/** True when the error means "could not reach the server" (not a business rule). */
export function isOffline(e: unknown): boolean {
  const msg = e instanceof Error ? e.message : String(e);
  const nav = (globalThis as { navigator?: { onLine?: boolean } }).navigator;
  return nav?.onLine === false || /failed to fetch|network ?error|load failed|networkrequestfailed|fetch failed|timed? ?out/i.test(msg);
}

/** Draft of an unfinished bill, per user and kind. */
export const draftKey = (kind: string, userId: string | undefined) => `whreg.draft.${kind}.${userId ?? 'x'}`;
export function loadDraft<T>(key: string): (T & { savedAt: string }) | null {
  try { return Platform.OS === 'web' ? JSON.parse(localStorage.getItem(key) ?? 'null') : null; } catch { return null; }
}
export function saveDraft(key: string, v: object | null) {
  try { if (Platform.OS !== 'web') return; if (v) localStorage.setItem(key, JSON.stringify({ ...v, savedAt: new Date().toISOString() })); else localStorage.removeItem(key); } catch { /* full */ }
}

import * as SecureStore from 'expo-secure-store';
import { create } from 'zustand';
import type { Role } from '@wh/shared';

export interface SessionUser { id: string; fullName: string; role: Role; warehouseId: string | null }

interface AuthState {
  user: SessionUser | null;
  accessToken: string | null;
  refreshToken: string | null;
  hydrated: boolean;
  setSession: (s: { user: SessionUser; accessToken: string; refreshToken: string }) => Promise<void>;
  clear: () => Promise<void>;
  hydrate: () => Promise<void>;
}

const KEY = 'whreg.session.v1';

/** Tokens live in the OS keystore (Keychain / Android Keystore), never AsyncStorage. */
export const useAuth = create<AuthState>((set) => ({
  user: null,
  accessToken: null,
  refreshToken: null,
  hydrated: false,
  async setSession(s) {
    await SecureStore.setItemAsync(KEY, JSON.stringify(s));
    set({ ...s });
  },
  async clear() {
    await SecureStore.deleteItemAsync(KEY);
    set({ user: null, accessToken: null, refreshToken: null });
  },
  async hydrate() {
    const raw = await SecureStore.getItemAsync(KEY);
    set({ ...(raw ? JSON.parse(raw) : {}), hydrated: true });
  },
}));

export const isOwner = (u: SessionUser | null) => !!u && (u.role === 'OWNER' || u.role === 'ADMIN');

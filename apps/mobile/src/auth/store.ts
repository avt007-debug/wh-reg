import { create } from 'zustand';
import type { Role } from '@wh/shared';
import type { Me } from '../api/types';
import { rpc } from '../api/client';
import { queryClient } from '../lib/queryClient';
import { loginEmail, supabase } from '../lib/supabase';

export interface SessionUser { id: string; fullName: string; role: Role; warehouseId: string | null }

interface AuthState {
  user: SessionUser | null;
  hydrated: boolean;
  /** Supabase Auth keeps the session (encrypted on device); we load the staff profile via me(). */
  hydrate: () => Promise<void>;
  signIn: (loginId: string, password: string) => Promise<void>;
  signOut: () => Promise<void>;
}

async function loadProfile(): Promise<SessionUser | null> {
  const me = await rpc<Me | null>('me');
  if (!me) return null;                     // auth user exists but no active staff profile
  return { id: me.id, fullName: me.full_name, role: me.role as Role, warehouseId: me.warehouse_id };
}

export const useAuth = create<AuthState>((set) => ({
  user: null,
  hydrated: false,
  async hydrate() {
    const { data } = await supabase.auth.getSession();
    const user = data.session ? await loadProfile().catch(() => null) : null;
    set({ user, hydrated: true });
    supabase.auth.onAuthStateChange((event) => {
      if (event === 'SIGNED_OUT') { queryClient.clear(); set({ user: null }); }
    });
  },
  async signIn(loginId, password) {
    const { error } = await supabase.auth.signInWithPassword({ email: loginEmail(loginId), password });
    if (error) throw new Error(error.status === 400 ? 'Invalid User ID or password' : error.message);
    queryClient.clear();                     // never show cached data from a previous login
    const user = await loadProfile();
    if (!user) {
      await supabase.auth.signOut();
      throw new Error('This login is disabled. Contact the owner.');
    }
    set({ user });
  },
  async signOut() {
    await supabase.auth.signOut().catch(() => undefined);   // still log out locally if offline
    queryClient.clear();
    set({ user: null });
  },
}));

export const isOwner = (u: SessionUser | null) => !!u && (u.role === 'OWNER' || u.role === 'ADMIN');

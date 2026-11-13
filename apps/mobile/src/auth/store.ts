import { create } from 'zustand';
import type { Role } from '@wh/shared';
import type { Me } from '../api/types';
import { rpc } from '../api/client';
import { deviceId, deviceName, rememberId, userAgent } from '../lib/device';
import { queryClient } from '../lib/queryClient';
import { loginEmail, supabase } from '../lib/supabase';

export interface SessionUser { id: string; fullName: string; role: Role; warehouseId: string | null; loginId: string }

/** What the server says about this person on this device right now. */
export interface Access { allowed: boolean; reason?: string; session_version?: number; idle_minutes?: number; from?: string; to?: string }

interface AuthState {
  user: SessionUser | null;
  hydrated: boolean;
  access: Access | null;
  /** Why the person was signed out (shown on the login screen). */
  notice: string | null;
  /** App locked after inactivity: session kept, PIN or password needed. */
  locked: boolean;
  hydrate: () => Promise<void>;
  signIn: (loginId: string, password: string) => Promise<void>;
  signOut: (notice?: string | null) => Promise<void>;
  check: () => Promise<void>;
  lock: () => void;
  unlock: () => void;
}

async function loadProfile(): Promise<SessionUser | null> {
  const me = await rpc<Me | null>('me');
  if (!me) return null;                     // auth user exists but no active staff profile
  return { id: me.id, fullName: me.full_name, role: me.role as Role, warehouseId: me.warehouse_id, loginId: me.login_id };
}

/** Plain-language reason for a refused / ended session. */
export function accessMessage(a: Access | null): string {
  switch (a?.reason) {
    case 'DISABLED': return 'This login is turned off. Please contact the owner.';
    case 'OUTSIDE_HOURS': return `Employees can log in only between ${a.from} and ${a.to}.`;
    case 'DEVICE_PENDING': return 'This phone/computer is new for your login. The owner has been asked to approve it — try again after they do.';
    case 'DEVICE_BLOCKED': return 'This phone/computer has been blocked for your login. Please contact the owner.';
    case 'SIGNED_OUT_BY_OWNER': return 'You were signed out because the owner changed your access or password. Please log in again.';
    default: return 'Your session has ended. Please log in again.';
  }
}

async function startSession(): Promise<Access> {
  return rpc<Access>('session_start', { p_device_id: deviceId(), p_device_name: deviceName(), p_user_agent: userAgent() });
}

export const useAuth = create<AuthState>((set, get) => ({
  user: null,
  hydrated: false,
  access: null,
  notice: null,
  locked: false,
  async hydrate() {
    const { data } = await supabase.auth.getSession();
    const user = data.session ? await loadProfile().catch(() => null) : null;
    let access: Access | null = null;
    if (user) {
      access = await rpc<Access>('session_check', { p_device_id: deviceId(), p_version: null }).catch(() => null);
      if (access && !access.allowed) {
        await supabase.auth.signOut().catch(() => undefined);
        set({ user: null, access: null, notice: accessMessage(access), hydrated: true });
        return;
      }
    }
    set({ user, access, hydrated: true });
    supabase.auth.onAuthStateChange((event) => {
      if (event === 'SIGNED_OUT') { queryClient.clear(); set({ user: null, locked: false }); }
    });
  },
  async signIn(loginId, password) {
    const id = loginId.trim();
    const pre = await rpc<{ locked_until: string | null }>('login_precheck', { p_login_id: id }).catch(() => ({ locked_until: null }));
    if (pre.locked_until) throw new Error(`Too many wrong passwords. Try again after ${new Date(pre.locked_until).toLocaleTimeString('en-IN', { hour: 'numeric', minute: '2-digit', timeZone: 'Asia/Kolkata' })}, or ask the owner to unlock it.`);
    const { error } = await supabase.auth.signInWithPassword({ email: loginEmail(id), password });
    if (error) {
      if (error.status === 400) {
        const after = await rpc<{ locked_until: string | null }>('login_failed', { p_login_id: id, p_device_id: deviceId(), p_device_name: deviceName() }).catch(() => null);
        if (after?.locked_until) throw new Error('Too many wrong passwords — this User ID is locked for a few minutes. The owner has been told.');
        throw new Error('Invalid User ID or password');
      }
      throw new Error(error.message);
    }
    queryClient.clear();                     // never show cached data from a previous login
    const user = await loadProfile();
    if (!user) {
      await supabase.auth.signOut();
      throw new Error('This login is disabled. Contact the owner.');
    }
    const access = await startSession();
    if (!access.allowed) {
      await supabase.auth.signOut();
      throw new Error(accessMessage(access));
    }
    rememberId(id);
    set({ user, access, notice: null, locked: false });
  },
  async signOut(notice = null) {
    await supabase.auth.signOut().catch(() => undefined);   // still log out locally if offline
    queryClient.clear();
    set({ user: null, access: null, notice, locked: false });
  },
  /** Re-check access (every 2 minutes and when the app comes back): disabled / removed / new password / hours / device. */
  async check() {
    const { user, access } = get();
    if (!user) return;
    const a = await rpc<Access>('session_check', { p_device_id: deviceId(), p_version: access?.session_version ?? null }).catch(() => null);
    if (a && !a.allowed) await get().signOut(accessMessage(a));
    else if (a) set({ access: { ...a, session_version: access?.session_version ?? a.session_version } });
  },
  lock: () => { if (get().user) set({ locked: true }); },
  unlock: () => set({ locked: false }),
}));

export const isOwner = (u: SessionUser | null) => !!u && (u.role === 'OWNER' || u.role === 'ADMIN');

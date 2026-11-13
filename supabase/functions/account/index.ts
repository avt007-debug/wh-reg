/**
 * account — self-service for any person with a login (owner or employee).
 *
 *   { action: 'change_password', currentPassword, newPassword }   // needs the person's own session token
 *   { action: 'recover', loginId, code, newPassword }             // owner only, no session: one-time recovery code
 *
 * Employees' new passwords are also saved (encrypted, Vault) so the owner can still look them up.
 */
import { createClient } from 'npm:@supabase/supabase-js@2.119.0';
import { adminClient, json } from '../_shared/supabase.ts';

const DOMAIN = Deno.env.get('LOGIN_EMAIL_DOMAIN') ?? 'staff.whreg.app';
export const passwordProblem = (p: unknown): string | null =>
  typeof p !== 'string' || p.length < 8 ? 'New password: at least 8 characters'
  : p.length > 72 ? 'New password: at most 72 characters'
  : /^\s|\s$/.test(p) ? 'New password cannot start or end with a space'
  : null;

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return json({ ok: true });
  if (req.method !== 'POST') return json({ error: 'method not allowed' }, 405);
  const db = adminClient();
  const b = await req.json().catch(() => ({}));

  if (b.action === 'change_password') {
    const token = (req.headers.get('Authorization') ?? '').replace(/^Bearer\s+/i, '');
    const { data: auth, error } = await db.auth.getUser(token);
    if (error || !auth.user?.email) return json({ error: 'not signed in' }, 401);
    const problem = passwordProblem(b.newPassword);
    if (problem) return json({ error: problem }, 422);
    if (b.newPassword === b.currentPassword) return json({ error: 'The new password is the same as the current one' }, 422);
    // Check the current password with a throw-away client (does not touch the caller's session).
    const probe = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_ANON_KEY')!, { auth: { persistSession: false, autoRefreshToken: false } });
    const { error: wrong } = await probe.auth.signInWithPassword({ email: auth.user.email, password: String(b.currentPassword ?? '') });
    if (wrong) return json({ error: 'Your current password is not correct' }, 403);
    const { error: upd } = await db.auth.admin.updateUserById(auth.user.id, { password: b.newPassword });
    if (upd) return json({ error: upd.message }, 422);
    const { data: me } = await db.from('users').select('role').eq('id', auth.user.id).maybeSingle();
    if (me && me.role !== 'OWNER') await db.rpc('svc_store_staff_password', { p_user: auth.user.id, p_password: b.newPassword });
    return json({ ok: true });
  }

  if (b.action === 'recover') {
    const problem = passwordProblem(b.newPassword);
    if (problem) return json({ error: problem }, 422);
    const { data: uid } = await db.rpc('svc_use_recovery_code', { p_login_id: String(b.loginId ?? ''), p_code: String(b.code ?? '') });
    if (!uid) return json({ error: 'That User ID and recovery code do not match (or too many tries — wait 15 minutes).' }, 403);
    const { error } = await db.auth.admin.updateUserById(uid as string, { password: b.newPassword, email: `${String(b.loginId).trim().toLowerCase()}@${DOMAIN}` });
    if (error) return json({ error: error.message }, 422);
    return json({ ok: true });
  }

  return json({ error: 'unknown action' }, 400);
});

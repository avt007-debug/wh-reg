/**
 * admin-users — owner-only staff login management (needs the Auth admin API,
 * which must never ship in the app). Called by the app with the owner's own
 * session token: supabase.functions.invoke('admin-users', { body }).
 *
 *   { action: 'create', loginId, fullName, phone?, role, primaryWarehouseId?, password, force? }  // 409 'duplicate' unless force
 *   { action: 'set_password', userId, password? }      // no password ⇒ a new one is generated and returned
 *   { action: 'update_profile', userId, loginId?, fullName?, phone?, primaryWarehouseId? }
 *   { action: 'set_active', userId, active }          // also bans/unbans the Auth user
 *   { action: 'remove', userId } / { action: 'restore', userId }   // soft remove: history is kept
 *
 * Passwords the owner sets for staff are also saved (encrypted, Supabase Vault)
 * so the owner can look them up later in Settings. Owner passwords never are.
 *
 * Staff never see e-mail addresses: User ID 'ravi.wha' ⇒ 'ravi.wha@<LOGIN_EMAIL_DOMAIN>'.
 */
import { adminClient, json } from '../_shared/supabase.ts';

const DOMAIN = Deno.env.get('LOGIN_EMAIL_DOMAIN') ?? 'staff.whreg.app';
const LOGIN_RE = /^[A-Za-z0-9._-]{3,32}$/;
const ROLES = ['OWNER', 'ADMIN', 'EMPLOYEE'];
const PHONE_RE = /^[6-9][0-9]{9}$/;

/** Easy to read out on the phone: no 0/O, 1/l/I. e.g. "Kmtr-4827-pq" */
function generatePassword(): string {
  const letters = 'abcdefghjkmnpqrstuvwxyz';
  const pick = (set: string, n: number) => Array.from(crypto.getRandomValues(new Uint32Array(n)), (x) => set[x % set.length]).join('');
  const digits = Array.from(crypto.getRandomValues(new Uint32Array(4)), (x) => String(2 + (x % 8))).join('');
  const w = pick(letters, 4);
  return `${w[0].toUpperCase()}${w.slice(1)}-${digits}-${pick(letters, 2)}`;
}
const cleanPhone = (p: unknown) => (typeof p === 'string' && p.trim() ? p.replace(/\D/g, '').slice(-10) : null);

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return json({ ok: true });
  if (req.method !== 'POST') return json({ error: 'method not allowed' }, 405);

  const db = adminClient();

  // ---- caller must be an active OWNER/ADMIN
  const token = (req.headers.get('Authorization') ?? '').replace(/^Bearer\s+/i, '');
  const { data: auth, error: authErr } = await db.auth.getUser(token);
  if (authErr || !auth.user) return json({ error: 'not signed in' }, 401);
  const { data: caller } = await db.from('users').select('role, is_active').eq('id', auth.user.id).maybeSingle();
  if (!caller?.is_active || !['OWNER', 'ADMIN'].includes(caller.role)) return json({ error: 'owner/admin only' }, 403);

  const b = await req.json().catch(() => ({}));
  // At least 8 characters — easy enough to type on a phone; the login locks after repeated wrong tries.
  const pwOk = (p: unknown) => typeof p === 'string' && p.length >= 8 && p.length <= 72 && !/^\s|\s$/.test(p);
  const PW_RULE = 'Password: at least 8 characters (no space at the start or end)';
  const revoke = (userId: string) => db.rpc('svc_revoke_sessions', { p_user: userId });

  if (b.action === 'create') {
    if (!LOGIN_RE.test(b.loginId ?? '')) return json({ error: 'User ID: 3–32 letters, digits, . _ -' }, 422);
    if (!ROLES.includes(b.role)) return json({ error: 'invalid role' }, 422);
    if (b.role === 'EMPLOYEE' && !b.primaryWarehouseId) return json({ error: 'Employees need a warehouse' }, 422);
    if (!pwOk(b.password)) return json({ error: PW_RULE }, 422);
    const phone = cleanPhone(b.phone);
    if (phone && !PHONE_RE.test(phone)) return json({ error: 'Mobile number must be 10 digits' }, 422);

    // Same person twice? (same name or same mobile among current logins) — ask before creating.
    if (!b.force) {
      const { data: same } = await db.from('users').select('login_id, full_name, phone').is('removed_at', null)
        .or([`full_name.ilike.${String(b.fullName ?? '').trim().replace(/[,()]/g, ' ')}`, phone ? `phone.eq.${phone}` : null].filter(Boolean).join(','));
      if (same?.length) return json({ error: 'duplicate', duplicates: same }, 409);
    }

    const { data: created, error } = await db.auth.admin.createUser({
      email: `${String(b.loginId).toLowerCase()}@${DOMAIN}`, password: b.password, email_confirm: true,
      user_metadata: { login_id: b.loginId, full_name: b.fullName },
    });
    if (error || !created.user) return json({ error: error?.message ?? 'could not create login' }, 409);

    const { error: insErr } = await db.from('users').insert({
      id: created.user.id, login_id: b.loginId, full_name: b.fullName, phone,
      role: b.role, primary_warehouse_id: b.primaryWarehouseId ?? null,
    });
    if (insErr) {                                            // keep Auth and users in step
      await db.auth.admin.deleteUser(created.user.id);
      return json({ error: insErr.message }, 422);
    }
    if (b.role !== 'OWNER') await db.rpc('svc_store_staff_password', { p_user: created.user.id, p_password: b.password });
    return json({ id: created.user.id, loginId: b.loginId }, 201);
  }

  if (b.action === 'set_password') {
    const password = b.password ? String(b.password) : generatePassword();
    if (b.password && !pwOk(password)) return json({ error: PW_RULE }, 422);
    const { data: target } = await db.from('users').select('role, login_id, full_name, phone').eq('id', b.userId).maybeSingle();
    if (!target) return json({ error: 'user not found' }, 404);
    if (target.role === 'OWNER' && b.userId !== auth.user.id && caller.role !== 'OWNER') return json({ error: 'only the owner can change an owner password' }, 403);
    const { error } = await db.auth.admin.updateUserById(b.userId, { password });
    if (error) return json({ error: error.message }, 422);
    if (target.role !== 'OWNER') await db.rpc('svc_store_staff_password', { p_user: b.userId, p_password: password });
    if (b.userId !== auth.user.id) await revoke(b.userId);       // old password stops working everywhere
    return json({ ok: true, password, loginId: target.login_id, fullName: target.full_name, phone: target.phone });
  }

  if (b.action === 'update_profile') {
    const { data: target } = await db.from('users').select('role, login_id').eq('id', b.userId).maybeSingle();
    if (!target) return json({ error: 'user not found' }, 404);
    const patch: Record<string, unknown> = {};
    if (b.fullName !== undefined) {
      if (!String(b.fullName).trim()) return json({ error: 'Name cannot be empty' }, 422);
      patch.full_name = String(b.fullName).trim();
    }
    if (b.phone !== undefined) {
      const phone = cleanPhone(b.phone);
      if (phone && !PHONE_RE.test(phone)) return json({ error: 'Mobile number must be 10 digits' }, 422);
      patch.phone = phone;
    }
    if (b.primaryWarehouseId !== undefined && target.role === 'EMPLOYEE') patch.primary_warehouse_id = b.primaryWarehouseId;
    if (b.loginId !== undefined && String(b.loginId) !== target.login_id) {
      if (!LOGIN_RE.test(b.loginId ?? '')) return json({ error: 'User ID: 3–32 letters, digits, . _ -' }, 422);
      const { data: taken } = await db.from('users').select('id').ilike('login_id', String(b.loginId)).neq('id', b.userId).maybeSingle();
      if (taken) return json({ error: `User ID ${b.loginId} is already taken` }, 409);
      const { error } = await db.auth.admin.updateUserById(b.userId, {
        email: `${String(b.loginId).toLowerCase()}@${DOMAIN}`, email_confirm: true, user_metadata: { login_id: b.loginId },
      });
      if (error) return json({ error: error.message }, 422);
      patch.login_id = b.loginId;
    }
    if (Object.keys(patch).length) {
      patch.updated_at = new Date().toISOString();
      const { error } = await db.from('users').update(patch).eq('id', b.userId);
      if (error) return json({ error: error.message }, 422);
    }
    return json({ ok: true });
  }

  if (b.action === 'remove' || b.action === 'restore') {
    if (b.userId === auth.user.id) return json({ error: 'You cannot remove yourself' }, 422);
    const removing = b.action === 'remove';
    const { error: e1 } = await db.from('users')
      .update({ is_active: !removing, removed_at: removing ? new Date().toISOString() : null }).eq('id', b.userId);
    const { error: e2 } = await db.auth.admin.updateUserById(b.userId, { ban_duration: removing ? '876000h' : 'none' });
    if (removing) await revoke(b.userId);
    return e1 || e2 ? json({ error: (e1 ?? e2)!.message }, 422) : json({ ok: true });
  }

  if (b.action === 'set_active') {
    if (b.userId === auth.user.id && !b.active) return json({ error: 'You cannot deactivate yourself' }, 422);
    const { error: e1 } = await db.from('users').update({ is_active: !!b.active }).eq('id', b.userId);
    // Banning revokes refresh; RLS already blocks the user the moment is_active = false.
    const { error: e2 } = await db.auth.admin.updateUserById(b.userId, { ban_duration: b.active ? 'none' : '876000h' });
    if (!b.active) await revoke(b.userId);
    return e1 || e2 ? json({ error: (e1 ?? e2)!.message }, 422) : json({ ok: true });
  }

  return json({ error: 'unknown action' }, 400);
});

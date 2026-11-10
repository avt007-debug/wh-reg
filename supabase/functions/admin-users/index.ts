/**
 * admin-users — owner-only staff login management (needs the Auth admin API,
 * which must never ship in the app). Called by the app with the owner's own
 * session token: supabase.functions.invoke('admin-users', { body }).
 *
 *   { action: 'create', loginId, fullName, phone?, role, primaryWarehouseId?, password }
 *   { action: 'set_password', userId, password }
 *   { action: 'set_active', userId, active }          // also bans/unbans the Auth user
 *
 * Staff never see e-mail addresses: User ID 'ravi.wha' ⇒ 'ravi.wha@<LOGIN_EMAIL_DOMAIN>'.
 */
import { adminClient, json } from '../_shared/supabase.ts';

const DOMAIN = Deno.env.get('LOGIN_EMAIL_DOMAIN') ?? 'staff.whreg.app';
const LOGIN_RE = /^[A-Za-z0-9._-]{3,32}$/;
const ROLES = ['OWNER', 'ADMIN', 'EMPLOYEE'];

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
  const pwOk = (p: unknown) => typeof p === 'string' && p.length >= 10 && /[A-Za-z]/.test(p) && /\d/.test(p);

  if (b.action === 'create') {
    if (!LOGIN_RE.test(b.loginId ?? '')) return json({ error: 'User ID: 3–32 letters, digits, . _ -' }, 422);
    if (!ROLES.includes(b.role)) return json({ error: 'invalid role' }, 422);
    if (b.role === 'EMPLOYEE' && !b.primaryWarehouseId) return json({ error: 'Employees need a warehouse' }, 422);
    if (!pwOk(b.password)) return json({ error: 'Password: at least 10 characters with letters and digits' }, 422);

    const { data: created, error } = await db.auth.admin.createUser({
      email: `${String(b.loginId).toLowerCase()}@${DOMAIN}`, password: b.password, email_confirm: true,
      user_metadata: { login_id: b.loginId, full_name: b.fullName },
    });
    if (error || !created.user) return json({ error: error?.message ?? 'could not create login' }, 409);

    const { error: insErr } = await db.from('users').insert({
      id: created.user.id, login_id: b.loginId, full_name: b.fullName, phone: b.phone ?? null,
      role: b.role, primary_warehouse_id: b.primaryWarehouseId ?? null,
    });
    if (insErr) {                                            // keep Auth and users in step
      await db.auth.admin.deleteUser(created.user.id);
      return json({ error: insErr.message }, 422);
    }
    return json({ id: created.user.id, loginId: b.loginId }, 201);
  }

  if (b.action === 'set_password') {
    if (!pwOk(b.password)) return json({ error: 'Password: at least 10 characters with letters and digits' }, 422);
    const { error } = await db.auth.admin.updateUserById(b.userId, { password: b.password });
    return error ? json({ error: error.message }, 422) : json({ ok: true });
  }

  if (b.action === 'set_active') {
    if (b.userId === auth.user.id && !b.active) return json({ error: 'You cannot deactivate yourself' }, 422);
    const { error: e1 } = await db.from('users').update({ is_active: !!b.active }).eq('id', b.userId);
    // Banning revokes refresh; RLS already blocks the user the moment is_active = false.
    const { error: e2 } = await db.auth.admin.updateUserById(b.userId, { ban_duration: b.active ? 'none' : '876000h' });
    return e1 || e2 ? json({ error: (e1 ?? e2)!.message }, 422) : json({ ok: true });
  }

  return json({ error: 'unknown action' }, 400);
});

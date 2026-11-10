import argon2 from 'argon2';
import type { FastifyInstance } from 'fastify';
import { loginSchema, refreshSchema, type Role } from '@wh/shared';
import { config } from '../../config.js';
import { withAuth, withSession } from '../../db/pool.js';
import { HttpError } from '../../lib/errors.js';
import { authenticate } from '../../auth/plugin.js';
import { hashToken, newRefreshToken, signAccessToken } from '../../auth/tokens.js';

const MAX_FAILS = 5;
const LOCK_MINUTES = 15;
// Verifying against a dummy hash keeps response time flat for unknown login ids.
const DUMMY_HASH = await argon2.hash('dummy-password-for-timing');

interface UserRow { id: string; role: Role; primary_warehouse_id: string | null; full_name: string }

async function issueTokens(u: UserRow, deviceLabel?: string) {
  const access = await signAccessToken({ sub: u.id, role: u.role, wh: u.primary_warehouse_id });
  const refresh = newRefreshToken();
  await withAuth((c) => c.query(
    `INSERT INTO auth.refresh_tokens(user_id, token_hash, device_label, expires_at)
     VALUES ($1, $2, $3, now() + make_interval(days => $4))`,
    [u.id, refresh.hash, deviceLabel ?? null, config.REFRESH_TOKEN_TTL_DAYS]));
  return {
    accessToken: access,
    refreshToken: refresh.token,
    user: { id: u.id, fullName: u.full_name, role: u.role, warehouseId: u.primary_warehouse_id },
  };
}

export async function authRoutes(app: FastifyInstance) {
  app.post('/auth/login', { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } }, async (req) => {
    const body = loginSchema.parse(req.body);

    const outcome = await withAuth(async (c) => {
      const { rows } = await c.query(
        `SELECT u.id, u.role, u.primary_warehouse_id, u.full_name, u.is_active,
                cr.password_hash, cr.failed_attempts, cr.locked_until > now() AS locked
           FROM users u JOIN auth.credentials cr ON cr.user_id = u.id
          WHERE u.login_id = $1`, [body.loginId]);
      const row = rows[0];
      const ok = await argon2.verify(row?.password_hash ?? DUMMY_HASH, body.password);
      if (!row || !row.is_active) return { kind: 'invalid' as const };
      if (row.locked) return { kind: 'locked' as const };
      if (!ok) {
        await c.query(
          `UPDATE auth.credentials SET failed_attempts = failed_attempts + 1,
                  locked_until = CASE WHEN failed_attempts + 1 >= $2 THEN now() + make_interval(mins => $3) END
            WHERE user_id = $1`, [row.id, MAX_FAILS, LOCK_MINUTES]);
        return { kind: 'invalid' as const };          // committed, so the failure counts
      }
      await c.query('UPDATE auth.credentials SET failed_attempts = 0, locked_until = NULL WHERE user_id = $1', [row.id]);
      await c.query('UPDATE users SET last_login_at = now() WHERE id = $1', [row.id]);
      return { kind: 'ok' as const, user: row as UserRow };
    });

    if (outcome.kind === 'locked') throw new HttpError(429, 'FORBIDDEN', `Account locked. Try again in ${LOCK_MINUTES} minutes.`);
    if (outcome.kind === 'invalid') throw new HttpError(401, 'UNAUTHENTICATED', 'Invalid user ID or password');
    return issueTokens(outcome.user, body.deviceLabel);
  });

  /** Rotating refresh tokens with reuse detection. */
  app.post('/auth/refresh', async (req) => {
    const { refreshToken } = refreshSchema.parse(req.body);
    const hash = hashToken(refreshToken);
    const user = await withAuth(async (c) => {
      const { rows } = await c.query(
        `SELECT t.id, t.user_id, t.revoked_at, t.expires_at < now() AS expired,
                u.role, u.primary_warehouse_id, u.full_name, u.is_active
           FROM auth.refresh_tokens t JOIN users u ON u.id = t.user_id WHERE t.token_hash = $1`, [hash]);
      const t = rows[0];
      if (!t) return null;
      if (t.revoked_at) {
        // A revoked token was replayed → assume theft, kill every session of this user.
        await c.query('UPDATE auth.refresh_tokens SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL', [t.user_id]);
        return null;
      }
      if (t.expired || !t.is_active) return null;
      await c.query('UPDATE auth.refresh_tokens SET revoked_at = now() WHERE id = $1', [t.id]);
      return { id: t.user_id, role: t.role, primary_warehouse_id: t.primary_warehouse_id, full_name: t.full_name } as UserRow;
    });
    if (!user) throw new HttpError(401, 'UNAUTHENTICATED', 'Please log in again');
    return issueTokens(user);
  });

  app.post('/auth/logout', async (req) => {
    const { refreshToken } = refreshSchema.parse(req.body);
    await withAuth((c) => c.query('UPDATE auth.refresh_tokens SET revoked_at = now() WHERE token_hash = $1', [hashToken(refreshToken)]));
    return { ok: true };
  });

  app.get('/me', { preHandler: authenticate }, async (req) =>
    withSession(req.auth, async (c) => {
      const { rows } = await c.query(
        `SELECT u.id, u.login_id, u.full_name, u.role, w.id AS warehouse_id, w.code AS warehouse_code, w.name AS warehouse_name, w.state_code AS warehouse_state
           FROM users u LEFT JOIN warehouses w ON w.id = u.primary_warehouse_id
          WHERE u.id = app.current_user_id()`);
      if (!rows[0]) throw new HttpError(401, 'UNAUTHENTICATED', 'User disabled');
      return rows[0];
    }));
}

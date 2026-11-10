/**
 * Every request runs inside ONE transaction that pins the database identity:
 *
 *   BEGIN;
 *   SET LOCAL ROLE app_employee | app_owner;        -- GRANT layer
 *   SELECT set_config('app.user_id', $1, true);     -- RLS layer (transaction-local)
 *   ... queries ...
 *   COMMIT;                                          -- deferred triggers (totals, alerts) fire here
 *
 * Because both settings are LOCAL, a pooled connection can never leak one
 * user's identity into another user's request.
 */
import pg from 'pg';
import { isOwnerRole, type Role } from '@wh/shared';
import { config } from '../config.js';

// numeric -> number (values are well within double precision); date -> 'YYYY-MM-DD'
pg.types.setTypeParser(pg.types.builtins.NUMERIC, (v) => (v === null ? null : Number(v)));
pg.types.setTypeParser(pg.types.builtins.DATE, (v) => v);

export const pool = new pg.Pool({
  connectionString: config.DATABASE_URL,
  max: 20,
  idleTimeoutMillis: 30_000,
  application_name: 'wh-api',
});

export type Db = pg.PoolClient;
export interface Session { userId: string; role: Role }

async function inTx<T>(setup: (c: Db) => Promise<void>, fn: (c: Db) => Promise<T>): Promise<T> {
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    await setup(c);
    const out = await fn(c);
    await c.query('COMMIT');
    return out;
  } catch (err) {
    await c.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    c.release();
  }
}

/** Normal authenticated request. */
export function withSession<T>(s: Session, fn: (c: Db) => Promise<T>): Promise<T> {
  return inTx(async (c) => {
    // Role names are constants — never interpolate user input here.
    await c.query(isOwnerRole(s.role) ? 'SET LOCAL ROLE app_owner' : 'SET LOCAL ROLE app_employee');
    await c.query("SELECT set_config('app.user_id', $1, true)", [s.userId]);
  }, fn);
}

/** Login / refresh path: can read credentials, nothing else. */
export function withAuth<T>(fn: (c: Db) => Promise<T>): Promise<T> {
  return inTx(async (c) => { await c.query('SET LOCAL ROLE app_auth'); }, fn);
}

/** Background worker (WhatsApp outbox, EOD digest) acting as the SYSTEM user. */
export function withSystem<T>(fn: (c: Db) => Promise<T>): Promise<T> {
  return withSession({ userId: config.SYSTEM_USER_ID, role: 'SYSTEM' }, fn);
}

/** Fire deferred constraint triggers now, so totals are readable before COMMIT. */
export const flushDeferred = (c: Db) => c.query('SET CONSTRAINTS ALL IMMEDIATE');

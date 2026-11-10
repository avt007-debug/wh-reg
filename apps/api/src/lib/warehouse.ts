import { isOwnerRole } from '@wh/shared';
import type { Db, Session } from '../db/pool.js';
import { HttpError } from './errors.js';

/**
 * Staff are always pinned to their DB-assigned warehouse (body value ignored).
 * Owners must say which warehouse they are acting on.
 */
export async function resolveWarehouse(c: Db, s: Session, requested?: string): Promise<string> {
  if (isOwnerRole(s.role)) {
    if (!requested) throw new HttpError(422, 'VALIDATION', 'warehouseId is required for owner entries');
    return requested;
  }
  const { rows } = await c.query('SELECT app.current_warehouse_id() AS id');
  if (!rows[0]?.id) throw new HttpError(403, 'FORBIDDEN', 'No warehouse assigned to this user');
  return rows[0].id as string;
}

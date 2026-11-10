import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { isOwnerRole } from '@wh/shared';
import type { Session } from '../db/pool.js';
import { HttpError } from '../lib/errors.js';
import { verifyAccessToken } from './tokens.js';

declare module 'fastify' {
  interface FastifyRequest {
    auth: Session & { warehouseId: string | null };
    rawBody?: Buffer;
  }
}

/**
 * NOTE: the role in the JWT only picks the Postgres role for SET LOCAL ROLE.
 * Every RLS policy re-derives role + warehouse from the users table, so a stale
 * or forged claim cannot widen access (see db/tests: "API bug simulation").
 */
export async function authenticate(req: FastifyRequest, _reply: FastifyReply) {
  const h = req.headers.authorization;
  if (!h?.startsWith('Bearer ')) throw new HttpError(401, 'UNAUTHENTICATED', 'Missing bearer token');
  try {
    const c = await verifyAccessToken(h.slice(7));
    req.auth = { userId: c.sub, role: c.role, warehouseId: c.wh };
  } catch {
    throw new HttpError(401, 'UNAUTHENTICATED', 'Session expired, please log in again');
  }
}

export async function requireOwner(req: FastifyRequest, _reply: FastifyReply) {
  if (!isOwnerRole(req.auth.role)) throw new HttpError(403, 'FORBIDDEN', 'Owner/Admin only');
}

export function registerAuthHooks(app: FastifyInstance) {
  app.decorateRequest('auth', null as unknown as FastifyRequest['auth']);
}

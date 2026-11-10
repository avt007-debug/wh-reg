import { ERROR_CODES, type ApiError, type ApiErrorKey } from '@wh/shared';
import type { FastifyError, FastifyReply, FastifyRequest } from 'fastify';
import { ZodError } from 'zod';

export class HttpError extends Error {
  constructor(public status: number, public code: ApiErrorKey, message: string, public details?: unknown) {
    super(message);
  }
}

interface PgError { code?: string; detail?: string; constraint?: string; message: string; hint?: string }

/** Translate Postgres / Zod / HTTP errors into the API's error contract. */
export function toApiError(err: unknown): { status: number; body: ApiError } {
  if (err instanceof HttpError) return { status: err.status, body: { code: err.code, message: err.message, details: err.details } };
  if (err instanceof ZodError) return { status: 422, body: { code: 'VALIDATION', message: 'Invalid request', details: err.issues } };

  const pg = err as PgError;
  if (pg.code && pg.code in ERROR_CODES) {
    const e = ERROR_CODES[pg.code as keyof typeof ERROR_CODES];
    let details: unknown = pg.hint ? { hint: pg.hint } : undefined;
    if (pg.code === 'WH001' && pg.detail) {
      const d = JSON.parse(pg.detail);
      details = [{ productId: d.product_id, productName: d.product_name, availableBase: d.available_base, requestedBase: d.requested_base }];
    }
    return { status: e.http, body: { code: e.key, message: pg.message || e.message, details } };
  }
  switch (pg.code) {
    case '42501': return { status: 403, body: { code: 'FORBIDDEN', message: 'Not permitted' } };
    case '23505': return { status: 409, body: { code: 'CONFLICT', message: 'Duplicate entry', details: { constraint: pg.constraint } } };
    case '23503':
    case '23514':
    case '22P02': return { status: 422, body: { code: 'VALIDATION', message: pg.message, details: { constraint: pg.constraint } } };
  }
  const fe = err as FastifyError;
  if (fe.statusCode && fe.statusCode < 500) return { status: fe.statusCode, body: { code: 'VALIDATION', message: fe.message } };
  return { status: 500, body: { code: 'INTERNAL', message: 'Something went wrong' } };
}

export function errorHandler(err: unknown, req: FastifyRequest, reply: FastifyReply) {
  const { status, body } = toApiError(err);
  if (status >= 500) req.log.error({ err }, 'unhandled error');
  void reply.status(status).send(body);
}

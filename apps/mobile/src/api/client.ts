/**
 * Thin typed wrappers over supabase-js. Database errors keep their SQLSTATE
 * (WH001 insufficient stock, WH002 forbidden, WH003 PIN locked, WH005
 * validation) and are mapped to the same ApiError codes the screens handle.
 */
import { ERROR_CODES, type ApiErrorKey } from '@wh/shared';
import { supabase } from '../lib/supabase';

export class ApiError extends Error {
  constructor(public code: ApiErrorKey, message: string, public details?: unknown) { super(message); }
}

interface PgErr { code?: string; message: string; details?: string | null; hint?: string | null }

export function toApiError(e: PgErr): ApiError {
  if (e.code && e.code in ERROR_CODES) {
    const k = ERROR_CODES[e.code as keyof typeof ERROR_CODES].key;
    let details: unknown = e.details;
    try { details = e.details ? JSON.parse(e.details) : undefined; } catch { /* plain text */ }
    return new ApiError(k, e.message, details);
  }
  if (e.code === '42501') return new ApiError('FORBIDDEN', 'You are not allowed to do this');
  if (e.code === '23505') return new ApiError('CONFLICT', 'This entry already exists (duplicate invoice number?)');
  if (e.code === 'PGRST301' || e.code === '401') return new ApiError('UNAUTHENTICATED', 'Please log in again');
  if (e.code?.startsWith('23') || e.code === '22P02') return new ApiError('VALIDATION', e.message);
  return new ApiError('INTERNAL', e.message || 'Something went wrong');
}

/** Call a Postgres function exposed by the Supabase Data API. */
export async function rpc<T>(fn: string, args?: Record<string, unknown>): Promise<T> {
  const { data, error } = await supabase.rpc(fn, args ?? {});
  if (error) throw toApiError(error);
  return data as T;
}

/** Unwrap a supabase-js query builder result. */
export async function q<T>(builder: PromiseLike<{ data: T | null; error: PgErr | null }>): Promise<T> {
  const { data, error } = await builder;
  if (error) throw toApiError(error);
  return data as T;
}

/** Call an Edge Function with the signed-in user's session. */
export async function edge<T>(name: string, body: Record<string, unknown>): Promise<T> {
  const { data, error } = await supabase.functions.invoke(name, { body });
  if (error) {
    let msg = error.message; let body: unknown;
    try { body = await (error as { context?: Response }).context?.json(); msg = (body as { error?: string })?.error ?? msg; } catch { /* keep */ }
    throw new ApiError('VALIDATION', msg, body);
  }
  return data as T;
}

/** Upload a lorry receipt / invoice photo into '<warehouseId>/<yyyy-mm>/<uuid>.jpg'. Returns the storage path. */
export async function uploadPurchaseDoc(warehouseId: string, uri: string, mimeType: 'image/jpeg' | 'image/png' | 'image/webp', id: string) {
  const ext = mimeType.split('/')[1];
  const path = `${warehouseId}/${new Date().toISOString().slice(0, 7)}/${id}.${ext}`;
  const bytes = await (await fetch(uri)).arrayBuffer();
  const { error } = await supabase.storage.from('purchase-docs').upload(path, bytes, { contentType: mimeType, upsert: false });
  if (error) throw new ApiError('VALIDATION', `Photo upload failed: ${error.message}`);
  return path;
}

/** Field photo (delivery proof, signature, market run) into the private 'field-photos' bucket under '<user id>/'. */
export async function uploadFieldPhoto(userId: string, uri: string, kind: string, mimeType: 'image/jpeg' | 'image/png' = 'image/jpeg') {
  const path = `${userId}/${kind}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${mimeType === 'image/png' ? 'png' : 'jpg'}`;
  const bytes = await (await fetch(uri)).arrayBuffer();
  const { error } = await supabase.storage.from('field-photos').upload(path, bytes, { contentType: mimeType, upsert: false });
  if (error) throw new ApiError('VALIDATION', `Photo upload failed: ${error.message}`);
  return path;
}

/** Short-lived link to view a private field photo. */
export async function fieldPhotoUrl(path: string) {
  const { data, error } = await supabase.storage.from('field-photos').createSignedUrl(path, 600);
  if (error) throw new ApiError('VALIDATION', error.message);
  return data.signedUrl;
}

/** Item photo (public 'product-images' bucket) — returns the storage path '<productId>/<file>'. */
export async function uploadItemPhoto(productId: string, uri: string) {
  const path = `${productId}/${Date.now()}.jpg`;
  const bytes = await (await fetch(uri)).arrayBuffer();
  const { error } = await supabase.storage.from('product-images').upload(path, bytes, { contentType: 'image/jpeg', upsert: false });
  if (error) throw new ApiError('VALIDATION', `Photo upload failed: ${error.message}`);
  return path;
}
export const itemPhotoUrl = (path: string) => supabase.storage.from('product-images').getPublicUrl(path).data.publicUrl;

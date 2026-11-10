import type { ApiError as ApiErrorBody, ApiErrorKey } from '@wh/shared';
import { useAuth } from '../auth/store';

const BASE = `${process.env.EXPO_PUBLIC_API_URL ?? 'http://localhost:4000'}/v1`;

export class ApiError extends Error {
  constructor(public status: number, public code: ApiErrorKey, message: string, public details?: unknown) { super(message); }
}

let refreshing: Promise<boolean> | null = null;

async function refresh(): Promise<boolean> {
  const { refreshToken, setSession, clear } = useAuth.getState();
  if (!refreshToken) return false;
  const res = await fetch(`${BASE}/auth/refresh`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ refreshToken }),
  });
  if (!res.ok) { await clear(); return false; }
  await setSession(await res.json());
  return true;
}

/** fetch wrapper: bearer token, one transparent refresh on 401, typed errors. */
export async function api<T>(path: string, opts: { method?: string; body?: unknown; auth?: boolean } = {}): Promise<T> {
  const doFetch = () => fetch(`${BASE}${path}`, {
    method: opts.method ?? (opts.body ? 'POST' : 'GET'),
    headers: {
      ...(opts.body ? { 'Content-Type': 'application/json' } : {}),
      ...(opts.auth !== false && useAuth.getState().accessToken ? { Authorization: `Bearer ${useAuth.getState().accessToken}` } : {}),
    },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });

  let res = await doFetch();
  if (res.status === 401 && opts.auth !== false) {
    refreshing ??= refresh().finally(() => { refreshing = null; });
    if (await refreshing) res = await doFetch();
  }
  const json = await res.json().catch(() => null);
  if (!res.ok) {
    const e = (json ?? {}) as Partial<ApiErrorBody>;
    throw new ApiError(res.status, e.code ?? 'INTERNAL', e.message ?? `HTTP ${res.status}`, e.details);
  }
  return json as T;
}

/** Upload a photo straight to object storage with a presigned URL. Returns the storage key. */
export async function uploadAttachment(uri: string, mimeType: 'image/jpeg' | 'image/png' | 'image/webp') {
  const { key, url } = await api<{ key: string; url: string }>('/purchases/attachments/presign', { body: { mimeType } });
  const blob = await (await fetch(uri)).blob();
  const put = await fetch(url, { method: 'PUT', headers: { 'Content-Type': mimeType }, body: blob });
  if (!put.ok) throw new Error('Photo upload failed');
  return key;
}

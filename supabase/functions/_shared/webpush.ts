/**
 * Web Push (RFC 8030) with message encryption (RFC 8291, aes128gcm) and VAPID (RFC 8292).
 * Web Crypto only — runs in Supabase Edge Functions (Deno) and in Node ≥ 20 for tests.
 * This is what puts the clock-in / clock-out reminders and the owner's summary on the phone
 * as a normal notification from the installed WH Reg app (no other app needed).
 */

export interface PushSubscription { endpoint: string; p256dh: string; auth: string }
export interface VapidKeys {
  publicKey: string;              // base64url, 65-byte uncompressed P-256 point
  privateJwk: JsonWebKey;         // { kty:'EC', crv:'P-256', x, y, d }
  subject: string;                // mailto:… or https://…
}

const enc = new TextEncoder();

export function b64url(bytes: Uint8Array): string {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
export function unb64url(s: string): Uint8Array {
  const p = s.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4);
  const bin = atob(p);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
const concat = (...parts: Uint8Array[]) => {
  const out = new Uint8Array(parts.reduce((a, p) => a + p.length, 0));
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
};
async function hmac(key: Uint8Array, data: Uint8Array): Promise<Uint8Array> {
  const k = await crypto.subtle.importKey('raw', key, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return new Uint8Array(await crypto.subtle.sign('HMAC', k, data));
}

/** Encrypt one push message for a subscription (RFC 8291). Returns the request body. */
export async function encryptPayload(sub: PushSubscription, payload: Uint8Array,
  opts: { salt?: Uint8Array; serverKeys?: CryptoKeyPair } = {}): Promise<Uint8Array> {
  const uaPublic = unb64url(sub.p256dh);
  const authSecret = unb64url(sub.auth);
  const salt = opts.salt ?? crypto.getRandomValues(new Uint8Array(16));
  const as = opts.serverKeys ?? await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']) as CryptoKeyPair;
  const asPublic = new Uint8Array(await crypto.subtle.exportKey('raw', as.publicKey));
  const uaKey = await crypto.subtle.importKey('raw', uaPublic, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
  const ecdh = new Uint8Array(await crypto.subtle.deriveBits({ name: 'ECDH', public: uaKey }, as.privateKey, 256));

  const prkKey = await hmac(authSecret, ecdh);
  const ikm = await hmac(prkKey, concat(enc.encode('WebPush: info\0'), uaPublic, asPublic, new Uint8Array([1])));
  const prk = await hmac(salt, ikm);
  const cek = (await hmac(prk, concat(enc.encode('Content-Encoding: aes128gcm\0'), new Uint8Array([1])))).slice(0, 16);
  const nonce = (await hmac(prk, concat(enc.encode('Content-Encoding: nonce\0'), new Uint8Array([1])))).slice(0, 12);

  const key = await crypto.subtle.importKey('raw', cek, 'AES-GCM', false, ['encrypt']);
  const cipher = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce }, key, concat(payload, new Uint8Array([2]))));
  const rs = new Uint8Array([0, 0, 16, 0]);                       // record size 4096
  return concat(salt, rs, new Uint8Array([asPublic.length]), asPublic, cipher);
}

/** VAPID Authorization header value for an endpoint (RFC 8292). */
export async function vapidAuth(endpoint: string, v: VapidKeys, now = Math.floor(Date.now() / 1000)): Promise<string> {
  const aud = new URL(endpoint).origin;
  const header = b64url(enc.encode(JSON.stringify({ typ: 'JWT', alg: 'ES256' })));
  const claims = b64url(enc.encode(JSON.stringify({ aud, exp: now + 12 * 3600, sub: v.subject })));
  const key = await crypto.subtle.importKey('jwk', { ...v.privateJwk, key_ops: ['sign'], ext: true }, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
  const sig = new Uint8Array(await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key, enc.encode(`${header}.${claims}`)));
  return `vapid t=${header}.${claims}.${b64url(sig)}, k=${v.publicKey}`;
}

export interface PushResult { ok: boolean; status: number; gone: boolean; error?: string }

/** Send one notification. `gone` = the phone unsubscribed / uninstalled: delete the subscription. */
export async function sendPush(sub: PushSubscription, message: unknown, v: VapidKeys,
  opts: { ttl?: number; urgency?: 'normal' | 'high'; topic?: string } = {}): Promise<PushResult> {
  try {
    const body = await encryptPayload(sub, enc.encode(JSON.stringify(message)));
    const headers: Record<string, string> = {
      'Content-Type': 'application/octet-stream', 'Content-Encoding': 'aes128gcm',
      TTL: String(opts.ttl ?? 6 * 3600), Urgency: opts.urgency ?? 'high', Authorization: await vapidAuth(sub.endpoint, v),
    };
    if (opts.topic) headers.Topic = opts.topic.replace(/[^A-Za-z0-9_-]/g, '').slice(0, 32);
    const r = await fetch(sub.endpoint, { method: 'POST', headers, body });
    const text = r.ok ? '' : (await r.text()).slice(0, 300);
    return { ok: r.ok, status: r.status, gone: r.status === 404 || r.status === 410, error: r.ok ? undefined : text || r.statusText };
  } catch (e) {
    return { ok: false, status: 0, gone: false, error: (e as Error).message };
  }
}

import { createClient, type SupabaseClient } from 'npm:@supabase/supabase-js@2.119.0';

/** Server-side client that bypasses RLS. Prefers the new sb_secret key, falls back to legacy service_role. */
export function adminClient(): SupabaseClient {
  const url = Deno.env.get('SUPABASE_URL')!;
  const secretKeys = Deno.env.get('SUPABASE_SECRET_KEYS');
  const key = secretKeys ? JSON.parse(secretKeys).default : Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  if (!url || !key) throw new Error('SUPABASE_URL / secret key missing from function environment');
  return createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
}

export const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'POST, OPTIONS',
               'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type' },
  });

/** Constant-time string comparison (secrets, signatures). */
export function safeEqual(a: string, b: string): boolean {
  const ea = new TextEncoder().encode(a), eb = new TextEncoder().encode(b);
  if (ea.length !== eb.length) return false;
  let diff = 0;
  for (let i = 0; i < ea.length; i++) diff |= ea[i]! ^ eb[i]!;
  return diff === 0;
}

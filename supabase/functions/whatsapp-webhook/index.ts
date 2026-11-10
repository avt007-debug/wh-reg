/**
 * whatsapp-webhook — Meta callback URL.
 *   GET  : subscription handshake (hub.verify_token)
 *   POST : delivery statuses (sent / delivered / read / failed), HMAC-verified
 * Configure in Meta: https://<project-ref>.supabase.co/functions/v1/whatsapp-webhook
 */
import { adminClient, json } from '../_shared/supabase.ts';
import { validSignature } from '../_shared/whatsapp.ts';

interface StatusEvent { id: string; status: string; errors?: { code: number; title: string }[] }

Deno.serve(async (req) => {
  const url = new URL(req.url);

  if (req.method === 'GET') {
    const ok = url.searchParams.get('hub.mode') === 'subscribe'
      && url.searchParams.get('hub.verify_token') === Deno.env.get('WA_WEBHOOK_VERIFY_TOKEN');
    return ok ? new Response(url.searchParams.get('hub.challenge') ?? '', { status: 200 }) : new Response('forbidden', { status: 403 });
  }
  if (req.method !== 'POST') return new Response('method not allowed', { status: 405 });

  const raw = await req.text();
  if (!(await validSignature(raw, req.headers.get('x-hub-signature-256'), Deno.env.get('WA_APP_SECRET') ?? ''))) {
    return new Response('bad signature', { status: 401 });
  }
  const body = JSON.parse(raw) as { entry?: { changes?: { value?: { statuses?: StatusEvent[] } }[] }[] };
  const statuses = body.entry?.flatMap((e) => e.changes ?? []).flatMap((c) => c.value?.statuses ?? []) ?? [];
  if (statuses.length) {
    const db = adminClient();
    for (const s of statuses) {
      await db.rpc('wa_status_update', { p_message_id: s.id, p_status: s.status, p_error: s.errors ? JSON.stringify(s.errors) : null });
    }
  }
  return json({ ok: true });     // always 200 quickly, or Meta retries aggressively
});

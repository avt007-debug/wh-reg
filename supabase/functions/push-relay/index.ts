/**
 * push-relay — sends the in-app notifications (clock-in / clock-out reminders, the owner's
 * daily summary, approvals, alerts) to every phone where that person turned notifications on.
 *
 * Poked by Postgres (pg_net) right after a notification is inserted, and every 2 minutes by
 * pg_cron while anything is unsent. Auth: header `x-relay-secret` == function secret
 * PUSH_RELAY_SECRET (Vault: push_relay_secret); verify_jwt is off.
 * Function secrets: VAPID_PUBLIC_KEY, VAPID_PRIVATE_JWK (JSON), VAPID_SUBJECT (mailto:…).
 */
import { adminClient, json, safeEqual } from '../_shared/supabase.ts';
import { sendPush, type VapidKeys } from '../_shared/webpush.ts';

interface Claimed {
  id: number; kind: string; title: string; body: string;
  subs: { id: number; endpoint: string; p256dh: string; auth: string }[];
}

Deno.serve(async (req) => {
  const secret = Deno.env.get('PUSH_RELAY_SECRET') ?? '';
  if (!secret || !safeEqual(req.headers.get('x-relay-secret') ?? '', secret)) return json({ error: 'forbidden' }, 403);

  const vapid: VapidKeys = {
    publicKey: Deno.env.get('VAPID_PUBLIC_KEY') ?? '',
    privateJwk: JSON.parse(Deno.env.get('VAPID_PRIVATE_JWK') ?? '{}'),
    subject: Deno.env.get('VAPID_SUBJECT') ?? 'mailto:admin@whreg.app',
  };
  if (!vapid.publicKey || !vapid.privateJwk.d) return json({ error: 'VAPID keys missing' }, 500);

  const db = adminClient();
  let sent = 0, failed = 0, removed = 0;
  for (let round = 0; round < 5; round++) {
    const { data, error } = await db.rpc('push_claim', { p_limit: 100 });
    if (error) return json({ error: error.message }, 500);
    const items = (data ?? []) as Claimed[];
    if (!items.length) break;

    const report: { subId: number; ok: boolean; gone: boolean; error?: string }[] = [];
    await Promise.all(items.flatMap((n) => n.subs.map(async (s) => {
      const r = await sendPush(s, { id: n.id, kind: n.kind, title: n.title, body: n.body }, vapid,
        { ttl: 6 * 3600, urgency: 'high', topic: `${n.kind}`.slice(0, 32) });
      report.push({ subId: s.id, ok: r.ok, gone: r.gone, error: r.error });
      if (r.ok) sent++; else if (r.gone) removed++; else failed++;
      if (!r.ok) console.error(`[push] #${n.id} → sub ${s.id}: ${r.status} ${r.error ?? ''}`);
    })));
    await db.rpc('push_report', { p: report });
  }
  return json({ sent, failed, removed });
});

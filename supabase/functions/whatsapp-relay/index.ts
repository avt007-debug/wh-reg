/**
 * whatsapp-relay — drains notification_outbox and sends WhatsApp templates.
 *
 * Invoked by Postgres (pg_net) right after a sale / the 8:30 PM digest is
 * queued, and every 2 minutes by pg_cron while anything is pending/failed.
 * Auth: shared secret header `x-relay-secret` (Vault secret
 * whatsapp_relay_secret == function secret RELAY_SECRET); verify_jwt is off.
 * Safe to run concurrently: rows are claimed with FOR UPDATE SKIP LOCKED.
 */
import { adminClient, json, safeEqual } from '../_shared/supabase.ts';
import {
  dispatchAlertParams, eodDigestParams, sendTemplate, waConfigFromEnv, WhatsAppError,
  type DispatchAlertData, type EodData,
} from '../_shared/whatsapp.ts';

const MAX_ATTEMPTS = 8;

interface OutboxRow {
  id: number; event_type: 'DISPATCH_ALERT' | 'EOD_DIGEST' | 'LOW_STOCK';
  aggregate_id: string | null; payload: { date?: string; sent_to?: string[] }; attempts: number;
}

Deno.serve(async (req) => {
  const secret = Deno.env.get('RELAY_SECRET') ?? '';
  if (!secret || !safeEqual(req.headers.get('x-relay-secret') ?? '', secret)) return json({ error: 'forbidden' }, 403);

  const db = adminClient();
  const cfg = waConfigFromEnv((k) => Deno.env.get(k));
  const owners = (Deno.env.get('WA_OWNER_NUMBERS') ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  const templates = {
    DISPATCH_ALERT: Deno.env.get('WA_TEMPLATE_DISPATCH') ?? 'dispatch_alert',
    EOD_DIGEST: Deno.env.get('WA_TEMPLATE_EOD') ?? 'eod_digest',
  };

  async function process(row: OutboxRow) {
    const sentTo = new Set(row.payload?.sent_to ?? []);
    let firstId: string | null = null;
    try {
      let template: string, params: string[];
      if (row.event_type === 'DISPATCH_ALERT') {
        const { data, error } = await db.rpc('wa_dispatch_payload', { p_dispatch: row.aggregate_id });
        if (error || !data) throw new Error(error?.message ?? 'dispatch not found');
        template = templates.DISPATCH_ALERT; params = dispatchAlertParams(data as DispatchAlertData);
      } else {
        const { data, error } = await db.rpc('wa_eod_payload', { p_date: row.payload.date });
        if (error || !data) throw new Error(error?.message ?? 'digest unavailable');
        template = templates.EOD_DIGEST; params = eodDigestParams(data as EodData);
      }
      if (!owners.length) throw new WhatsAppError('WA_OWNER_NUMBERS is empty', undefined, false);
      for (const to of owners) {
        if (sentTo.has(to)) continue;                 // a retry never re-sends to someone already reached
        const { messageId } = await sendTemplate(cfg, to, template, params);
        firstId ??= messageId;
        sentTo.add(to);
      }
      await db.rpc('wa_mark_sent', { p_id: row.id, p_message_id: firstId, p_sent_to: [...sentTo] });
    } catch (err) {
      const retryable = !(err instanceof WhatsAppError) || err.retryable;
      const dead = !retryable || row.attempts >= MAX_ATTEMPTS;
      await db.rpc('wa_mark_failed', { p_id: row.id, p_error: String((err as Error).message), p_dead: dead, p_sent_to: [...sentTo] });
      console.error(`[relay] #${row.id} ${row.event_type} ${dead ? 'DEAD' : 'retry later'}: ${(err as Error).message}`);
    }
  }

  let processed = 0;
  for (let round = 0; round < 5; round++) {                    // bounded work per invocation
    const { data, error } = await db.rpc('wa_claim_outbox', { p_batch: 20 });
    if (error) return json({ error: error.message }, 500);
    const rows = (data ?? []) as OutboxRow[];
    if (!rows.length) break;
    await Promise.all(rows.map(process));
    processed += rows.length;
  }
  return json({ processed });
});

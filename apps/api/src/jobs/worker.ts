/**
 * Background worker (run as a separate process / container):
 *   • Outbox relay — sends WhatsApp alerts for rows queued atomically by the DB
 *     (LISTEN 'outbox' for instant pickup + 15s polling as a safety net).
 *   • EOD digest — cron 8:30 PM Asia/Kolkata enqueues one digest per day.
 * Safe to run multiple replicas: rows are claimed with FOR UPDATE SKIP LOCKED
 * and the EOD row is de-duplicated by dedupe_key 'eod:<date>'.
 */
import { Cron } from 'croner';
import pg from 'pg';
import { config } from '../config.js';
import { pool, withSystem, type Db } from '../db/pool.js';
import { sendTemplate, WhatsAppError } from '../integrations/whatsapp/client.js';
import { dispatchAlertParams, eodDigestParams, type DispatchAlertData, type EodData } from '../integrations/whatsapp/templates.js';

const MAX_ATTEMPTS = 8;
const BATCH = 20;

interface OutboxRow {
  id: number; event_type: 'DISPATCH_ALERT' | 'EOD_DIGEST' | 'LOW_STOCK';
  aggregate_id: string | null; payload: { date?: string; sent_to?: string[] }; attempts: number;
}

async function claim(): Promise<OutboxRow[]> {
  return withSystem(async (c) => (await c.query(
    `UPDATE notification_outbox SET status = 'SENDING', attempts = attempts + 1, next_attempt_at = now()
      WHERE id IN (SELECT id FROM notification_outbox
                    WHERE (status IN ('PENDING','FAILED') AND next_attempt_at <= now())
                       OR (status = 'SENDING' AND next_attempt_at < now() - interval '10 minutes')  -- crashed worker
                    ORDER BY id LIMIT $1 FOR UPDATE SKIP LOCKED)
      RETURNING id, event_type, aggregate_id, payload, attempts`, [BATCH])).rows);
}

async function loadDispatch(c: Db, id: string): Promise<DispatchAlertData> {
  const { rows: [d] } = await c.query(
    `SELECT w.name AS warehouse_name, d.customer_name, d.invoice_no, d.customer_gstin, a.name AS agent_name,
            d.taxable_total, d.grand_total, d.transport_mode, d.transporter_name, d.vehicle_reg_no, d.driver_phone,
            (SELECT json_agg(json_build_object('name', p.name, 'qty', i.qty, 'uom', i.uom_code) ORDER BY i.line_no)
               FROM dispatch_items i JOIN products p ON p.id = i.product_id WHERE i.dispatch_id = d.id) AS items
       FROM dispatches d JOIN warehouses w ON w.id = d.warehouse_id
       LEFT JOIN sales_agents a ON a.id = d.sales_agent_id
      WHERE d.id = $1`, [id]);
  if (!d) throw new Error(`dispatch ${id} not found`);
  return d as DispatchAlertData;
}

async function buildMessage(row: OutboxRow): Promise<{ template: string; params: string[] }> {
  return withSystem(async (c) => {
    if (row.event_type === 'DISPATCH_ALERT') {
      return { template: config.WA_TEMPLATE_DISPATCH, params: dispatchAlertParams(await loadDispatch(c, row.aggregate_id!)) };
    }
    const { rows: [r] } = await c.query('SELECT fin.eod_digest($1::date) AS d', [row.payload.date]);
    return { template: config.WA_TEMPLATE_EOD, params: eodDigestParams(r.d as EodData) };
  });
}

async function processRow(row: OutboxRow) {
  const sentTo = new Set(row.payload.sent_to ?? []);
  let firstMessageId: string | null = null;
  try {
    const { template, params } = await buildMessage(row);
    for (const to of config.WA_OWNER_NUMBERS) {
      if (sentTo.has(to)) continue;                 // retry must not double-send to recipients already reached
      const { messageId } = await sendTemplate(to, template, params);
      firstMessageId ??= messageId;
      sentTo.add(to);
    }
    await withSystem((c) => c.query(
      `UPDATE notification_outbox SET status = 'SENT', sent_at = now(), last_error = NULL,
              provider_message_id = coalesce($2, provider_message_id),
              payload = payload || jsonb_build_object('sent_to', $3::jsonb) WHERE id = $1`,
      [row.id, firstMessageId, JSON.stringify([...sentTo])]));
  } catch (err) {
    const retryable = !(err instanceof WhatsAppError) || err.retryable;
    const dead = !retryable || row.attempts >= MAX_ATTEMPTS;
    await withSystem((c) => c.query(
      `UPDATE notification_outbox SET status = $2::outbox_status, last_error = $3,
              next_attempt_at = now() + make_interval(mins => least(power(2, $4)::int, 240)),
              payload = payload || jsonb_build_object('sent_to', $5::jsonb) WHERE id = $1`,
      [row.id, dead ? 'DEAD' : 'FAILED', String((err as Error).message).slice(0, 500), row.attempts, JSON.stringify([...sentTo])]));
    console.error(`[outbox] #${row.id} ${row.event_type} ${dead ? 'DEAD' : 'retry later'}:`, (err as Error).message);
  }
}

let draining = false;
export async function drain() {
  if (draining) return;
  draining = true;
  try {
    for (let batch = await claim(); batch.length; batch = await claim()) {
      await Promise.all(batch.map(processRow));
    }
  } finally {
    draining = false;
  }
}

export async function enqueueEodDigest() {
  await withSystem((c) => c.query(
    `INSERT INTO notification_outbox(event_type, dedupe_key, payload)
     VALUES ('EOD_DIGEST', 'eod:' || app.today_ist(), jsonb_build_object('date', app.today_ist()))
     ON CONFLICT (dedupe_key) DO NOTHING`));
  await drain();
}

async function main() {
  // Dedicated connection for LISTEN (not from the pool, which recycles clients).
  const listener = new pg.Client({ connectionString: config.DATABASE_URL, application_name: 'wh-worker-listen' });
  await listener.connect();
  await listener.query('LISTEN outbox');
  listener.on('notification', () => void drain());

  const poll = setInterval(() => void drain(), 15_000);
  const eod = new Cron(config.EOD_CRON, { timezone: config.EOD_TZ, protect: true }, () => enqueueEodDigest());
  console.info(`[worker] up — EOD digest next at ${eod.nextRun()?.toISOString()} (${config.EOD_TZ})`);
  await drain();

  const shutdown = async () => {
    clearInterval(poll);
    eod.stop();
    await listener.end().catch(() => undefined);
    await pool.end();
    process.exit(0);
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => { console.error(e); process.exit(1); });
}

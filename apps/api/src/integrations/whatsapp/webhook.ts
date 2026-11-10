/**
 * WhatsApp webhook: GET = subscription handshake, POST = delivery status callbacks.
 * Signature: X-Hub-Signature-256 = 'sha256=' + HMAC-SHA256(app secret, raw body).
 */
import { createHmac, timingSafeEqual } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { config } from '../../config.js';
import { withSystem } from '../../db/pool.js';

export function validSignature(raw: Buffer | undefined, header: string | undefined, secret = config.WA_APP_SECRET): boolean {
  if (!raw || !header?.startsWith('sha256=') || !secret) return false;
  const expected = Buffer.from(createHmac('sha256', secret).update(raw).digest('hex'));
  const got = Buffer.from(header.slice(7));
  return expected.length === got.length && timingSafeEqual(expected, got);
}

interface StatusEvent { id: string; status: 'sent' | 'delivered' | 'read' | 'failed'; errors?: { code: number; title: string }[] }

export async function whatsappWebhookRoutes(app: FastifyInstance) {
  app.get('/webhooks/whatsapp', async (req, reply) => {
    const q = req.query as Record<string, string>;
    if (q['hub.mode'] === 'subscribe' && q['hub.verify_token'] === config.WA_WEBHOOK_VERIFY_TOKEN) {
      return reply.type('text/plain').send(q['hub.challenge']);
    }
    return reply.status(403).send();
  });

  app.post('/webhooks/whatsapp', async (req, reply) => {
    if (!validSignature(req.rawBody, req.headers['x-hub-signature-256'] as string | undefined)) {
      return reply.status(401).send();
    }
    const body = req.body as { entry?: { changes?: { value?: { statuses?: StatusEvent[] } }[] }[] };
    const statuses = body.entry?.flatMap((e) => e.changes ?? []).flatMap((c) => c.value?.statuses ?? []) ?? [];
    if (statuses.length) {
      await withSystem(async (c) => {
        for (const s of statuses) {
          if (s.status === 'delivered' || s.status === 'read') {
            await c.query(`UPDATE notification_outbox SET status = 'DELIVERED', delivered_at = coalesce(delivered_at, now())
                            WHERE provider_message_id = $1`, [s.id]);
          } else if (s.status === 'failed') {
            await c.query(`UPDATE notification_outbox SET status = 'FAILED', last_error = $2, next_attempt_at = now() + interval '5 minutes'
                            WHERE provider_message_id = $1 AND status <> 'DELIVERED'`, [s.id, JSON.stringify(s.errors ?? [])]);
          }
        }
      });
    }
    return reply.status(200).send();     // always 200 fast, or Meta retries aggressively
  });
}

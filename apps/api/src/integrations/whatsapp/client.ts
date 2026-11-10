/**
 * Meta WhatsApp Business Cloud API — template messages only.
 *
 * Business-initiated messages outside a 24h customer-service window MUST be
 * pre-approved templates. Both alerts are UTILITY templates (transactional,
 * no promotional content), which Meta bills per delivered message.
 * Template bodies to submit for approval are in docs/WHATSAPP.md.
 */
import { config } from '../../config.js';

export class WhatsAppError extends Error {
  constructor(message: string, public code: number | undefined, public retryable: boolean) { super(message); }
}

// Meta error codes worth retrying: throughput / pair-rate limits and transient service errors.
const RETRYABLE_CODES = new Set([1, 2, 4, 80007, 130429, 131000, 131016, 131056, 133004]);

export async function sendTemplate(to: string, template: string, bodyParams: string[]): Promise<{ messageId: string }> {
  if (config.WA_DRY_RUN) {
    console.info(`[whatsapp:dry-run] → ${to} ${template}`, bodyParams);
    return { messageId: `dry-run-${Date.now()}-${Math.random().toString(36).slice(2, 8)}` };
  }
  const url = `https://graph.facebook.com/${config.WA_GRAPH_VERSION}/${config.WA_PHONE_NUMBER_ID}/messages`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${config.WA_ACCESS_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to,
      type: 'template',
      template: {
        name: template,
        language: { code: config.WA_TEMPLATE_LANG },
        components: [{ type: 'body', parameters: bodyParams.map((text) => ({ type: 'text', text })) }],
      },
    }),
    signal: AbortSignal.timeout(15_000),
  });
  const json = (await res.json().catch(() => ({}))) as {
    messages?: { id: string }[];
    error?: { message?: string; code?: number };
  };
  if (!res.ok || !json.messages?.[0]) {
    const code = json.error?.code;
    const retryable = res.status >= 500 || res.status === 429 || (code !== undefined && RETRYABLE_CODES.has(code));
    throw new WhatsAppError(json.error?.message ?? `HTTP ${res.status}`, code, retryable);
  }
  return { messageId: json.messages[0].id };
}

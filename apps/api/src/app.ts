import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import Fastify from 'fastify';
import { registerAuthHooks } from './auth/plugin.js';
import { whatsappWebhookRoutes } from './integrations/whatsapp/webhook.js';
import { errorHandler } from './lib/errors.js';
import { authRoutes } from './modules/auth/routes.js';
import { catalogRoutes } from './modules/catalog/routes.js';
import { dispatchRoutes } from './modules/dispatches/routes.js';
import { inventoryRoutes } from './modules/inventory/routes.js';
import { ownerRoutes } from './modules/owner/routes.js';
import { purchaseRoutes } from './modules/purchases/routes.js';
import { transferRoutes } from './modules/transfers/routes.js';
import { pool } from './db/pool.js';

export async function buildApp() {
  const app = Fastify({
    logger: { level: process.env.LOG_LEVEL ?? 'info', redact: ['req.headers.authorization', 'body.password', 'body.pin'] },
    trustProxy: true,
    bodyLimit: 1_048_576,
  });

  // Keep the raw body (needed to verify WhatsApp webhook signatures).
  app.addContentTypeParser('application/json', { parseAs: 'buffer' }, (req, body, done) => {
    req.rawBody = body as Buffer;
    try { done(null, (body as Buffer).length ? JSON.parse((body as Buffer).toString('utf8')) : {}); }
    catch (e) { done(e as Error, undefined); }
  });

  await app.register(helmet);
  await app.register(cors, { origin: false });          // native mobile app: no browser origins
  await app.register(rateLimit, { max: 300, timeWindow: '1 minute' });
  registerAuthHooks(app);
  app.setErrorHandler(errorHandler);

  app.get('/health', async () => {
    await pool.query('SELECT 1');
    return { ok: true };
  });

  await app.register(whatsappWebhookRoutes);
  await app.register(async (v1) => {
    await v1.register(authRoutes);
    await v1.register(catalogRoutes);
    await v1.register(inventoryRoutes);
    await v1.register(purchaseRoutes);
    await v1.register(dispatchRoutes);
    await v1.register(transferRoutes);
    await v1.register(ownerRoutes);
  }, { prefix: '/v1' });

  return app;
}

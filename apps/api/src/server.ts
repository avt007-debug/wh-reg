import { buildApp } from './app.js';
import { config } from './config.js';
import { pool } from './db/pool.js';

const app = await buildApp();
await app.listen({ port: config.PORT, host: '0.0.0.0' });

for (const sig of ['SIGTERM', 'SIGINT'] as const) {
  process.on(sig, async () => {
    await app.close();
    await pool.end();
    process.exit(0);
  });
}

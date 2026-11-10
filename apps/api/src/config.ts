import { z } from 'zod';

const Env = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().default(4000),
  DATABASE_URL: z.string().url(),
  SYSTEM_USER_ID: z.guid(),

  JWT_SECRET: z.string().min(32),
  ACCESS_TOKEN_TTL: z.string().default('15m'),
  REFRESH_TOKEN_TTL_DAYS: z.coerce.number().int().positive().default(30),

  S3_ENDPOINT: z.string().url().optional(),
  S3_REGION: z.string().default('ap-south-1'),
  S3_BUCKET: z.string(),
  S3_ACCESS_KEY_ID: z.string(),
  S3_SECRET_ACCESS_KEY: z.string(),

  WA_GRAPH_VERSION: z.string().regex(/^v\d+\.\d+$/).default('v24.0'),
  WA_PHONE_NUMBER_ID: z.string().default(''),
  WA_ACCESS_TOKEN: z.string().default(''),
  WA_APP_SECRET: z.string().default(''),
  WA_WEBHOOK_VERIFY_TOKEN: z.string().default(''),
  WA_OWNER_NUMBERS: z.string().default('').transform((s) => s.split(',').map((x) => x.trim()).filter(Boolean)),
  WA_TEMPLATE_DISPATCH: z.string().default('dispatch_alert'),
  WA_TEMPLATE_EOD: z.string().default('eod_digest'),
  WA_TEMPLATE_LANG: z.string().default('en'),
  WA_DRY_RUN: z.stringbool().default(true),

  EOD_CRON: z.string().default('30 20 * * *'),
  EOD_TZ: z.string().default('Asia/Kolkata'),
});

export type Config = z.infer<typeof Env>;
export const config: Config = Env.parse(process.env);

/** Object storage (S3 / Cloudflare R2 / MinIO). Devices upload directly with presigned URLs. */
import { randomUUID } from 'node:crypto';
import { GetObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { config } from '../config.js';

const s3 = new S3Client({
  region: config.S3_REGION,
  ...(config.S3_ENDPOINT ? { endpoint: config.S3_ENDPOINT, forcePathStyle: true } : {}),
  credentials: { accessKeyId: config.S3_ACCESS_KEY_ID, secretAccessKey: config.S3_SECRET_ACCESS_KEY },
});

const EXT: Record<string, string> = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'application/pdf': 'pdf' };

/** Key layout keeps warehouses separable for lifecycle rules: purchases/<wh>/<yyyy-mm>/<uuid>.jpg */
export async function presignUpload(prefix: string, mimeType: string) {
  const ext = EXT[mimeType];
  if (!ext) throw new Error('Unsupported file type');
  const month = new Date().toISOString().slice(0, 7);
  const key = `${prefix}/${month}/${randomUUID()}.${ext}`;
  const url = await getSignedUrl(s3, new PutObjectCommand({ Bucket: config.S3_BUCKET, Key: key, ContentType: mimeType }), { expiresIn: 300 });
  return { key, url, expiresIn: 300 };
}

export const presignDownload = (key: string) =>
  getSignedUrl(s3, new GetObjectCommand({ Bucket: config.S3_BUCKET, Key: key }), { expiresIn: 3600 });

import { createHash, randomBytes } from 'node:crypto';
import { SignJWT, jwtVerify } from 'jose';
import type { Role } from '@wh/shared';
import { config } from '../config.js';

const key = new TextEncoder().encode(config.JWT_SECRET);

export interface AccessClaims { sub: string; role: Role; wh: string | null }

export async function signAccessToken(c: AccessClaims): Promise<string> {
  return new SignJWT({ role: c.role, wh: c.wh })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(c.sub)
    .setIssuedAt()
    .setIssuer('wh-reg')
    .setExpirationTime(config.ACCESS_TOKEN_TTL)
    .sign(key);
}

export async function verifyAccessToken(token: string): Promise<AccessClaims> {
  const { payload } = await jwtVerify(token, key, { issuer: 'wh-reg', algorithms: ['HS256'] });
  return { sub: payload.sub!, role: payload.role as Role, wh: (payload.wh as string | null) ?? null };
}

/** Opaque refresh token; only its SHA-256 is stored. */
export function newRefreshToken() {
  const token = randomBytes(32).toString('base64url');
  return { token, hash: hashToken(token) };
}
export const hashToken = (t: string) => createHash('sha256').update(t).digest('hex');

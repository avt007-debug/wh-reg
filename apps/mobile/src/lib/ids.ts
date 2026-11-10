import * as Crypto from 'expo-crypto';

/**
 * Idempotency key generated when a form is OPENED. Retries after a network
 * drop resend the same id, so the server returns the original invoice instead
 * of creating a duplicate. Reset only after a confirmed success.
 */
export const newClientTxnId = () => Crypto.randomUUID();
export const todayIST = () => new Date(Date.now() + 5.5 * 3600_000).toISOString().slice(0, 10);

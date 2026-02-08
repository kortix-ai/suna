import { createHmac } from 'crypto';
import { config } from '../config';

/**
 * Generate a random string of specified length.
 */
export function generateRandomString(length: number): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let result = '';
  const randomBytes = crypto.getRandomValues(new Uint8Array(length));
  for (let i = 0; i < length; i++) {
    result += chars[randomBytes[i] % chars.length];
  }
  return result;
}

/**
 * Generate a public/secret key pair.
 * Format: pk_xxx (public), sk_xxx (secret)
 */
export function generateKeyPair(): { publicKey: string; secretKey: string } {
  const pkSuffix = generateRandomString(32);
  const skSuffix = generateRandomString(32);

  return {
    publicKey: `pk_${pkSuffix}`,
    secretKey: `sk_${skSuffix}`,
  };
}

/**
 * Hash a secret key using HMAC-SHA256.
 */
export function hashSecretKey(secretKey: string): string {
  const secret = config.API_KEY_SECRET;
  if (!secret) {
    throw new Error('API_KEY_SECRET not configured');
  }

  return createHmac('sha256', secret)
    .update(secretKey)
    .digest('hex');
}

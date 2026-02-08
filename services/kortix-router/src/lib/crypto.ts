import { createHmac, timingSafeEqual } from 'crypto';
import { config } from '../config';

/**
 * Hash a secret key using HMAC-SHA256.
 * Uses the same algorithm as Python backend (backend/core/services/api_keys.py).
 *
 * Python equivalent:
 *   hmac.new(secret, secret_key.encode('utf-8'), hashlib.sha256).hexdigest()
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

/**
 * Verify a secret key against a stored hash using constant-time comparison.
 */
export function verifySecretKey(secretKey: string, storedHash: string): boolean {
  try {
    const computedHash = hashSecretKey(secretKey);

    // Constant-time comparison to prevent timing attacks
    const storedBuffer = Buffer.from(storedHash, 'hex');
    const computedBuffer = Buffer.from(computedHash, 'hex');

    if (storedBuffer.length !== computedBuffer.length) {
      return false;
    }

    return timingSafeEqual(storedBuffer, computedBuffer);
  } catch {
    return false;
  }
}

/**
 * Check if API key secret is configured.
 */
export function isApiKeySecretConfigured(): boolean {
  return !!config.API_KEY_SECRET;
}

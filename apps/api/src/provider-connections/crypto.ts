import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from 'node:crypto';
import { config } from '../config';

function key(userId: string, providerId: string, purpose: 'credential' | 'flow') {
  if (!config.API_KEY_SECRET) throw new Error('API_KEY_SECRET is required');
  return Buffer.from(hkdfSync('sha256', config.API_KEY_SECRET, userId,
    `kortix-user-provider-v1:${purpose}:${providerId}`, 32));
}

export function seal(userId: string, providerId: string, purpose: 'credential' | 'flow', value: string) {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key(userId, providerId, purpose), iv);
  const ciphertext = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
  return ['v1', iv.toString('base64url'), cipher.getAuthTag().toString('base64url'), ciphertext.toString('base64url')].join(':');
}

export function unseal(userId: string, providerId: string, purpose: 'credential' | 'flow', envelope: string) {
  const [version, iv, tag, ciphertext, extra] = envelope.split(':');
  if (version !== 'v1' || !iv || !tag || !ciphertext || extra) throw new Error('Invalid credential envelope');
  const decipher = createDecipheriv('aes-256-gcm', key(userId, providerId, purpose), Buffer.from(iv, 'base64url'));
  decipher.setAuthTag(Buffer.from(tag, 'base64url'));
  return Buffer.concat([decipher.update(Buffer.from(ciphertext, 'base64url')), decipher.final()]).toString('utf8');
}

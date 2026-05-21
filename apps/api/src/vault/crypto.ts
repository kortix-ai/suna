// Vault encryption: AES-256-GCM, key derived per OWNER ACCOUNT (so an item can
// be account-wide or personal and still decrypt with one stable key). Envelope
// version v2 — distinct from the legacy per-project v1 (projects/secrets.ts) so
// migrated values are unambiguous.
import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from 'node:crypto';
import { config } from '../config';

const ENVELOPE_VERSION = 'v2';
const NAME_REGEX = /^[A-Z_][A-Z0-9_]{0,127}$/;

export function isValidVaultName(name: string): boolean {
  return NAME_REGEX.test(name);
}

const b64url = (b: Buffer) => b.toString('base64url');
const fromB64url = (s: string) => Buffer.from(s, 'base64url');

function accountKey(accountId: string): Buffer {
  if (!config.API_KEY_SECRET) {
    throw new Error('API_KEY_SECRET not configured; cannot encrypt vault items');
  }
  return Buffer.from(
    hkdfSync(
      'sha256',
      Buffer.from(config.API_KEY_SECRET, 'utf8'),
      Buffer.from(accountId, 'utf8'),
      Buffer.from('kortix-vault-v2', 'utf8'),
      32,
    ),
  );
}

export function encryptVaultValue(accountId: string, value: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', accountKey(accountId), iv);
  const ciphertext = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${ENVELOPE_VERSION}:${b64url(iv)}:${b64url(tag)}:${b64url(ciphertext)}`;
}

export function decryptVaultValue(accountId: string, valueEnc: string): string {
  const [version, ivB64, tagB64, ctB64] = valueEnc.split(':');
  if (version !== ENVELOPE_VERSION || !ivB64 || !tagB64 || !ctB64) {
    throw new Error('Unsupported vault envelope');
  }
  const decipher = createDecipheriv('aes-256-gcm', accountKey(accountId), fromB64url(ivB64));
  decipher.setAuthTag(fromB64url(tagB64));
  return Buffer.concat([decipher.update(fromB64url(ctB64)), decipher.final()]).toString('utf8');
}

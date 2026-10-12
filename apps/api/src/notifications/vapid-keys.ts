// The Web Push (VAPID) key pair (KRTX-1742). Generated once per environment on
// first use and stored in `kortix.platform_settings` under `web_push_vapid`,
// so no deployment needs a new secret. Browsers bind a subscription to the
// public key: never rotate it silently, every subscription would stop.
//
// The private key is sealed with AES-256-GCM under a key derived from
// API_KEY_SECRET (HKDF-SHA256, own salt and info: domain-separated from every
// other use of that secret).
import { createCipheriv, createDecipheriv, createPrivateKey, generateKeyPairSync, hkdfSync, randomBytes } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { platformSettings, type Database } from '@kortix/db';
import { config } from '../config';
import { db as defaultDb } from '../shared/db';
import type { VapidKeyPair } from './web-push';

export const VAPID_SETTING_KEY = 'web_push_vapid';

interface StoredVapid {
  public_key: string;
  /** base64url(iv 12 || tag 16 || ciphertext) of the JWK `d`. */
  private_key_enc: string;
}

function sealingKey(): Buffer {
  return Buffer.from(hkdfSync('sha256', config.API_KEY_SECRET, 'web-push', 'kortix-web-push-vapid-v1', 32));
}

function seal(plain: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', sealingKey(), iv);
  const ciphertext = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), ciphertext]).toString('base64url');
}

function unseal(sealed: string): string {
  const data = Buffer.from(sealed, 'base64url');
  const decipher = createDecipheriv('aes-256-gcm', sealingKey(), data.subarray(0, 12));
  decipher.setAuthTag(data.subarray(12, 28));
  return Buffer.concat([decipher.update(data.subarray(28)), decipher.final()]).toString('utf8');
}

function generate(): StoredVapid {
  const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const jwk = privateKey.export({ format: 'jwk' }) as { x: string; y: string; d: string };
  const publicKey = Buffer.concat([Buffer.from([4]), Buffer.from(jwk.x, 'base64url'), Buffer.from(jwk.y, 'base64url')]);
  return { public_key: publicKey.toString('base64url'), private_key_enc: seal(jwk.d) };
}

function open(stored: StoredVapid): VapidKeyPair {
  const point = Buffer.from(stored.public_key, 'base64url');
  const privateKey = createPrivateKey({
    key: {
      kty: 'EC',
      crv: 'P-256',
      x: point.subarray(1, 33).toString('base64url'),
      y: point.subarray(33, 65).toString('base64url'),
      d: unseal(stored.private_key_enc),
    },
    format: 'jwk',
  });
  return { publicKey: stored.public_key, privateKey };
}

async function readStored(database: Database): Promise<StoredVapid | null> {
  const [row] = await database
    .select({ value: platformSettings.value })
    .from(platformSettings)
    .where(eq(platformSettings.key, VAPID_SETTING_KEY));
  const value = row?.value as Partial<StoredVapid> | undefined;
  return value?.public_key && value.private_key_enc ? (value as StoredVapid) : null;
}

/**
 * Read the pair, or create it. Two replicas racing on the first read both
 * insert with ON CONFLICT DO NOTHING and then read the one row that won.
 * Uncached; callers use `getVapidKeyPair`.
 */
export async function loadOrCreateVapidKeys(database: Database = defaultDb): Promise<VapidKeyPair> {
  const existing = await readStored(database);
  if (existing) return open(existing);
  await database
    .insert(platformSettings)
    .values({ key: VAPID_SETTING_KEY, value: generate() })
    .onConflictDoNothing({ target: platformSettings.key });
  const stored = await readStored(database);
  if (!stored) throw new Error('web push key pair was not stored');
  return open(stored);
}

// replica-local: the decrypted pair, read once per process. The row never
// changes after it is written, so a process-lifetime cache cannot go stale.
let cached: Promise<VapidKeyPair> | null = null;

/** The pair the Web Push sender signs with. */
export function getVapidKeyPair(): Promise<VapidKeyPair> {
  cached ??= loadOrCreateVapidKeys().catch((error) => {
    cached = null;
    throw error;
  });
  return cached;
}

/** base64url uncompressed P-256 public key, generated once per environment. */
export async function getVapidPublicKey(): Promise<string> {
  return (await getVapidKeyPair()).publicKey;
}

/** Drop the process cache, so a test can prove what the database holds. */
export function forgetVapidKeysForTest(): void {
  cached = null;
}

import {
  createCipheriv,
  createDecipheriv,
  hkdfSync,
  randomBytes,
} from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { accountSecrets } from '@kortix/db';
import { config } from '../config';
import { db } from '../shared/db';

const SECRET_NAME_REGEX = /^[A-Z_][A-Z0-9_]{0,63}$/;
const ENVELOPE_VERSION = 'v1';

export type AccountSecretKind = 'api_key' | 'oauth_subscription';

export type OAuthSubscriptionPayload = {
  provider: 'chatgpt';
  access_token: string;
  refresh_token: string;
  // ISO timestamp of access_token expiry. Used to decide JIT refresh at boot.
  expires_at: string;
  id_token?: string;
  account_id_external?: string;
};

function b64url(input: Buffer): string {
  return input.toString('base64url');
}

function fromB64url(input: string): Buffer {
  return Buffer.from(input, 'base64url');
}

export function isValidSecretName(name: string): boolean {
  return SECRET_NAME_REGEX.test(name);
}

function accountSecretKey(accountId: string): Buffer {
  if (!config.API_KEY_SECRET) {
    throw new Error('API_KEY_SECRET not configured; cannot encrypt account secrets');
  }
  const key = hkdfSync(
    'sha256',
    Buffer.from(config.API_KEY_SECRET, 'utf8'),
    Buffer.from(accountId, 'utf8'),
    Buffer.from('kortix-account-secret-v1', 'utf8'),
    32,
  );
  return Buffer.from(key);
}

export function encryptAccountSecret(accountId: string, value: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', accountSecretKey(accountId), iv);
  const ciphertext = Buffer.concat([
    cipher.update(value, 'utf8'),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();
  return `${ENVELOPE_VERSION}:${b64url(iv)}:${b64url(tag)}:${b64url(ciphertext)}`;
}

export function decryptAccountSecret(accountId: string, valueEnc: string): string {
  const [version, ivB64, tagB64, ciphertextB64] = valueEnc.split(':');
  if (version !== ENVELOPE_VERSION || !ivB64 || !tagB64 || !ciphertextB64) {
    throw new Error('Unsupported account secret envelope');
  }
  const decipher = createDecipheriv('aes-256-gcm', accountSecretKey(accountId), fromB64url(ivB64));
  decipher.setAuthTag(fromB64url(tagB64));
  return Buffer.concat([
    decipher.update(fromB64url(ciphertextB64)),
    decipher.final(),
  ]).toString('utf8');
}

export function encodeOAuthSubscription(payload: OAuthSubscriptionPayload): string {
  return JSON.stringify(payload);
}

export function decodeOAuthSubscription(raw: string): OAuthSubscriptionPayload {
  const parsed = JSON.parse(raw) as OAuthSubscriptionPayload;
  if (!parsed.provider || !parsed.access_token || !parsed.refresh_token) {
    throw new Error('Malformed oauth_subscription payload');
  }
  return parsed;
}

export type AccountSecretRow = {
  secretId: string;
  name: string;
  kind: AccountSecretKind;
  provider: string | null;
  /** Decrypted plaintext for api_key kind, or raw JSON envelope for oauth_subscription. */
  value: string;
};

/**
 * Decrypted listing of every secret on the account. Caller decides how to
 * materialize each row into env vars (api_key → direct, oauth_subscription →
 * refresh-then-inject via provider-specific mapping).
 */
export async function listAccountSecrets(accountId: string): Promise<AccountSecretRow[]> {
  const rows = await db
    .select({
      secretId: accountSecrets.secretId,
      name: accountSecrets.name,
      valueEnc: accountSecrets.valueEnc,
      kind: accountSecrets.kind,
      provider: accountSecrets.provider,
    })
    .from(accountSecrets)
    .where(eq(accountSecrets.accountId, accountId));

  return rows.map((row) => ({
    secretId: row.secretId,
    name: row.name,
    kind: row.kind as AccountSecretKind,
    provider: row.provider,
    value: decryptAccountSecret(accountId, row.valueEnc),
  }));
}

export async function getAccountSecretValue(
  accountId: string,
  name: string,
): Promise<string | null> {
  const normalizedName = name.trim().toUpperCase();
  const [row] = await db
    .select({ valueEnc: accountSecrets.valueEnc })
    .from(accountSecrets)
    .where(and(
      eq(accountSecrets.accountId, accountId),
      eq(accountSecrets.name, normalizedName),
    ))
    .limit(1);

  return row ? decryptAccountSecret(accountId, row.valueEnc) : null;
}

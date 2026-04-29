/**
 * Per-account integration credential store.
 * Resolution: request headers → account DB → API env defaults.
 */

import { eq, and } from 'drizzle-orm';
import { createCipheriv, createDecipheriv, randomBytes, createHash } from 'crypto';
import { db } from '../shared/db';
import { integrationCredentials } from '@kortix/db';
import { config } from '../config';

export interface PipedreamCreds {
  client_id: string;
  client_secret: string;
  project_id: string;
  environment?: string;
}

// ─── Field-level encryption (AES-256-GCM) ────────────────────────────────────
// Key derived from API_KEY_SECRET so no new env var is required.
// Encrypted format: "enc:v1:<iv_hex>:<authTag_hex>:<ciphertext_hex>"

const ENC_PREFIX = 'enc:v1:';

function getDerivedKey(): Buffer {
  const secret = config.API_KEY_SECRET;
  if (!secret) throw new Error('API_KEY_SECRET not configured — cannot encrypt credentials');
  return createHash('sha256').update(`cred-enc:${secret}`).digest();
}

function encryptField(plaintext: string): string {
  const key = getDerivedKey();
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${ENC_PREFIX}${iv.toString('hex')}:${tag.toString('hex')}:${ct.toString('hex')}`;
}

function decryptField(value: string): string {
  // Transparent passthrough for legacy plaintext values
  if (!value.startsWith(ENC_PREFIX)) return value;
  const parts = value.slice(ENC_PREFIX.length).split(':');
  if (parts.length !== 3) throw new Error('Invalid encrypted credential format');
  const [ivHex, tagHex, ctHex] = parts;
  const key = getDerivedKey();
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(ivHex!, 'hex'));
  decipher.setAuthTag(Buffer.from(tagHex!, 'hex'));
  return decipher.update(Buffer.from(ctHex!, 'hex')).toString('utf8') + decipher.final('utf8');
}

export async function getAccountCreds(accountId: string, provider = 'pipedream'): Promise<PipedreamCreds | null> {
  try {
    const [row] = await db
      .select()
      .from(integrationCredentials)
      .where(
        and(
          eq(integrationCredentials.accountId, accountId),
          eq(integrationCredentials.provider, provider),
          eq(integrationCredentials.isActive, true),
        ),
      )
      .limit(1);

    if (!row) return null;
    const creds = row.credentials as Record<string, string>;
    if (!creds.client_id || !creds.client_secret || !creds.project_id) return null;

    // Decrypt client_secret — transparent passthrough for legacy plaintext rows
    const plainSecret = decryptField(creds.client_secret);

    // Lazy re-encrypt plaintext rows on next read so migration is seamless
    if (!creds.client_secret.startsWith(ENC_PREFIX)) {
      const encryptedPayload = {
        ...creds,
        client_secret: encryptField(plainSecret),
      };
      await db
        .update(integrationCredentials)
        .set({ credentials: encryptedPayload, updatedAt: new Date() })
        .where(eq(integrationCredentials.id, row.id));
    }

    return {
      client_id: creds.client_id,
      client_secret: plainSecret,
      project_id: creds.project_id,
      environment: creds.environment || 'production',
    };
  } catch (error) {
    console.warn(
      `[PIPEDREAM] Failed to load account credentials for ${accountId}; falling back to env defaults if available: ${error instanceof Error ? error.message : String(error)}`,
    );
    return null;
  }
}

export async function upsertAccountCreds(accountId: string, creds: PipedreamCreds, provider = 'pipedream'): Promise<void> {
  const payload = {
    client_id: creds.client_id,
    client_secret: encryptField(creds.client_secret),  // AES-256-GCM encrypted
    project_id: creds.project_id,
    environment: creds.environment || 'production',
  };

  const [existing] = await db
    .select({ id: integrationCredentials.id })
    .from(integrationCredentials)
    .where(and(eq(integrationCredentials.accountId, accountId), eq(integrationCredentials.provider, provider)))
    .limit(1);

  if (existing) {
    await db
      .update(integrationCredentials)
      .set({ credentials: payload, isActive: true, updatedAt: new Date() })
      .where(eq(integrationCredentials.id, existing.id));
  } else {
    await db.insert(integrationCredentials).values({ accountId, provider, credentials: payload });
  }
}

export async function deleteAccountCreds(accountId: string, provider = 'pipedream'): Promise<void> {
  await db
    .delete(integrationCredentials)
    .where(and(eq(integrationCredentials.accountId, accountId), eq(integrationCredentials.provider, provider)));
}

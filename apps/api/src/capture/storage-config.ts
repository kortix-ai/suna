/**
 * Per-account Capture storage destination.
 *
 * An account keeps its recordings either in the deployment's managed store
 * (the default — `store.ts`) or in its own S3-compatible bucket ("bring your
 * own storage"). The choice lives in `capture_workspaces.storage`. A static
 * secret inside it is AES-256-GCM encrypted (same primitive as project
 * secrets, `projects/secrets/envelope.ts`); it is never returned to a client
 * and never written to the bucket (unlike `policy`, which devices read).
 *
 * `readResolvedStorage` is the server-only read that decrypts the secret.
 * `storageView` is the redacted read a client gets.
 */
import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from 'node:crypto';
import { captureWorkspaces } from '@kortix/db';
import { eq, sql } from 'drizzle-orm';
import { z } from 'zod';
import { config } from '../config';
import { db } from '../shared/db';

// ─── secret envelope (AES-256-GCM, key derived per account) ──────────────────

const ENVELOPE_VERSION = 'v1';
const GCM_AUTH_TAG_LENGTH = 16;

function storageKey(accountId: string): Buffer {
  if (!config.API_KEY_SECRET) throw new Error('API_KEY_SECRET not configured; cannot encrypt capture storage secret');
  return Buffer.from(
    hkdfSync('sha256', Buffer.from(config.API_KEY_SECRET, 'utf8'), Buffer.from(accountId, 'utf8'), Buffer.from('kortix-capture-storage-v1', 'utf8'), 32),
  );
}

export function encryptStorageSecret(accountId: string, value: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', storageKey(accountId), iv, { authTagLength: GCM_AUTH_TAG_LENGTH });
  const ciphertext = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
  return `${ENVELOPE_VERSION}:${iv.toString('base64url')}:${cipher.getAuthTag().toString('base64url')}:${ciphertext.toString('base64url')}`;
}

export function decryptStorageSecret(accountId: string, enc: string): string {
  const [version, ivB64, tagB64, ctB64] = enc.split(':');
  if (version !== ENVELOPE_VERSION || !ivB64 || !tagB64 || ctB64 === undefined) throw new Error('Unsupported capture storage secret envelope');
  const decipher = createDecipheriv('aes-256-gcm', storageKey(accountId), Buffer.from(ivB64, 'base64url'), { authTagLength: GCM_AUTH_TAG_LENGTH });
  decipher.setAuthTag(Buffer.from(tagB64, 'base64url'));
  return Buffer.concat([decipher.update(Buffer.from(ctB64, 'base64url')), decipher.final()]).toString('utf8');
}

// ─── shapes ──────────────────────────────────────────────────────────────────

/** The S3 fields a client sends (`secret_access_key` is plaintext in, encrypted at rest). */
export const S3InputSchema = z.object({
  mode: z.literal('s3'),
  endpoint: z.string().trim().max(2000).optional().default(''),
  region: z.string().trim().min(1).max(200),
  bucket: z.string().trim().min(1).max(200),
  force_path_style: z.boolean().optional().default(false),
  role_arn: z.string().trim().max(2000).optional().default(''),
  access_key_id: z.string().trim().max(500).optional().default(''),
  secret_access_key: z.string().max(500).optional().default(''),
});

/** The write input: `kortix` (managed) or `s3` (own bucket, with exactly one credential form). */
export const StorageInputSchema = z
  .discriminatedUnion('mode', [z.object({ mode: z.literal('kortix') }), S3InputSchema])
  .refine(
    (v) => v.mode !== 's3' || (v.role_arn ? !v.access_key_id : Boolean(v.access_key_id && v.secret_access_key)),
    'Give exactly one credential form: a role_arn (STS), or access_key_id + secret_access_key.',
  );
export type StorageInput = z.infer<typeof StorageInputSchema>;

/** The resolved, server-side config: the secret is decrypted. Never leaves the server. */
export type ResolvedStorage =
  | { mode: 'kortix' }
  | {
      mode: 's3';
      endpoint: string;
      region: string;
      bucket: string;
      forcePathStyle: boolean;
      roleArn: string;
      accessKeyId: string;
      secretAccessKey: string;
    };

/** The stored form parsed from the row (secret still encrypted). */
const StoredS3Schema = z.object({
  mode: z.literal('s3'),
  endpoint: z.string().default(''),
  region: z.string().default('us-east-1'),
  bucket: z.string(),
  force_path_style: z.boolean().default(false),
  role_arn: z.string().default(''),
  access_key_id: z.string().default(''),
  secret_access_key_enc: z.string().default(''),
});

/** Convert a write input into the row value, encrypting the secret. */
export function toStored(accountId: string, input: StorageInput): Record<string, unknown> {
  if (input.mode !== 's3') return { mode: 'kortix' };
  return {
    mode: 's3',
    endpoint: input.endpoint,
    region: input.region,
    bucket: input.bucket,
    force_path_style: input.force_path_style,
    role_arn: input.role_arn,
    access_key_id: input.access_key_id,
    secret_access_key_enc: input.secret_access_key ? encryptStorageSecret(accountId, input.secret_access_key) : '',
  };
}

/** Build a resolved config from a write input (for the pre-save reachability probe). */
export function resolveInput(input: StorageInput): ResolvedStorage {
  if (input.mode !== 's3') return { mode: 'kortix' };
  return {
    mode: 's3',
    endpoint: input.endpoint,
    region: input.region || 'us-east-1',
    bucket: input.bucket,
    forcePathStyle: input.force_path_style,
    roleArn: input.role_arn,
    accessKeyId: input.access_key_id,
    secretAccessKey: input.secret_access_key,
  };
}

async function readRow(accountId: string): Promise<Record<string, unknown>> {
  const [row] = await db.select({ storage: captureWorkspaces.storage }).from(captureWorkspaces).where(eq(captureWorkspaces.accountId, accountId)).limit(1);
  return row?.storage ?? {};
}

/** The server-side config with the secret decrypted. `kortix` when none is set. */
export async function readResolvedStorage(accountId: string): Promise<ResolvedStorage> {
  const raw = await readRow(accountId);
  if ((raw as { mode?: string }).mode !== 's3') return { mode: 'kortix' };
  const s = StoredS3Schema.parse(raw);
  return {
    mode: 's3',
    endpoint: s.endpoint,
    region: s.region || 'us-east-1',
    bucket: s.bucket,
    forcePathStyle: s.force_path_style,
    roleArn: s.role_arn,
    accessKeyId: s.access_key_id,
    secretAccessKey: s.secret_access_key_enc ? decryptStorageSecret(accountId, s.secret_access_key_enc) : '',
  };
}

/** The redacted view a client reads: the mode and non-secret fields, never the secret. */
export async function storageView(accountId: string): Promise<Record<string, unknown>> {
  const raw = await readRow(accountId);
  if ((raw as { mode?: string }).mode !== 's3') return { mode: 'kortix' };
  const s = StoredS3Schema.parse(raw);
  return {
    mode: 's3',
    endpoint: s.endpoint,
    region: s.region,
    bucket: s.bucket,
    force_path_style: s.force_path_style,
    role_arn: s.role_arn,
    access_key_id: s.access_key_id,
    has_secret: Boolean(s.secret_access_key_enc),
    // Static keys cannot be scoped per device; role_arn can. Surfaced so the UI can warn.
    per_device_scoped: Boolean(s.role_arn),
  };
}

/** Write the account's storage config. The secret is already encrypted by `toStored`. */
export async function writeStorageConfig(accountId: string, input: StorageInput, userId: string): Promise<Record<string, unknown>> {
  const stored = toStored(accountId, input);
  await db
    .insert(captureWorkspaces)
    .values({ accountId, storage: stored, updatedBy: userId })
    .onConflictDoUpdate({ target: captureWorkspaces.accountId, set: { storage: stored, updatedBy: userId, updatedAt: sql`now()` } });
  return storageView(accountId);
}

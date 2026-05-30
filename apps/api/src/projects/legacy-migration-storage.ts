/**
 * Durable backup storage for legacy migrations, on Supabase Storage (reuses the
 * existing service-role client — no new infra).
 *
 * The backup bundle is a tarball of the legacy VM's workspace files + the
 * OpenCode chat-history store. It is BOTH the safety copy (the legacy VM can be
 * decommissioned after migration) and the source the new sandbox rehydrates the
 * chat history from on first boot.
 *
 * The VM uploads directly to a signed URL so Supabase credentials never touch
 * the VM. Download (for rehydrate) uses a signed read URL.
 */
import { config } from '../config';
import { getSupabase } from '../shared/supabase';

const BUCKET = () => config.LEGACY_MIGRATION_BACKUP_BUCKET;

/** Stable object path for a sandbox's backup bundle. */
export function backupObjectPath(sandboxId: string): string {
  return `${sandboxId}/bundle.tar.gz`;
}

/** Ensure the private backup bucket exists. Idempotent. */
export async function ensureBackupBucket(): Promise<void> {
  const supabase = getSupabase();
  const { data, error } = await supabase.storage.getBucket(BUCKET());
  if (data) return;
  if (error && !/not found/i.test(error.message)) throw error;
  const { error: createError } = await supabase.storage.createBucket(BUCKET(), { public: false });
  // Tolerate a concurrent creator winning the race.
  if (createError && !/already exists/i.test(createError.message)) throw createError;
}

export interface SignedUploadTarget {
  /** Absolute URL the VM PUTs the tarball to. */
  url: string;
  /** Storage token (Supabase encodes auth in this; included for completeness). */
  token: string;
  path: string;
}

/**
 * Create a one-shot signed upload URL the VM can PUT the bundle to. `upsert`
 * lets a retried extract overwrite a partial prior upload — keeps the step
 * idempotent.
 */
export async function createBackupUploadTarget(sandboxId: string): Promise<SignedUploadTarget> {
  await ensureBackupBucket();
  const path = backupObjectPath(sandboxId);
  const supabase = getSupabase();
  const { data, error } = await supabase.storage
    .from(BUCKET())
    .createSignedUploadUrl(path, { upsert: true });
  if (error || !data) throw error ?? new Error('Failed to create signed upload URL');
  return { url: data.signedUrl, token: data.token, path };
}

/** True once the bundle object exists (used to make extract idempotent). */
export async function backupExists(sandboxId: string): Promise<boolean> {
  const supabase = getSupabase();
  const path = backupObjectPath(sandboxId);
  const slash = path.lastIndexOf('/');
  const prefix = path.slice(0, slash);
  const name = path.slice(slash + 1);
  const { data, error } = await supabase.storage.from(BUCKET()).list(prefix, { search: name });
  if (error) return false;
  return (data ?? []).some((entry) => entry.name === name && (entry.metadata?.size ?? 0) > 0);
}

/** Signed read URL for rehydrate (valid for `expiresInSec`). */
export async function getBackupDownloadUrl(sandboxId: string, expiresInSec = 3600): Promise<string> {
  const supabase = getSupabase();
  const { data, error } = await supabase.storage
    .from(BUCKET())
    .createSignedUrl(backupObjectPath(sandboxId), expiresInSec);
  if (error || !data) throw error ?? new Error('Failed to create signed download URL');
  return data.signedUrl;
}

import { config } from '../config';
import { getSupabase } from '../shared/supabase';

const BUCKET = () => config.LEGACY_MIGRATION_BACKUP_BUCKET;

export function backupObjectPath(sandboxId: string): string {
  return `${sandboxId}/bundle.tar.gz`;
}

export async function ensureBackupBucket(): Promise<void> {
  const supabase = getSupabase();
  const { data, error } = await supabase.storage.getBucket(BUCKET());
  if (data) return;
  if (error && !/not found/i.test(error.message)) throw error;
  const { error: createError } = await supabase.storage.createBucket(BUCKET(), { public: false });
  if (createError && !/already exists/i.test(createError.message)) throw createError;
}

export interface SignedUploadTarget {
  url: string;
  token: string;
  path: string;
}

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

export async function getBackupDownloadUrl(sandboxId: string, expiresInSec = 3600): Promise<string> {
  const supabase = getSupabase();
  const { data, error } = await supabase.storage
    .from(BUCKET())
    .createSignedUrl(backupObjectPath(sandboxId), expiresInSec);
  if (error || !data) throw error ?? new Error('Failed to create signed download URL');
  return data.signedUrl;
}

export function opencodeObjectPath(sandboxId: string): string {
  return `${sandboxId}/opencode.tar.gz`;
}

export async function uploadOpencodeArchive(
  sandboxId: string,
  tarball: Buffer | Uint8Array,
): Promise<string> {
  await ensureBackupBucket();
  const path = opencodeObjectPath(sandboxId);
  const supabase = getSupabase();
  const { error } = await supabase.storage
    .from(BUCKET())
    .upload(path, tarball, { upsert: true, contentType: 'application/gzip' });
  if (error) throw error;
  return path;
}

export async function downloadOpencodeArchive(sandboxId: string): Promise<Buffer | null> {
  const supabase = getSupabase();
  const { data, error } = await supabase.storage
    .from(BUCKET())
    .download(opencodeObjectPath(sandboxId));
  if (error || !data) return null;
  return Buffer.from(await data.arrayBuffer());
}

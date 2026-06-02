import { config } from '../config';
import { getSupabase } from '../shared/supabase';

const BUCKET = () => config.LEGACY_MIGRATION_BACKUP_BUCKET;

export async function ensureBackupBucket(): Promise<void> {
  const supabase = getSupabase();
  const { data, error } = await supabase.storage.getBucket(BUCKET());
  if (data) return;
  if (error && !/not found/i.test(error.message)) throw error;
  const { error: createError } = await supabase.storage.createBucket(BUCKET(), { public: false });
  if (createError && !/already exists/i.test(createError.message)) throw createError;
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

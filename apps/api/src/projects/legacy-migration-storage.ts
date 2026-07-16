import { config } from '../config';
import { getSupabase } from '../shared/supabase';

const BUCKET = () => config.LEGACY_MIGRATION_BACKUP_BUCKET;
const ARCHIVE_FILE_SIZE_LIMIT = 5 * 1024 * 1024 * 1024;

export async function ensureBackupBucket(): Promise<void> {
  const supabase = getSupabase();
  const { data, error } = await supabase.storage.getBucket(BUCKET());
  if (data) {
    if ((data.file_size_limit ?? 0) < ARCHIVE_FILE_SIZE_LIMIT) {
      await supabase.storage
        .updateBucket(BUCKET(), { public: false, fileSizeLimit: ARCHIVE_FILE_SIZE_LIMIT })
        .catch(() => {});
    }
    return;
  }
  if (error && !/not found/i.test(error.message)) throw error;
  const { error: createError } = await supabase.storage.createBucket(BUCKET(), {
    public: false,
    fileSizeLimit: ARCHIVE_FILE_SIZE_LIMIT,
  });
  if (createError && !/already exists/i.test(createError.message)) throw createError;
}

export function opencodeObjectPath(sandboxId: string): string {
  return `${sandboxId}/opencode.tar.gz`;
}

export async function createOpencodeArchiveUploadUrl(
  sandboxId: string,
): Promise<{ uploadUrl: string; path: string }> {
  await ensureBackupBucket();
  const path = opencodeObjectPath(sandboxId);
  const supabase = getSupabase();
  const { data, error } = await supabase.storage
    .from(BUCKET())
    .createSignedUploadUrl(path, { upsert: true });
  if (error || !data?.signedUrl) {
    throw error ?? new Error('failed to create opencode archive upload url');
  }
  return { uploadUrl: data.signedUrl, path };
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

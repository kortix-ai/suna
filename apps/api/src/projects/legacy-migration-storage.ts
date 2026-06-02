import { config } from '../config';
import { getSupabase } from '../shared/supabase';

const BUCKET = () => config.LEGACY_MIGRATION_BACKUP_BUCKET;

// opencode stores routinely run to hundreds of MB (a busy machine's opencode.db
// is 400MB+). The bucket must allow that or the archive upload 413s and the
// chat history is silently dropped. 5GB covers any realistic store with margin;
// the project-level global upload limit must be >= this for it to take effect.
const ARCHIVE_FILE_SIZE_LIMIT = 5 * 1024 * 1024 * 1024; // 5GB

export async function ensureBackupBucket(): Promise<void> {
  const supabase = getSupabase();
  const { data, error } = await supabase.storage.getBucket(BUCKET());
  if (data) {
    // Best-effort raise of a too-small limit on a pre-existing bucket. Tolerate
    // failure (e.g. the global cap is lower) — the upload itself will surface it.
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

/**
 * Mint a one-shot signed PUT URL so the legacy VM can stream the opencode
 * archive straight into storage. This replaces piping the whole (100s-of-MB)
 * tarball back as base64 through the toolbox exec stdout, which was both
 * memory-heavy and unreliable at size. The URL targets `opencodeObjectPath`, the
 * same key `downloadOpencodeArchive` / rehydrate read from.
 */
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

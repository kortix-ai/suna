/**
 * The shared-filesystem service: metadata in PostgreSQL, bytes in the blob
 * store, and the rule that a file row always knows which store holds its bytes.
 *
 * Deletes are metadata-only ON PURPOSE. Blobs are content-addressed and shared,
 * so removing the bytes when one path is deleted would corrupt every other path
 * (and every other filesystem) that happens to hold the same content. Reclaiming
 * an unreferenced blob is a sweep over `filesystem_files`, not a side effect of
 * one delete — see `sweepUnreferencedBlobs` in ./gc.ts.
 */
import { and, asc, count, eq, like, sql } from 'drizzle-orm';
import { filesystemBlobs, filesystemFiles, filesystems } from '@kortix/db';
import { config } from '../config';
import { db } from '../shared/db';
import {
  createBlobStore,
  PostgresBlobStore,
  sha256Hex,
  type BlobRows,
  type BlobStore,
  type BlobStorageKind,
} from './blob-store';
import { normalizeFilePath, normalizeFilesystemName, normalizeListPrefix } from './paths';

/** Refuse a single object large enough to hurt the database or the request. */
export const MAX_FILE_BYTES = 25 * 1024 * 1024;

const blobRows: BlobRows = {
  async insertBlob(sha256, size, content) {
    await db
      .insert(filesystemBlobs)
      .values({ sha256, size, content })
      .onConflictDoNothing({ target: filesystemBlobs.sha256 });
  },
  async selectBlob(sha256) {
    const [row] = await db
      .select({ content: filesystemBlobs.content })
      .from(filesystemBlobs)
      .where(eq(filesystemBlobs.sha256, sha256))
      .limit(1);
    return row?.content ?? null;
  },
  async deleteBlob(sha256) {
    await db.delete(filesystemBlobs).where(eq(filesystemBlobs.sha256, sha256));
  },
};

let cachedStore: BlobStore | null = null;
export function blobStore(): BlobStore {
  if (!cachedStore) {
    cachedStore = createBlobStore(
      {
        s3Bucket: config.KORTIX_FS_S3_BUCKET,
        s3Region: config.KORTIX_FS_S3_REGION,
        s3Endpoint: config.KORTIX_FS_S3_ENDPOINT,
        s3Prefix: config.KORTIX_FS_S3_PREFIX,
        s3AccessKeyId: config.KORTIX_FS_S3_ACCESS_KEY_ID,
        s3SecretAccessKey: config.KORTIX_FS_S3_SECRET_ACCESS_KEY,
      },
      blobRows,
    );
  }
  return cachedStore;
}

/** Tests reset the memoised backend when they change configuration. */
export function resetBlobStoreForTest(): void {
  cachedStore = null;
}

export interface FilesystemRow {
  filesystemId: string;
  name: string;
  description: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export async function listFilesystems(projectId: string): Promise<FilesystemRow[]> {
  return await db
    .select({
      filesystemId: filesystems.filesystemId,
      name: filesystems.name,
      description: filesystems.description,
      createdAt: filesystems.createdAt,
      updatedAt: filesystems.updatedAt,
    })
    .from(filesystems)
    .where(eq(filesystems.projectId, projectId))
    .orderBy(asc(filesystems.name));
}

export async function findFilesystem(
  projectId: string,
  name: string,
): Promise<FilesystemRow | null> {
  const normalized = normalizeFilesystemName(name);
  if (!normalized.ok) return null;
  const [row] = await db
    .select({
      filesystemId: filesystems.filesystemId,
      name: filesystems.name,
      description: filesystems.description,
      createdAt: filesystems.createdAt,
      updatedAt: filesystems.updatedAt,
    })
    .from(filesystems)
    .where(and(eq(filesystems.projectId, projectId), eq(filesystems.name, normalized.path)))
    .limit(1);
  return row ?? null;
}

export type CreateResult =
  | { ok: true; filesystem: FilesystemRow; created: boolean }
  | { ok: false; reason: string };

/**
 * Idempotent by name. An agent that runs `fs create notes` twice — or two
 * agents that race to create the same shared volume — must both end up with the
 * one filesystem, not an error the second caller has to special-case.
 */
export async function createFilesystem(
  projectId: string,
  name: string,
  description?: string | null,
): Promise<CreateResult> {
  const normalized = normalizeFilesystemName(name);
  if (!normalized.ok) return { ok: false, reason: normalized.reason };

  const inserted = await db
    .insert(filesystems)
    .values({ projectId, name: normalized.path, description: description ?? null })
    .onConflictDoNothing({ target: [filesystems.projectId, filesystems.name] })
    .returning({
      filesystemId: filesystems.filesystemId,
      name: filesystems.name,
      description: filesystems.description,
      createdAt: filesystems.createdAt,
      updatedAt: filesystems.updatedAt,
    });

  if (inserted[0]) return { ok: true, filesystem: inserted[0], created: true };
  const existing = await findFilesystem(projectId, normalized.path);
  if (!existing) return { ok: false, reason: 'filesystem could not be created' };
  return { ok: true, filesystem: existing, created: false };
}

export async function deleteFilesystem(projectId: string, name: string): Promise<boolean> {
  const fs = await findFilesystem(projectId, name);
  if (!fs) return false;
  // filesystem_files cascades; blobs are shared, so they are left for the sweep.
  await db.delete(filesystems).where(eq(filesystems.filesystemId, fs.filesystemId));
  return true;
}

export interface FileMetadata {
  path: string;
  size: number;
  sha256: string;
  contentType: string;
  storage: BlobStorageKind;
  createdAt: Date;
  updatedAt: Date;
}

export type PutResult =
  | { ok: true; file: FileMetadata; created: boolean }
  | { ok: false; reason: string };

export async function putFile(input: {
  filesystemId: string;
  path: string;
  bytes: Uint8Array;
  contentType?: string;
}): Promise<PutResult> {
  const normalized = normalizeFilePath(input.path);
  if (!normalized.ok) return { ok: false, reason: normalized.reason };
  if (input.bytes.byteLength > MAX_FILE_BYTES) {
    return { ok: false, reason: `file exceeds the ${MAX_FILE_BYTES} byte limit` };
  }

  const store = blobStore();
  const sha256 = sha256Hex(input.bytes);
  const contentType = input.contentType?.trim() || 'application/octet-stream';

  // Bytes FIRST. A metadata row pointing at a blob that was never stored is a
  // file that lists and stats but cannot be read; the reverse — an orphan blob
  // — is invisible and reclaimable.
  await store.put(sha256, input.bytes);

  const existing = await db
    .select({ path: filesystemFiles.path })
    .from(filesystemFiles)
    .where(
      and(
        eq(filesystemFiles.filesystemId, input.filesystemId),
        eq(filesystemFiles.path, normalized.path),
      ),
    )
    .limit(1);

  const [row] = await db
    .insert(filesystemFiles)
    .values({
      filesystemId: input.filesystemId,
      path: normalized.path,
      size: input.bytes.byteLength,
      sha256,
      contentType,
      storage: store.kind,
    })
    .onConflictDoUpdate({
      target: [filesystemFiles.filesystemId, filesystemFiles.path],
      set: {
        size: input.bytes.byteLength,
        sha256,
        contentType,
        storage: store.kind,
        updatedAt: sql`now()`,
      },
    })
    .returning({
      path: filesystemFiles.path,
      size: filesystemFiles.size,
      sha256: filesystemFiles.sha256,
      contentType: filesystemFiles.contentType,
      storage: filesystemFiles.storage,
      createdAt: filesystemFiles.createdAt,
      updatedAt: filesystemFiles.updatedAt,
    });

  await db
    .update(filesystems)
    .set({ updatedAt: sql`now()` })
    .where(eq(filesystems.filesystemId, input.filesystemId));

  return {
    ok: true,
    file: { ...row, storage: row.storage as BlobStorageKind },
    created: existing.length === 0,
  };
}

export async function statFile(
  filesystemId: string,
  path: string,
): Promise<FileMetadata | null> {
  const normalized = normalizeFilePath(path);
  if (!normalized.ok) return null;
  const [row] = await db
    .select({
      path: filesystemFiles.path,
      size: filesystemFiles.size,
      sha256: filesystemFiles.sha256,
      contentType: filesystemFiles.contentType,
      storage: filesystemFiles.storage,
      createdAt: filesystemFiles.createdAt,
      updatedAt: filesystemFiles.updatedAt,
    })
    .from(filesystemFiles)
    .where(
      and(eq(filesystemFiles.filesystemId, filesystemId), eq(filesystemFiles.path, normalized.path)),
    )
    .limit(1);
  return row ? { ...row, storage: row.storage as BlobStorageKind } : null;
}

export type ReadResult =
  | { ok: true; file: FileMetadata; bytes: Uint8Array }
  | { ok: false; reason: 'not_found' | 'bytes_missing' | 'storage_unavailable' };

export async function readFile(filesystemId: string, path: string): Promise<ReadResult> {
  const meta = await statFile(filesystemId, path);
  if (!meta) return { ok: false, reason: 'not_found' };

  // Read from the store the ROW names, not today's configured default: a
  // deployment that gained S3 must still serve what PostgreSQL already holds.
  const store = blobStore();
  let bytes: Uint8Array | null;
  if (meta.storage === store.kind) {
    bytes = await store.get(meta.sha256);
  } else {
    try {
      bytes = await fallbackStore(meta.storage as BlobStorageKind).get(meta.sha256);
    } catch {
      // Configuration, not data: the row is fine and the bytes are elsewhere.
      return { ok: false, reason: 'storage_unavailable' };
    }
  }
  if (!bytes) return { ok: false, reason: 'bytes_missing' };
  return { ok: true, file: meta, bytes };
}

/**
 * The other backend, for rows written before a storage switch.
 *
 * Only ONE direction is reachable, and saying so is the point. The fallback
 * runs when a row's `storage` differs from the configured default, so a row
 * marked 's3' means the default is 'pg', which means the S3 configuration is
 * absent — there is no S3 client to build. Returning a PostgreSQL store there
 * would look up bytes that were never in PostgreSQL and report "bytes
 * missing", blaming the data for a configuration gap. Report the real cause.
 */
function fallbackStore(kind: BlobStorageKind): BlobStore {
  if (kind === 'pg') return new PostgresBlobStore(blobRows);
  throw new FilesystemStorageUnavailableError(
    'this file was written to S3, but no S3 configuration is present on this deployment',
  );
}

export class FilesystemStorageUnavailableError extends Error {
  code = 'storage_unavailable';
  constructor(message: string) {
    super(message);
    this.name = 'FilesystemStorageUnavailableError';
  }
}

export async function listFiles(input: {
  filesystemId: string;
  prefix?: string | null;
  limit?: number;
}): Promise<{ ok: true; files: FileMetadata[] } | { ok: false; reason: string }> {
  const prefix = normalizeListPrefix(input.prefix ?? '');
  if (!prefix.ok) return { ok: false, reason: prefix.reason };
  const limit = Math.min(Math.max(input.limit ?? 200, 1), 1000);

  const where = prefix.path
    ? and(
        eq(filesystemFiles.filesystemId, input.filesystemId),
        // `like` with an escaped prefix: a path containing % or _ must not
        // widen someone else's listing.
        like(filesystemFiles.path, `${prefix.path.replace(/[%_\\]/g, '\\$&')}%`),
      )
    : eq(filesystemFiles.filesystemId, input.filesystemId);

  const rows = await db
    .select({
      path: filesystemFiles.path,
      size: filesystemFiles.size,
      sha256: filesystemFiles.sha256,
      contentType: filesystemFiles.contentType,
      storage: filesystemFiles.storage,
      createdAt: filesystemFiles.createdAt,
      updatedAt: filesystemFiles.updatedAt,
    })
    .from(filesystemFiles)
    .where(where)
    .orderBy(asc(filesystemFiles.path))
    .limit(limit);

  return { ok: true, files: rows.map((r) => ({ ...r, storage: r.storage as BlobStorageKind })) };
}

export async function deleteFile(filesystemId: string, path: string): Promise<boolean> {
  const normalized = normalizeFilePath(path);
  if (!normalized.ok) return false;
  const deleted = await db
    .delete(filesystemFiles)
    .where(
      and(eq(filesystemFiles.filesystemId, filesystemId), eq(filesystemFiles.path, normalized.path)),
    )
    .returning({ path: filesystemFiles.path });
  return deleted.length > 0;
}

/**
 * Blobs no path references any more.
 *
 * Separate from delete on purpose: content addressing means one blob can back
 * many paths across many filesystems, so "is anyone still using this?" is a
 * question only a full scan can answer.
 */
export async function countBlobReferences(sha256: string): Promise<number> {
  const [row] = await db
    .select({ n: count() })
    .from(filesystemFiles)
    .where(eq(filesystemFiles.sha256, sha256));
  return Number(row?.n ?? 0);
}

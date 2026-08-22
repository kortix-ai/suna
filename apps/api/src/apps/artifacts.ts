import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, rm, stat } from 'node:fs/promises';
import { posix, resolve, sep } from 'node:path';
import * as tar from 'tar';
import { getSupabase, toPublicStorageUrl } from '../shared/supabase';

export const APP_ARTIFACT_BUCKET = 'app-artifacts';
// Managed Supabase Storage rejects bucket limits above the project's global
// fileSizeLimit. Kortix cloud currently exposes the standard 50 MiB tier.
// OCI deployments bypass this source-archive limit.
export const MAX_ARCHIVE_BYTES = 50 * 1024 * 1024;
export const MAX_EXTRACTED_BYTES = 1024 * 1024 * 1024;
export const MAX_ARCHIVE_FILES = 100_000;
export const MAX_ARCHIVE_PATH_BYTES = 1024;

const SAFE_OBJECT_SEGMENT = /^[a-zA-Z0-9_-]{1,128}$/;
const ALLOWED_ENTRY_TYPES = new Set([
  'File',
  'OldFile',
  'Directory',
  'GNUDumpDir',
  'SymbolicLink',
  'Link',
  'ExtendedHeader',
  'OldExtendedHeader',
  'GlobalExtendedHeader',
  'NextFileHasLongPath',
  'NextFileHasLongLinkpath',
]);

export interface ArchiveEntryView {
  path: string;
  type: string;
  size?: number;
  linkpath?: string;
}

export interface ArchiveInspection {
  files: number;
  extractedBytes: number;
}

const APP_ARTIFACT_STORAGE_RETRY_DELAYS_MS = [100, 250] as const;

export class AppArtifactStorageUnavailableError extends Error {
  constructor(cause: unknown) {
    super('App artifact storage is temporarily unavailable', { cause });
    this.name = 'AppArtifactStorageUnavailableError';
  }
}

export async function retryAppArtifactStorage<T>(
  operation: () => Promise<T>,
  sleep: (delayMs: number) => Promise<void> = Bun.sleep,
): Promise<T> {
  for (const delayMs of APP_ARTIFACT_STORAGE_RETRY_DELAYS_MS) {
    try {
      return await operation();
    } catch {
      await sleep(delayMs);
    }
  }
  return operation();
}

function safeObjectSegment(value: string, name: string): string {
  if (!SAFE_OBJECT_SEGMENT.test(value)) throw new Error(`${name} contains invalid characters`);
  return value;
}

export function appArtifactObjectPath(
  accountId: string,
  projectId: string,
  artifactId: string,
): string {
  return [
    safeObjectSegment(accountId, 'accountId'),
    safeObjectSegment(projectId, 'projectId'),
    safeObjectSegment(artifactId, 'artifactId'),
    'source.tar.gz',
  ].join('/');
}

export async function ensureAppArtifactBucket(): Promise<void> {
  const supabase = getSupabase();
  const { data, error } = await supabase.storage.getBucket(APP_ARTIFACT_BUCKET);
  if (data) {
    if (data.public || Number(data.file_size_limit ?? 0) !== MAX_ARCHIVE_BYTES) {
      const { error: updateError } = await supabase.storage.updateBucket(APP_ARTIFACT_BUCKET, {
        public: false,
        fileSizeLimit: MAX_ARCHIVE_BYTES,
      });
      if (updateError) throw updateError;
    }
    return;
  }
  if (error && !/not found/i.test(error.message)) throw error;
  const { error: createError } = await supabase.storage.createBucket(APP_ARTIFACT_BUCKET, {
    public: false,
    fileSizeLimit: MAX_ARCHIVE_BYTES,
    allowedMimeTypes: ['application/gzip', 'application/x-gzip', 'application/x-tar'],
  });
  if (createError && !/already exists/i.test(createError.message)) throw createError;
}

export async function createAppArtifactUploadUrl(
  accountId: string,
  projectId: string,
  artifactId: string,
): Promise<{ uploadUrl: string; objectPath: string; maxBytes: number }> {
  try {
    return await retryAppArtifactStorage(async () => {
      await ensureAppArtifactBucket();
      const objectPath = appArtifactObjectPath(accountId, projectId, artifactId);
      const { data, error } = await getSupabase().storage
        .from(APP_ARTIFACT_BUCKET)
        .createSignedUploadUrl(objectPath, { upsert: false });
      if (error || !data?.signedUrl) {
        throw error ?? new Error('failed to create App artifact upload URL');
      }
      return { uploadUrl: toPublicStorageUrl(data.signedUrl), objectPath, maxBytes: MAX_ARCHIVE_BYTES };
    });
  } catch (error) {
    throw new AppArtifactStorageUnavailableError(error);
  }
}

export async function downloadAppArtifact(
  objectPath: string,
  destination: string,
): Promise<{ sha256: string; sizeBytes: number }> {
  const { data, error } = await getSupabase().storage
    .from(APP_ARTIFACT_BUCKET)
    .download(objectPath);
  if (error || !data) throw error ?? new Error('App artifact object is missing');
  if (data.size > MAX_ARCHIVE_BYTES) {
    throw new Error(`App artifact exceeds ${MAX_ARCHIVE_BYTES} bytes`);
  }
  const bytes = new Uint8Array(await data.arrayBuffer());
  if (bytes.byteLength > MAX_ARCHIVE_BYTES) {
    throw new Error(`App artifact exceeds ${MAX_ARCHIVE_BYTES} bytes`);
  }
  await Bun.write(destination, bytes);
  return {
    sha256: createHash('sha256').update(bytes).digest('hex'),
    sizeBytes: bytes.byteLength,
  };
}

function normalizedArchivePath(input: string, label: string, allowParentSegments = false): string {
  if (!input || Buffer.byteLength(input, 'utf8') > MAX_ARCHIVE_PATH_BYTES) {
    throw new Error(`${label} is empty or exceeds ${MAX_ARCHIVE_PATH_BYTES} bytes`);
  }
  const unix = input.replaceAll('\\', '/');
  if (unix.startsWith('/') || /^[a-zA-Z]:\//.test(unix)) {
    throw new Error(`${label} must be relative`);
  }
  if (!allowParentSegments && unix.split('/').includes('..')) {
    throw new Error(`${label} contains parent traversal`);
  }
  const normalized = posix.normalize(unix).replace(/^\.\//, '');
  if (!normalized || normalized === '.' || (!allowParentSegments && normalized.startsWith('../'))) {
    throw new Error(`${label} is invalid`);
  }
  return normalized;
}

/** Validate one tar header without touching the filesystem. */
export function validateArchiveEntry(entry: ArchiveEntryView): void {
  const rawPath = entry.path.replaceAll('\\', '/').replace(/\/+$/, '');
  if (rawPath === '.') {
    if (entry.type === 'Directory' || entry.type === 'GNUDumpDir') return;
    throw new Error('archive root entry must be a directory');
  }
  const entryPath = normalizedArchivePath(entry.path, 'archive path');
  if (!ALLOWED_ENTRY_TYPES.has(entry.type)) {
    throw new Error(`archive entry ${entryPath} has forbidden type ${entry.type}`);
  }
  if (entry.type === 'SymbolicLink' || entry.type === 'Link') {
    const linkpath = normalizedArchivePath(
      entry.linkpath ?? '',
      'archive link target',
      entry.type === 'SymbolicLink',
    );
    const resolved = entry.type === 'SymbolicLink'
      ? posix.normalize(posix.join(posix.dirname(entryPath), linkpath))
      : posix.normalize(linkpath);
    if (resolved === '..' || resolved.startsWith('../') || resolved.startsWith('/')) {
      throw new Error(`archive link ${entryPath} escapes the build context`);
    }
  }
  if ((entry.size ?? 0) < 0) throw new Error(`archive entry ${entryPath} has a negative size`);
}

export async function inspectAppArchive(archivePath: string): Promise<ArchiveInspection> {
  const archive = await stat(archivePath);
  if (!archive.isFile()) throw new Error('App artifact is not a regular file');
  if (archive.size > MAX_ARCHIVE_BYTES) {
    throw new Error(`App artifact exceeds ${MAX_ARCHIVE_BYTES} bytes`);
  }
  let files = 0;
  let extractedBytes = 0;
  await tar.t({
    file: archivePath,
    strict: true,
    onentry: (entry) => {
      validateArchiveEntry({
        path: entry.path,
        type: entry.type,
        size: entry.size,
        linkpath: entry.linkpath,
      });
      if (entry.type === 'File' || entry.type === 'OldFile') {
        files += 1;
        extractedBytes += entry.size;
        if (files > MAX_ARCHIVE_FILES) {
          throw new Error(`App artifact exceeds ${MAX_ARCHIVE_FILES} files`);
        }
        if (extractedBytes > MAX_EXTRACTED_BYTES) {
          throw new Error(`App artifact exceeds ${MAX_EXTRACTED_BYTES} extracted bytes`);
        }
      }
    },
  });
  return { files, extractedBytes };
}

function isWithin(root: string, candidate: string): boolean {
  const prefix = root.endsWith(sep) ? root : `${root}${sep}`;
  return candidate === root || candidate.startsWith(prefix);
}

export async function extractAppArchive(
  archivePath: string,
  destination: string,
): Promise<ArchiveInspection> {
  const inspection = await inspectAppArchive(archivePath);
  const root = resolve(destination);
  await rm(root, { recursive: true, force: true });
  await mkdir(root, { recursive: true, mode: 0o700 });
  try {
    await tar.x({
      file: archivePath,
      cwd: root,
      strict: true,
      preservePaths: false,
      noChmod: false,
      filter: (entryPath, entry) => {
        const tarEntry = entry as tar.ReadEntry;
        validateArchiveEntry({
          path: entryPath,
          type: tarEntry.type,
          size: tarEntry.size,
          linkpath: tarEntry.linkpath,
        });
        const outputPath = resolve(root, entryPath);
        if (!isWithin(root, outputPath)) throw new Error('archive path escapes the build context');
        return true;
      },
    });
    return inspection;
  } catch (error) {
    await rm(root, { recursive: true, force: true }).catch(() => {});
    throw error;
  }
}

export async function sha256File(path: string): Promise<{ sha256: string; sizeBytes: number }> {
  const hash = createHash('sha256');
  let sizeBytes = 0;
  for await (const chunk of createReadStream(path)) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    sizeBytes += bytes.byteLength;
    if (sizeBytes > MAX_ARCHIVE_BYTES) throw new Error(`App artifact exceeds ${MAX_ARCHIVE_BYTES} bytes`);
    hash.update(bytes);
  }
  return { sha256: hash.digest('hex'), sizeBytes };
}

export async function removeAppArtifact(objectPath: string): Promise<void> {
  const { error } = await getSupabase().storage.from(APP_ARTIFACT_BUCKET).remove([objectPath]);
  if (error && !/not found/i.test(error.message)) throw error;
}

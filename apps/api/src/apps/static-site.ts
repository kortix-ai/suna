/**
 * Static App hosting: a `static` App is files, so it gets no runtime.
 *
 * A static deployment used to build a Platinum template (alpine + the files +
 * a 62 MB supervisor) and boot a VM per version, so every deploy cost a
 * provider template against a per-org cap, a cold start after the idle
 * timeout, and compute while it ran. Now the deployment worker publishes the
 * files and the API serves them after the App's access gate, the same gate a
 * runtime App sits behind:
 *
 *   - Publish: every file is stored once per account under its SHA-256 in the
 *     private `app-sites` bucket (`<account_id>/<sha256>`), and the deployment
 *     records its manifest in `app_site_files` (path → blob, size, type).
 *     Unchanged files across deploys are not uploaded again.
 *   - Serve: the manifest (immutable per deployment) and small blobs are cached
 *     in process. Hashed assets are cacheable for a year; HTML revalidates.
 *     Content is `private` to caches unless the App is public.
 *   - Activate and roll back: flip `apps.active_deployment_id`. Nothing boots.
 *
 * Blobs are freed by `reclaimAppSiteBlobs` once no live manifest names them.
 */

import { appSiteBlobs, appSiteFiles } from '@kortix/db';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { createHash } from 'node:crypto';
import { brotliCompressSync, constants as zlib, gzipSync } from 'node:zlib';
import { lstat, readdir, readFile } from 'node:fs/promises';
import { join, posix } from 'node:path';
import { config } from '../config';
import { db } from '../shared/db';
import { mapWithConcurrency } from '../shared/map-with-concurrency';
import { getSupabase } from '../shared/supabase';
import { retryAppArtifactStorage } from './artifacts';
import { appPublicResponseHeaders } from './public-proxy-headers';

export const APP_SITE_BUCKET = 'app-sites';
export const MAX_SITE_FILE_BYTES = 50 * 1024 * 1024;
export const MAX_SITE_FILES = 20_000;
const UPLOAD_CONCURRENCY = 8;
const ROW_BATCH = 1_000;

export function staticHostingEnabled(): boolean {
  return config.KORTIX_APPS_STATIC_HOSTING;
}

export interface SiteFile {
  path: string;
  sha256: string;
  sizeBytes: number;
  contentType: string;
}

/** Where blob bytes live. Swappable for tests. */
export interface SiteStorage {
  put(key: string, bytes: Uint8Array, contentType: string): Promise<void>;
  get(key: string): Promise<Uint8Array | null>;
  remove(keys: string[]): Promise<void>;
}

export const blobKey = (accountId: string, sha256: string) => `${accountId}/${sha256}`;

let bucketReady: Promise<void> | null = null;
function ensureSiteBucket(): Promise<void> {
  bucketReady ??= (async () => {
    const storage = getSupabase().storage;
    const { data, error } = await storage.getBucket(APP_SITE_BUCKET);
    if (data) return;
    if (error && !/not found/i.test(error.message)) throw error;
    const { error: createError } = await storage.createBucket(APP_SITE_BUCKET, {
      public: false,
      fileSizeLimit: MAX_SITE_FILE_BYTES,
    });
    if (createError && !/already exists/i.test(createError.message)) throw createError;
  })().catch((error) => {
    bucketReady = null;
    throw error;
  });
  return bucketReady;
}

export const supabaseSiteStorage: SiteStorage = {
  async put(key, bytes, contentType) {
    await ensureSiteBucket();
    await retryAppArtifactStorage(async () => {
      const { error } = await getSupabase()
        .storage.from(APP_SITE_BUCKET)
        .upload(key, bytes, { contentType, upsert: true, cacheControl: '31536000' });
      if (error) throw error;
    });
  },
  async get(key) {
    const { data, error } = await getSupabase().storage.from(APP_SITE_BUCKET).download(key);
    if (error || !data) return null;
    return new Uint8Array(await data.arrayBuffer());
  },
  async remove(keys) {
    if (keys.length === 0) return;
    const { error } = await getSupabase().storage.from(APP_SITE_BUCKET).remove(keys);
    if (error) throw error;
  },
};

// ── Publish ──────────────────────────────────────────────────────────────────

/** Every regular file under `root`, as POSIX paths relative to it. Symlinks are skipped. */
async function listFiles(root: string, dir = ''): Promise<string[]> {
  const out: string[] = [];
  for (const entry of await readdir(join(root, dir), { withFileTypes: true })) {
    const relativePath = dir ? `${dir}/${entry.name}` : entry.name;
    if (entry.isDirectory()) out.push(...(await listFiles(root, relativePath)));
    else if (entry.isFile()) out.push(relativePath);
    if (out.length > MAX_SITE_FILES) throw new Error(`A static App may hold at most ${MAX_SITE_FILES} files`);
  }
  return out;
}

export function siteContentType(path: string): string {
  const type = Bun.file(path).type || 'application/octet-stream';
  // Bun reports text types without a charset; browsers then guess.
  return type.startsWith('text/') && !type.includes('charset') ? `${type}; charset=utf-8` : type;
}

export interface PublishResult {
  files: number;
  bytes: number;
  uploadedBlobs: number;
  reusedBlobs: number;
}

/**
 * Stores the files under `root` for one deployment. Idempotent: a retried
 * publish re-uploads nothing it already stored and re-inserts no row.
 */
export async function publishStaticSite(input: {
  deploymentId: string;
  accountId: string;
  root: string;
  storage?: SiteStorage;
}): Promise<PublishResult> {
  const storage = input.storage ?? supabaseSiteStorage;
  const rootStat = await lstat(input.root).catch(() => null);
  if (!rootStat?.isDirectory()) throw new Error('The static root is not a directory in the artifact');
  const paths = await listFiles(input.root);
  if (paths.length === 0) throw new Error('The static root holds no files');

  const files = await mapWithConcurrency(paths, UPLOAD_CONCURRENCY, async (path) => {
    const bytes = new Uint8Array(await readFile(join(input.root, path)));
    if (bytes.byteLength > MAX_SITE_FILE_BYTES) {
      throw new Error(`${path} exceeds ${MAX_SITE_FILE_BYTES} bytes`);
    }
    return {
      path,
      sha256: createHash('sha256').update(bytes).digest('hex'),
      sizeBytes: bytes.byteLength,
      contentType: siteContentType(path),
    } satisfies SiteFile;
  });

  // References first, under the account's blob lock: once these rows commit,
  // `reclaimAppSiteBlobs` can no longer delete a blob this deployment names,
  // so a blob found here stays stored. A blob not found is uploaded below.
  const unique = new Map(files.map((file) => [file.sha256, file]));
  const stored = await db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`app-site-blobs:${input.accountId}`}))`);
    for (let i = 0; i < files.length; i += ROW_BATCH) {
      await tx
        .insert(appSiteFiles)
        .values(files.slice(i, i + ROW_BATCH).map((file) => ({
          deploymentId: input.deploymentId,
          accountId: input.accountId,
          ...file,
        })))
        .onConflictDoNothing();
    }
    const found = new Set<string>();
    const shas = [...unique.keys()];
    for (let i = 0; i < shas.length; i += ROW_BATCH) {
      const rows = await tx
        .select({ sha256: appSiteBlobs.sha256 })
        .from(appSiteBlobs)
        .where(and(eq(appSiteBlobs.accountId, input.accountId), inArray(appSiteBlobs.sha256, shas.slice(i, i + ROW_BATCH))));
      for (const row of rows) found.add(row.sha256);
    }
    return found;
  });
  const missing = [...unique.values()].filter((file) => !stored.has(file.sha256));
  await mapWithConcurrency(missing, UPLOAD_CONCURRENCY, async (file) => {
    const bytes = new Uint8Array(await readFile(join(input.root, file.path)));
    await storage.put(blobKey(input.accountId, file.sha256), bytes, file.contentType);
    await db
      .insert(appSiteBlobs)
      .values({ accountId: input.accountId, sha256: file.sha256, sizeBytes: file.sizeBytes })
      .onConflictDoNothing();
  });
  return {
    files: files.length,
    bytes: files.reduce((sum, file) => sum + file.sizeBytes, 0),
    uploadedBlobs: missing.length,
    reusedBlobs: unique.size - missing.length,
  };
}

// ── Serve ────────────────────────────────────────────────────────────────────

/**
 * Which file a request path names. Order: the exact file, `<path>/index.html`,
 * `<path>.html`; then the SPA shell for a page navigation; then `404.html`
 * with status 404. Null: nothing to serve.
 */
export function resolveSitePath(
  pathname: string,
  has: (path: string) => boolean,
  options: { spa: boolean; navigation: boolean },
): { path: string; status: 200 | 404 } | null {
  let decoded: string;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return null;
  }
  const trimmed = decoded.replace(/^\/+/, '');
  if (trimmed.split('/').some((segment) => segment === '..') || trimmed.includes('\0')) return null;
  const path = posix.normalize(trimmed || '.').replace(/^\.$/, '');
  const candidates = !path || decoded.endsWith('/')
    ? [`${path ? `${path.replace(/\/$/, '')}/` : ''}index.html`]
    : [path, `${path}/index.html`, `${path}.html`];
  for (const candidate of candidates) if (has(candidate)) return { path: candidate, status: 200 };
  if (options.spa && options.navigation && has('index.html')) return { path: 'index.html', status: 200 };
  if (has('404.html')) return { path: '404.html', status: 404 };
  return null;
}

/** A page navigation (gets the SPA shell), as opposed to a missing asset (gets 404). */
export function isNavigation(request: Request, pathname: string): boolean {
  const last = pathname.split('/').pop() ?? '';
  return !last.includes('.') || (request.headers.get('accept') ?? '').includes('text/html');
}

// A content hash in the file name: 8+ characters mixing upper case, lower case
// and digits (Vite, esbuild, webpack), or Next.js's immutable static output.
const HASHED_NAME = /[.-](?=[A-Za-z0-9_]*[0-9])(?=[A-Za-z0-9_]*[A-Z])(?=[A-Za-z0-9_]*[a-z])[A-Za-z0-9_]{8,}\.[a-z0-9]+$/;

export function siteCacheControl(path: string, publicApp: boolean): string {
  const scope = publicApp ? 'public' : 'private';
  if (path.endsWith('.html')) return `${scope}, no-cache`;
  if (path.startsWith('_next/static/') || HASHED_NAME.test(path)) {
    return `${scope}, max-age=31536000, immutable`;
  }
  return `${scope}, max-age=0, must-revalidate`;
}

/** One `bytes=a-b` range, or null for none / one this server does not honour. */
export function parseRange(header: string | null, size: number): { start: number; end: number } | 'invalid' | null {
  if (!header) return null;
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!match || (!match[1] && !match[2])) return null;
  let start: number;
  let end: number;
  if (!match[1]) {
    start = Math.max(0, size - Number(match[2]));
    end = size - 1;
  } else {
    start = Number(match[1]);
    end = match[2] ? Math.min(Number(match[2]), size - 1) : size - 1;
  }
  return start > end || start >= size ? 'invalid' : { start, end };
}

// replica-local: a published manifest never changes, so each replica's copy is
// exact; a replica that has not cached one reads it from the database.
const manifests = new Map<string, Map<string, SiteFile>>();
const MANIFEST_CACHE = 500;

export async function loadSiteManifest(deploymentId: string): Promise<Map<string, SiteFile>> {
  const hit = manifests.get(deploymentId);
  if (hit) return hit;
  const rows = await db
    .select({
      path: appSiteFiles.path,
      sha256: appSiteFiles.sha256,
      sizeBytes: appSiteFiles.sizeBytes,
      contentType: appSiteFiles.contentType,
    })
    .from(appSiteFiles)
    .where(eq(appSiteFiles.deploymentId, deploymentId));
  const manifest = new Map(rows.map((row) => [row.path, row]));
  if (manifest.size > 0) {
    if (manifests.size >= MANIFEST_CACHE) manifests.delete(manifests.keys().next().value!);
    manifests.set(deploymentId, manifest);
  }
  return manifest;
}

// replica-local: blobs are content-addressed (the key is the SHA-256), so a
// cached copy can never disagree with storage; replicas only differ in hits.
const blobs = new Map<string, Uint8Array>();
let blobBytes = 0;
const BLOB_CACHE_BYTES = 128 * 1024 * 1024;
const BLOB_CACHE_ENTRY_BYTES = 4 * 1024 * 1024;

async function readBlob(storage: SiteStorage, key: string): Promise<Uint8Array | null> {
  const hit = blobs.get(key);
  if (hit) {
    blobs.delete(key);
    blobs.set(key, hit);
    return hit;
  }
  const bytes = await storage.get(key);
  if (bytes && bytes.byteLength <= BLOB_CACHE_ENTRY_BYTES) {
    while (blobBytes + bytes.byteLength > BLOB_CACHE_BYTES && blobs.size > 0) {
      const [oldest, value] = blobs.entries().next().value!;
      blobs.delete(oldest);
      blobBytes -= value.byteLength;
    }
    blobs.set(key, bytes);
    blobBytes += bytes.byteLength;
  }
  return bytes;
}

export function resetStaticSiteCaches(): void {
  manifests.clear();
  blobs.clear();
  blobBytes = 0;
  encoded.clear();
}

const COMPRESSIBLE = /^(text\/|application\/(javascript|json|xml|wasm|manifest\+json)|image\/svg\+xml)/;
const MIN_COMPRESS_BYTES = 1024;
// replica-local: compressed bytes of a content-addressed blob; never stale.
const encoded = new Map<string, Uint8Array>();
const ENCODED_CACHE_ENTRIES = 2_000;

/** The best encoding the client accepts for this file, or null for identity. */
export function chooseEncoding(acceptEncoding: string | null, contentType: string, size: number): 'br' | 'gzip' | null {
  if (size < MIN_COMPRESS_BYTES || !COMPRESSIBLE.test(contentType)) return null;
  const accepted = (acceptEncoding ?? '').toLowerCase();
  if (/\bbr\b/.test(accepted)) return 'br';
  if (/\bgzip\b/.test(accepted)) return 'gzip';
  return null;
}

function encode(sha256: string, encoding: 'br' | 'gzip', bytes: Uint8Array): Uint8Array {
  const key = `${encoding}:${sha256}`;
  const hit = encoded.get(key);
  if (hit) return hit;
  const out = encoding === 'br'
    ? new Uint8Array(brotliCompressSync(bytes, { params: { [zlib.BROTLI_PARAM_QUALITY]: 5 } }))
    : new Uint8Array(gzipSync(bytes, { level: 6 }));
  if (bytes.byteLength <= BLOB_CACHE_ENTRY_BYTES) {
    if (encoded.size >= ENCODED_CACHE_ENTRIES) encoded.delete(encoded.keys().next().value!);
    encoded.set(key, out);
  }
  return out;
}

/** Answers one request for a static deployment. The caller already passed the access gate. */
export async function serveStaticDeployment(input: {
  request: Request;
  url: URL;
  accountId: string;
  deploymentId: string;
  spa: boolean;
  publicApp: boolean;
  storage?: SiteStorage;
}): Promise<Response> {
  const { request, url } = input;
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    return new Response('Method not allowed', { status: 405, headers: { allow: 'GET, HEAD' } });
  }
  const manifest = await loadSiteManifest(input.deploymentId);
  const resolved = resolveSitePath(url.pathname, (path) => manifest.has(path), {
    spa: input.spa,
    navigation: isNavigation(request, url.pathname),
  });
  if (!resolved) {
    return new Response('Not found', { status: 404, headers: { 'content-type': 'text/plain; charset=utf-8' } });
  }
  const file = manifest.get(resolved.path)!;
  // Weak: the identity, gzip and Brotli bodies share it (RFC 9110 §8.8.1).
  const etag = `W/"${file.sha256}"`;
  const headers = appPublicResponseHeaders(new Headers({
    'content-type': file.contentType,
    'cache-control': siteCacheControl(resolved.path, input.publicApp),
    etag,
    'accept-ranges': 'bytes',
    'x-content-type-options': 'nosniff',
  }));
  const ifNoneMatch = (request.headers.get('if-none-match') ?? '').split(/\s*,\s*/).map((tag) => tag.replace(/^W\//, ''));
  if (resolved.status === 200 && ifNoneMatch.includes(`"${file.sha256}"`)) {
    return new Response(null, { status: 304, headers });
  }
  const bytes = await readBlob(input.storage ?? supabaseSiteStorage, blobKey(input.accountId, file.sha256));
  if (!bytes) {
    return new Response('This file is temporarily unavailable', { status: 503, headers: { 'retry-after': '5' } });
  }
  const range = resolved.status === 200 ? parseRange(request.headers.get('range'), bytes.byteLength) : null;
  if (range === 'invalid') {
    headers.set('content-range', `bytes */${bytes.byteLength}`);
    return new Response(null, { status: 416, headers });
  }
  // A range is served from the identity bytes; anything else may be compressed.
  const encoding = range ? null : chooseEncoding(request.headers.get('accept-encoding'), file.contentType, bytes.byteLength);
  headers.set('vary', 'accept-encoding');
  if (encoding) headers.set('content-encoding', encoding);
  const body = range ? bytes.subarray(range.start, range.end + 1) : encoding ? encode(file.sha256, encoding, bytes) : bytes;
  if (range) headers.set('content-range', `bytes ${range.start}-${range.end}/${bytes.byteLength}`);
  headers.set('content-length', String(body.byteLength));
  return new Response(request.method === 'HEAD' ? null : (body as Uint8Array<ArrayBuffer>), {
    status: range ? 206 : resolved.status,
    headers,
  });
}

// ── Reclaim ──────────────────────────────────────────────────────────────────

/** Blobs younger than this are never reclaimed: a publish may be about to name them. */
const BLOB_GRACE = '1 hour';
const BLOB_RECLAIM_BATCH = 500;

/**
 * Deletes stored blobs that no manifest names any more. Per account, under the
 * same lock a publish takes before it decides which blobs exist: the rows go
 * and the objects go in one transaction, so a failed object delete keeps the
 * rows, and a publish never reuses a blob that is being deleted.
 */
export async function reclaimAppSiteBlobs(storage: SiteStorage = supabaseSiteStorage): Promise<{ reclaimed: number }> {
  const unreferenced = sql`${appSiteBlobs.createdAt} < now() - ${BLOB_GRACE}::interval
    and not exists (select 1 from ${appSiteFiles}
      where ${appSiteFiles.accountId} = ${appSiteBlobs.accountId}
        and ${appSiteFiles.sha256} = ${appSiteBlobs.sha256})`;
  const candidates = await db
    .select({ accountId: appSiteBlobs.accountId, sha256: appSiteBlobs.sha256 })
    .from(appSiteBlobs)
    .where(unreferenced)
    .limit(BLOB_RECLAIM_BATCH);
  const byAccount = new Map<string, string[]>();
  for (const blob of candidates) byAccount.set(blob.accountId, [...(byAccount.get(blob.accountId) ?? []), blob.sha256]);
  let reclaimed = 0;
  for (const [accountId, shas] of byAccount) {
    reclaimed += await db.transaction(async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`app-site-blobs:${accountId}`}))`);
      const deleted = await tx
        .delete(appSiteBlobs)
        .where(and(eq(appSiteBlobs.accountId, accountId), inArray(appSiteBlobs.sha256, shas), unreferenced))
        .returning({ sha256: appSiteBlobs.sha256 });
      await storage.remove(deleted.map((blob) => blobKey(accountId, blob.sha256)));
      return deleted.length;
    });
  }
  return { reclaimed };
}

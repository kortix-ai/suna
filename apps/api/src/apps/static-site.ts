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
 *   - Serve: the manifest (immutable per deployment), small blobs and their
 *     compressed bodies are cached in process, each cache bounded by bytes.
 *     A body over 4 MiB is served uncompressed. Hashed assets are cacheable
 *     for a year; HTML revalidates. Content is `private` to caches unless the
 *     App is public.
 *   - Activate and roll back: flip `apps.active_deployment_id`. Nothing boots.
 *
 * Blobs are freed by `reclaimAppSiteBlobs` once no live manifest names them.
 */

import { appSiteBlobs, appSiteFiles } from '@kortix/db';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { createHash } from 'node:crypto';
import { brotliCompress, constants as zlib, gzip } from 'node:zlib';
import { lstat, readdir, readFile, realpath } from 'node:fs/promises';
import { isAbsolute, join, posix, relative, resolve } from 'node:path';
import { promisify } from 'node:util';
import { config } from '../config';
import { db } from '../shared/db';
import { mapWithConcurrency } from '../shared/map-with-concurrency';
import { getSupabase } from '../shared/supabase';
import { retryAppArtifactStorage } from './artifacts';
import { APP_EDGE_CACHEABLE_HEADER, appPublicResponseHeaders } from './public-proxy-headers';

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
 * `root` inside `sourceDir`, as a real path. Refused when it leaves `sourceDir`
 * or any of its components is a symlink: this process reads the files on the
 * API host and may publish them on a public URL.
 */
async function containedRoot(sourceDir: string, root: string): Promise<string> {
  const base = await realpath(sourceDir);
  const lexical = resolve(base, root);
  const fromBase = relative(base, lexical);
  const real = await realpath(lexical).catch(() => null);
  if (fromBase.startsWith('..') || isAbsolute(fromBase) || (real !== null && real !== lexical)) {
    throw new Error('The static root resolves outside the artifact');
  }
  const rootStat = real === null ? null : await lstat(real);
  if (!rootStat?.isDirectory()) throw new Error('The static root is not a directory in the artifact');
  return real!;
}

/**
 * Stores the files under `sourceDir`/`root` (default `.`) for one deployment.
 * Idempotent: a retried publish re-uploads nothing it already stored and
 * re-inserts no row.
 */
export async function publishStaticSite(input: {
  deploymentId: string;
  accountId: string;
  sourceDir: string;
  root?: string;
  storage?: SiteStorage;
}): Promise<PublishResult> {
  const storage = input.storage ?? supabaseSiteStorage;
  const root = await containedRoot(input.sourceDir, input.root ?? '.');
  // `listFiles` skips symlinks, so no file below the real root leaves it.
  const paths = await listFiles(root);
  if (paths.length === 0) throw new Error('The static root holds no files');

  const files = await mapWithConcurrency(paths, UPLOAD_CONCURRENCY, async (path) => {
    const bytes = new Uint8Array(await readFile(join(root, path)));
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
    const bytes = new Uint8Array(await readFile(join(root, file.path)));
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

// Build output with a content hash in the file name: Next.js's _next/static/,
// or a file under assets/ (Vite) or static/js|css|media/ (Create React App)
// whose name ends in a segment of 8+ characters with a digit or an upper-case
// letter before the extension (or ".chunk.js"). Plain words
// ("logo-original.png") and files outside those directories revalidate: a
// mutable file marked immutable stays stale in browsers for a year.
const HASHED_BUILD_OUTPUT = /(?:^|\/)(?:assets|static\/(?:js|css|media))\/(?:[^/]+\/)*[^/]*[.-](?=[A-Za-z0-9_-]*[0-9A-Z])[A-Za-z0-9_-]{8,}(?:\.chunk)?\.[a-z0-9]+$/;

export function siteCacheControl(path: string, publicApp: boolean): string {
  const scope = publicApp ? 'public' : 'private';
  if (path.endsWith('.html')) return `${scope}, no-cache`;
  if (path.startsWith('_next/static/') || HASHED_BUILD_OUTPUT.test(path)) {
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

/** A replica-local LRU bounded by total bytes. A value over the budget is not kept. */
export class ByteLru<V> {
  private readonly entries = new Map<string, { value: V; size: number }>();
  bytes = 0;
  constructor(readonly budget: number) {}

  get(key: string): V | undefined {
    const hit = this.entries.get(key);
    if (!hit) return undefined;
    this.entries.delete(key);
    this.entries.set(key, hit);
    return hit.value;
  }

  set(key: string, value: V, size: number): void {
    if (size > this.budget) return;
    const old = this.entries.get(key);
    if (old) {
      this.entries.delete(key);
      this.bytes -= old.size;
    }
    while (this.bytes + size > this.budget) {
      const [oldest, entry] = this.entries.entries().next().value!;
      this.entries.delete(oldest);
      this.bytes -= entry.size;
    }
    this.entries.set(key, { value, size });
    this.bytes += size;
  }

  clear(): void {
    this.entries.clear();
    this.bytes = 0;
  }
}

const MIB = 1024 * 1024;
/** Bodies above this are never cached or compressed in process. */
export const MAX_COMPRESS_BYTES = 4 * MIB;

// replica-local, never stale: a published manifest never changes, and blobs
// and their compressed bodies are content-addressed (the key is the SHA-256).
export const siteCaches = {
  manifests: new ByteLru<Map<string, SiteFile>>(64 * MIB),
  blobs: new ByteLru<Uint8Array>(128 * MIB),
  encoded: new ByteLru<Uint8Array>(64 * MIB),
};

/** Estimated heap bytes of one manifest: UTF-16 strings plus per-row overhead. */
function manifestBytes(rows: SiteFile[]): number {
  return rows.reduce((sum, row) => sum + 2 * (row.path.length + row.contentType.length + row.sha256.length) + 200, 0);
}

export async function loadSiteManifest(deploymentId: string): Promise<Map<string, SiteFile>> {
  const hit = siteCaches.manifests.get(deploymentId);
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
  if (manifest.size > 0) siteCaches.manifests.set(deploymentId, manifest, manifestBytes(rows));
  return manifest;
}

// replica-local: concurrent requests for one blob on this replica share one
// storage read; another replica reads its own copy, which is identical.
const blobReads = new Map<string, Promise<Uint8Array | null>>();

function readBlob(storage: SiteStorage, key: string): Promise<Uint8Array | null> {
  const hit = siteCaches.blobs.get(key);
  if (hit) return Promise.resolve(hit);
  let read = blobReads.get(key);
  if (!read) {
    read = storage.get(key).then((bytes) => {
      if (bytes && bytes.byteLength <= MAX_COMPRESS_BYTES) siteCaches.blobs.set(key, bytes, bytes.byteLength);
      return bytes;
    }).finally(() => blobReads.delete(key));
    blobReads.set(key, read);
  }
  return read;
}

export function resetStaticSiteCaches(): void {
  for (const cache of Object.values(siteCaches)) cache.clear();
}

const COMPRESSIBLE = /^(text\/|application\/(javascript|json|xml|wasm|manifest\+json)|image\/svg\+xml)/;
const MIN_COMPRESS_BYTES = 1024;
const brotliAsync = promisify(brotliCompress);
const gzipAsync = promisify(gzip);

/** The best encoding the client accepts for this file, or null for identity. */
export function chooseEncoding(acceptEncoding: string | null, contentType: string, size: number): 'br' | 'gzip' | null {
  if (size < MIN_COMPRESS_BYTES || size > MAX_COMPRESS_BYTES || !COMPRESSIBLE.test(contentType)) return null;
  const accepted = (acceptEncoding ?? '').toLowerCase();
  if (/\bbr\b/.test(accepted)) return 'br';
  if (/\bgzip\b/.test(accepted)) return 'gzip';
  return null;
}

/** The compressed body, off the event loop (zlib thread pool), cached by content. */
export async function encodeSiteBody(sha256: string, encoding: 'br' | 'gzip', bytes: Uint8Array): Promise<Uint8Array> {
  const key = `${encoding}:${sha256}`;
  const hit = siteCaches.encoded.get(key);
  if (hit) return hit;
  const out = new Uint8Array(encoding === 'br'
    ? await brotliAsync(bytes, { params: { [zlib.BROTLI_PARAM_QUALITY]: 5 } })
    : await gzipAsync(bytes, { level: 6 }));
  siteCaches.encoded.set(key, out, out.byteLength);
  return out;
}

/** A plain-text answer that, like every App response, no Cloudflare cache keeps. */
function plain(status: number, body: string, extra: Record<string, string> = {}): Response {
  return new Response(body, {
    status,
    headers: appPublicResponseHeaders(new Headers({ 'content-type': 'text/plain; charset=utf-8', ...extra })),
  });
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
    return plain(405, 'Method not allowed', { allow: 'GET, HEAD' });
  }
  const manifest = await loadSiteManifest(input.deploymentId);
  const resolved = resolveSitePath(url.pathname, (path) => manifest.has(path), {
    spa: input.spa,
    navigation: isNavigation(request, url.pathname),
  });
  if (!resolved) {
    return plain(404, 'Not found');
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
    // On the 304 too: a cache must not reuse one encoding for another client.
    vary: 'accept-encoding',
  }));
  if (input.publicApp) headers.set(APP_EDGE_CACHEABLE_HEADER, 'public');
  const ifNoneMatch = (request.headers.get('if-none-match') ?? '').split(/\s*,\s*/).map((tag) => tag.replace(/^W\//, ''));
  if (resolved.status === 200 && ifNoneMatch.includes(`"${file.sha256}"`)) {
    return new Response(null, { status: 304, headers });
  }
  const bytes = await readBlob(input.storage ?? supabaseSiteStorage, blobKey(input.accountId, file.sha256));
  if (!bytes) {
    return plain(503, 'This file is temporarily unavailable', { 'retry-after': '5' });
  }
  const range = resolved.status === 200 ? parseRange(request.headers.get('range'), bytes.byteLength) : null;
  if (range === 'invalid') {
    headers.set('content-range', `bytes */${bytes.byteLength}`);
    return new Response(null, { status: 416, headers });
  }
  // A range is served from the identity bytes; anything else may be compressed.
  const encoding = range ? null : chooseEncoding(request.headers.get('accept-encoding'), file.contentType, bytes.byteLength);
  if (encoding) headers.set('content-encoding', encoding);
  const body = range ? bytes.subarray(range.start, range.end + 1) : encoding ? await encodeSiteBody(file.sha256, encoding, bytes) : bytes;
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

/**
 * Serve one config archive (docs/specs/config-releases.md, "Download path").
 *
 * 1. The tree ID must name a tree object in the project's mirror; a warm miss
 *    gets one forced fetch.
 * 2. Still not in the mirror (e.g. a repository replacement moved the origin
 *    to unrelated history, CFG-7): the store is tried directly by its
 *    project-scoped key. A hit is served exactly like step 3 below. On a miss,
 *    the tree may be the composed release tree of the `commit` the path names
 *    (config dir plus root skills, see `composeReleaseTree`): it is rebuilt
 *    from that commit and served like step 4. Anything else is 404.
 * 3. In the mirror: the store presigns a download URL. Public host: `302` to
 *    it. Loopback or private host: stream the stored bytes. A cloud sandbox
 *    reaches neither local Supabase at 127.0.0.1 nor a self-host `supabase-kong`.
 * 4. In the mirror, but store failure or missing object: build from the
 *    mirror, stream it, and `putIfAbsent` it.
 *
 * The decision is made on the SIGNED URL the store returns, so it holds for
 * every endpoint the one object store can point at (AWS S3, Supabase Storage's
 * S3 protocol, MinIO) without this module knowing which.
 */

import { config } from '../config';
import { runGitCapture } from '../projects/git/mirror';
import type { GitBackedProject } from '../projects/git/types';
import { rewriteStorageOrigin } from '../shared/storage-url';
import { classifyIpHost, sanitizeUrlForLog } from '../snapshots/providers/upload-url-guard';
import {
  buildConfigArchive,
  ConfigArchiveTooLargeError,
  isTreeObject,
  MAX_CONFIG_ARCHIVE_BYTES,
  readComposedRelease,
  resolveReleaseTreeSource,
  storeConfigArchive,
} from './builder';
import {
  CONFIG_ARCHIVE_URL_TTL_SECONDS,
  configArchiveKey,
  getConfigArchiveStore,
  type ConfigArchiveStore,
} from './store';

/** Single-label names (`supabase-kong`) and these suffixes never resolve from a cloud sandbox. */
const INTERNAL_SUFFIXES = ['.localhost', '.local', '.localdomain', '.internal', '.svc', '.cluster.local', '.lan', '.home.arpa'];

/**
 * Is a storage origin reachable from a cloud sandbox? IP literals are
 * classified with `classifyIpHost`. A hostname is public when it has a dot
 * and no internal suffix. An unparseable URL is not public.
 */
export function storageOriginIsPublic(origin: string): boolean {
  let host: string;
  try {
    host = new URL(origin).hostname.toLowerCase();
  } catch {
    return false;
  }
  if (!host || host === 'localhost') return false;
  const ipClass = classifyIpHost(host);
  if (ipClass !== 'not-ip') return ipClass === 'public';
  if (!host.includes('.')) return false;
  return !INTERNAL_SUFFIXES.some((suffix) => host.endsWith(suffix));
}

/**
 * Where a sandbox is sent for one signed URL, or null to stream the bytes
 * through the API. `KORTIX_CONFIG_ARCHIVE_PUBLIC_URL` replaces the signed
 * URL's origin — the store already signed FOR that host (it is the object
 * store's public endpoint), so the swap only rewrites the text.
 */
export function publicDownloadTarget(signedUrl: string, publicOverride?: string | null): string | null {
  let origin: string;
  try {
    origin = new URL(signedUrl).origin;
  } catch {
    return null;
  }
  const target = rewriteStorageOrigin(signedUrl, origin, publicOverride?.trim() || undefined);
  return storageOriginIsPublic(target) ? target : null;
}

export interface ServeConfigArchiveDeps {
  store?: ConfigArchiveStore;
  publicOverride?: string | null;
  fetch?: (input: string) => Promise<Response>;
}

function gzipResponse(bytes: Uint8Array, treeId: string, source: 'store' | 'mirror'): Response {
  return new Response(bytes as unknown as BodyInit, {
    status: 200,
    headers: {
      'Content-Type': 'application/gzip',
      'Content-Length': String(bytes.byteLength),
      'Cache-Control': 'private, max-age=31536000, immutable',
      ETag: `"${treeId}"`,
      'X-Kortix-Config-Archive-Source': source,
    },
  });
}

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

/** Stream the stored object through the API, for a host no sandbox can reach. */
async function readSigned(
  url: string,
  key: string,
  fetchImpl: (input: string) => Promise<Response>,
): Promise<Uint8Array> {
  const response = await fetchImpl(url);
  if (!response.ok) {
    await response.body?.cancel().catch(() => {});
    throw new Error(`store download ${sanitizeUrlForLog(url)} answered ${response.status}`);
  }
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.byteLength === 0 || bytes.byteLength > MAX_CONFIG_ARCHIVE_BYTES) {
    throw new Error(`store object ${key} has ${bytes.byteLength} bytes`);
  }
  return bytes;
}

/**
 * Serve `key` straight from the store: `302` to a public signed URL, or
 * stream the bytes for a loopback/private one. Returns `null` when the store
 * has no object at `key` — the caller decides what that means (404, or fall
 * back to a mirror build). Throws on a store or download failure, same as
 * `store.downloadUrl` / `readSigned` — the caller decides how to log it.
 */
async function tryServeFromStore(
  store: ConfigArchiveStore,
  key: string,
  treeId: string,
  publicOverride: string | null | undefined,
  fetchImpl: (input: string) => Promise<Response>,
): Promise<Response | null> {
  const signed = await store.downloadUrl(key, CONFIG_ARCHIVE_URL_TTL_SECONDS);
  if (!signed) return null;
  const redirect = publicDownloadTarget(signed, publicOverride);
  if (redirect) {
    return new Response(null, {
      status: 302,
      headers: { Location: redirect, 'Cache-Control': 'no-store' },
    });
  }
  const stored = await readSigned(signed, key, fetchImpl);
  return gzipResponse(stored, treeId, 'store');
}

/**
 * Answer one archive request. `mirror()` returns the warm mirror path;
 * `forcedMirror()` fetches first. A tree the warm mirror lacks gets one forced
 * fetch: another API replica may have built the descriptor from a newer tip.
 *
 * A repository replacement (CFG-7, `docs/specs/config-releases.md` §"Download
 * path") can make the tree genuinely UNREACHABLE from the mirror forever: the
 * project's origin now serves a second repository with unrelated history, so
 * no fetch of that origin ever re-creates the old tree object. The mirror
 * check alone would 404 a legitimate former archive whenever the request
 * lands on a replica whose local mirror clone post-dates the replacement
 * (staging/prod: `apps/api/src/projects/git/mirror.ts` keeps the bare mirror
 * on per-task ephemeral disk, not shared across ECS tasks). The store key is
 * scoped to this project (`configArchiveKey`), so an object found there is
 * proof enough on its own — the caller already passed the project's
 * repository-access / `PROJECT_FILE_READ` check before reaching this route.
 */
export async function serveConfigArchive(
  project: GitBackedProject,
  treeId: string,
  mirror: () => Promise<string>,
  forcedMirror: () => Promise<string>,
  deps: ServeConfigArchiveDeps = {},
  /** The commit a composed release tree was built from (the path's `?commit=`). */
  composedFrom?: string | null,
): Promise<Response> {
  const store = deps.store ?? getConfigArchiveStore();
  const key = configArchiveKey(project.projectId, treeId);
  const publicOverride =
    deps.publicOverride === undefined ? config.KORTIX_CONFIG_ARCHIVE_PUBLIC_URL : deps.publicOverride;
  const fetchImpl = deps.fetch ?? ((input: string) => fetch(input));

  let repo = await mirror();
  let inMirror = await isTreeObject(repo, treeId);
  if (!inMirror) {
    repo = await forcedMirror();
    inMirror = await isTreeObject(repo, treeId);
  }

  // Builds the archive when the store cannot serve it. A composed tree exists
  // only in a scratch repository, so it is rebuilt from its commit.
  let build: () => Promise<Buffer> = () => buildConfigArchive(repo, treeId);
  if (!inMirror) {
    try {
      const served = await tryServeFromStore(store, key, treeId, publicOverride, fetchImpl);
      if (served) return served;
    } catch (error) {
      console.warn(`[config-releases] store read ${key} failed for a mirror-less tree: ${(error as Error).message}`);
    }
    const composed = await composedArchiveBuilder(repo, project, treeId, composedFrom);
    if (!composed) return json(404, { error: 'Not found' });
    build = composed;
  } else {
    try {
      const served = await tryServeFromStore(store, key, treeId, publicOverride, fetchImpl);
      if (served) return served;
    } catch (error) {
      console.warn(`[config-releases] store read ${key} failed; streaming from the mirror: ${(error as Error).message}`);
    }
  }

  let archive: Buffer;
  try {
    archive = await build();
  } catch (error) {
    if (error instanceof ConfigArchiveTooLargeError) {
      return json(413, { error: `config archive exceeds ${MAX_CONFIG_ARCHIVE_BYTES} bytes` });
    }
    throw error;
  }
  // Fill the cache for the next request. The response does not wait for it.
  void storeConfigArchive(store, project.projectId, key, archive);
  return gzipResponse(new Uint8Array(archive), treeId, 'mirror');
}

/**
 * A builder for the composed release tree of `commit`, when composing it
 * yields exactly `treeId`; else null. The equality check is what ties the
 * archive to this project: only a commit in its mirror composes the tree.
 */
async function composedArchiveBuilder(
  repo: string,
  project: GitBackedProject,
  treeId: string,
  commit: string | null | undefined,
): Promise<(() => Promise<Buffer>) | null> {
  if (!commit || !/^[0-9a-f]{40}$/.test(commit)) return null;
  const known = await runGitCapture(['cat-file', '-e', `${commit}^{commit}`], repo);
  if (known.exitCode !== 0) return null;
  const resolved = await resolveReleaseTreeSource(repo, project, commit);
  if (!('source' in resolved) || resolved.source.rootSkills.length === 0) return null;
  const { source } = resolved;
  const probe = await readComposedRelease(repo, source, { archive: false });
  if (probe.treeId !== treeId) return null;
  return async () => (await readComposedRelease(repo, source, { archive: true })).archive!;
}

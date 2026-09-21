/**
 * Serve one config archive (docs/specs/config-releases.md, "Download path").
 *
 * 1. The tree ID must name a tree object in the project's mirror, else 404.
 * 2. Public storage host: `302` to a signed store URL.
 * 3. Loopback or private storage host: stream the stored bytes. A cloud
 *    sandbox cannot reach local Supabase at 127.0.0.1.
 * 4. Store failure or missing object: build from the mirror, stream it, and
 *    `putIfAbsent` it.
 */

import { config } from '../config';
import type { GitBackedProject } from '../projects/git/types';
import { rewriteStorageOrigin } from '../shared/storage-url';
import { classifyIpHost, sanitizeUrlForLog } from '../snapshots/providers/upload-url-guard';
import {
  buildConfigArchive,
  ConfigArchiveTooLargeError,
  isTreeObject,
  MAX_CONFIG_ARCHIVE_BYTES,
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
 * Where a signed URL may point for a redirect, or null to stream.
 * `KORTIX_CONFIG_ARCHIVE_PUBLIC_URL` wins; otherwise SUPABASE_URL when public.
 */
export function publicStorageBase(env: {
  supabaseUrl: string;
  publicOverride?: string | null;
}): { internal: string; public: string } | null {
  const override = env.publicOverride?.trim();
  if (override) return { internal: env.supabaseUrl, public: override };
  return storageOriginIsPublic(env.supabaseUrl) ? { internal: env.supabaseUrl, public: env.supabaseUrl } : null;
}

export interface ServeConfigArchiveDeps {
  store?: ConfigArchiveStore;
  supabaseUrl?: string;
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

async function readStored(
  store: ConfigArchiveStore,
  key: string,
  fetchImpl: (input: string) => Promise<Response>,
): Promise<Uint8Array | null> {
  const url = await store.downloadUrl(key, CONFIG_ARCHIVE_URL_TTL_SECONDS);
  if (!url) return null;
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
 * Answer one archive request. `mirror()` returns the warm mirror path;
 * `forcedMirror()` fetches first. A tree the warm mirror lacks gets one forced
 * fetch: another API replica may have built the descriptor from a newer tip.
 */
export async function serveConfigArchive(
  project: GitBackedProject,
  treeId: string,
  mirror: () => Promise<string>,
  forcedMirror: () => Promise<string>,
  deps: ServeConfigArchiveDeps = {},
): Promise<Response> {
  let repo = await mirror();
  if (!(await isTreeObject(repo, treeId))) {
    repo = await forcedMirror();
    if (!(await isTreeObject(repo, treeId))) return json(404, { error: 'Not found' });
  }

  const store = deps.store ?? getConfigArchiveStore();
  const key = configArchiveKey(project.projectId, treeId);
  const publicBase = publicStorageBase({
    supabaseUrl: deps.supabaseUrl ?? config.SUPABASE_URL,
    publicOverride: deps.publicOverride === undefined ? config.KORTIX_CONFIG_ARCHIVE_PUBLIC_URL : deps.publicOverride,
  });
  const fetchImpl = deps.fetch ?? ((input: string) => fetch(input));

  try {
    if (publicBase) {
      const signed = await store.downloadUrl(key, CONFIG_ARCHIVE_URL_TTL_SECONDS);
      if (signed) {
        return new Response(null, {
          status: 302,
          headers: {
            Location: rewriteStorageOrigin(signed, publicBase.internal, publicBase.public),
            'Cache-Control': 'no-store',
          },
        });
      }
    } else {
      const stored = await readStored(store, key, fetchImpl);
      if (stored) return gzipResponse(stored, treeId, 'store');
    }
  } catch (error) {
    console.warn(`[config-releases] store read ${key} failed; streaming from the mirror: ${(error as Error).message}`);
  }

  let archive: Buffer;
  try {
    archive = await buildConfigArchive(repo, treeId);
  } catch (error) {
    if (error instanceof ConfigArchiveTooLargeError) {
      return json(413, { error: `config archive exceeds ${MAX_CONFIG_ARCHIVE_BYTES} bytes` });
    }
    throw error;
  }
  // Fill the cache for the next request. The response does not wait for it.
  void storeConfigArchive(store, key, archive);
  return gzipResponse(new Uint8Array(archive), treeId, 'mirror');
}

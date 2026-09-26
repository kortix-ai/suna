/**
 * Config archive store (docs/specs/config-releases.md, "Store").
 *
 * The store is a cache. The API can rebuild every config archive from its Git
 * mirror, so a store failure never blocks a release.
 *
 * There is ONE object store in the API (`../object-store/s3.ts`). This module
 * owns only what is specific to config archives: the content-addressed key
 * layout, the bucket prefix, and the retention bound. It opens no connection,
 * signs nothing, and creates no bucket — buckets are infrastructure
 * (Terraform on AWS, a database migration on Supabase Storage).
 *
 * Per environment, one code path, different endpoints:
 *   - dev / staging / prod: AWS S3, credentials from the SDK default chain
 *     (the ECS task role). `If-None-Match: *` is enforced, so a publish is
 *     atomically publish-once.
 *   - local dev / preview / self-host: Supabase Storage's S3 PROTOCOL
 *     endpoint with the S3 protocol key pair. Measured: that endpoint ignores
 *     `If-None-Match` and overwrites, so the object store reads the key first
 *     and never rewrites it. Keys are content-addressed (the config dir's git
 *     tree ID), so even a lost race writes identical bytes.
 */

import { config } from '../config';
import { ObjectStore, type PutOutcome } from '../object-store/s3';
import { isUuid } from '../shared/validate';

export interface ConfigArchiveStore {
  putIfAbsent(key: string, body: Buffer): Promise<PutOutcome>;
  downloadUrl(key: string, ttlSeconds: number): Promise<string | null>;
  exists(key: string): Promise<boolean>;
  /**
   * Retention: keep the `keep` newest archives of one project, delete the
   * rest, and return the deleted keys. Safe because the store is a cache — a
   * deleted archive is rebuilt from the mirror on the next request.
   */
  pruneProject(projectId: string, keep: number): Promise<string[]>;
}

/** Default bucket name in a Supabase-backed environment (created by migration). */
export const CONFIG_RELEASES_BUCKET = 'kortix-config-releases';
export const CONFIG_ARCHIVE_URL_TTL_SECONDS = 900;
export const CONFIG_ARCHIVE_CONTENT_TYPE = 'application/gzip';

const TREE_ID = /^[0-9a-f]{40}$/;

/** `projects/<project_id>/trees/` — one project's archives, nothing else. */
export function configArchiveProjectPrefix(projectId: string): string {
  if (!isUuid(projectId)) throw new Error(`invalid project id: ${projectId}`);
  return `projects/${projectId.toLowerCase()}/trees/`;
}

/** Object key of a config archive. Keys never share a prefix across projects. */
export function configArchiveKey(projectId: string, configTreeId: string): string {
  if (!TREE_ID.test(configTreeId)) throw new Error(`invalid config tree id: ${configTreeId}`);
  return `${configArchiveProjectPrefix(projectId)}${configTreeId}.tar.gz`;
}

export class ConfigArchiveStoreError extends Error {
  constructor(
    message: string,
    readonly status: number | null,
  ) {
    super(message);
    this.name = 'ConfigArchiveStoreError';
  }
}

/**
 * The config archive view of the shared object store: layout keys in, object
 * keys (prefix applied) out. The prefix namespaces config archives inside a
 * bucket that may also hold project snapshots.
 */
export class S3ConfigArchiveStore implements ConfigArchiveStore {
  private readonly prefix: string;

  constructor(
    private readonly objects: ObjectStore,
    prefix: string,
  ) {
    const trimmed = prefix.trim().replace(/^\/+/, '').replace(/\/+$/, '');
    this.prefix = trimmed ? `${trimmed}/` : '';
  }

  private objectKey(key: string): string {
    return `${this.prefix}${key}`;
  }

  putIfAbsent(key: string, body: Buffer): Promise<PutOutcome> {
    return this.objects.putIfAbsent({ key: this.objectKey(key), body, contentType: CONFIG_ARCHIVE_CONTENT_TYPE });
  }

  async exists(key: string): Promise<boolean> {
    return (await this.objects.head(this.objectKey(key))) !== null;
  }

  /**
   * Presigning never checks existence, so a missing object is read first:
   * the archive route must not redirect a sandbox at a URL that answers 404.
   */
  async downloadUrl(key: string, ttlSeconds: number): Promise<string | null> {
    const objectKey = this.objectKey(key);
    if (!(await this.objects.head(objectKey))) return null;
    const { url } = await this.objects.presignDownload(objectKey, ttlSeconds);
    return url;
  }

  async pruneProject(projectId: string, keep: number): Promise<string[]> {
    if (!Number.isInteger(keep) || keep < 1) throw new Error('keep must be at least 1');
    const prefix = this.objectKey(configArchiveProjectPrefix(projectId));
    const found = await this.objects.list(prefix, { pageSize: 1000, maxPages: 4 });
    if (found.length <= keep) return [];
    const ordered = [...found].sort((a, b) => (b.lastModified?.getTime() ?? 0) - (a.lastModified?.getTime() ?? 0));
    const stale = ordered.slice(keep);
    await this.objects.remove(stale.map((o) => o.key));
    return stale.map((o) => o.key.slice(this.prefix.length));
  }
}

/** In-memory store for unit tests. It keeps the real store's first-write-wins rule. */
export class MemoryConfigArchiveStore implements ConfigArchiveStore {
  readonly objects = new Map<string, Buffer>();
  /** When set, every call throws it. Simulates an unavailable store. */
  failWith: Error | null = null;
  puts = 0;

  async putIfAbsent(key: string, body: Buffer): Promise<PutOutcome> {
    if (this.failWith) throw this.failWith;
    this.puts += 1;
    if (this.objects.has(key)) return 'exists';
    this.objects.set(key, Buffer.from(body));
    return 'created';
  }

  async downloadUrl(key: string, ttlSeconds: number): Promise<string | null> {
    if (this.failWith) throw this.failWith;
    if (!this.objects.has(key)) return null;
    return `memory://config-archives/${key}?expiresIn=${ttlSeconds}`;
  }

  async exists(key: string): Promise<boolean> {
    if (this.failWith) throw this.failWith;
    return this.objects.has(key);
  }

  async pruneProject(projectId: string, keep: number): Promise<string[]> {
    if (this.failWith) throw this.failWith;
    if (!Number.isInteger(keep) || keep < 1) throw new Error('keep must be at least 1');
    const prefix = configArchiveProjectPrefix(projectId);
    // Insertion order is write order, so the tail is the newest.
    const mine = [...this.objects.keys()].filter((key) => key.startsWith(prefix));
    const stale = mine.slice(0, Math.max(0, mine.length - keep));
    for (const key of stale) this.objects.delete(key);
    return stale;
  }
}

/** The bucket, endpoint and credentials of the config archive store. */
function configArchiveTarget() {
  return {
    name: 'config archive',
    bucket: config.KORTIX_CONFIG_ARCHIVE_S3_BUCKET,
    region: config.KORTIX_CONFIG_ARCHIVE_S3_REGION,
    endpoint: config.KORTIX_CONFIG_ARCHIVE_S3_ENDPOINT,
    publicEndpoint: config.KORTIX_CONFIG_ARCHIVE_PUBLIC_URL,
    forcePathStyle: config.KORTIX_CONFIG_ARCHIVE_S3_FORCE_PATH_STYLE,
    accessKeyId: config.KORTIX_CONFIG_ARCHIVE_S3_ACCESS_KEY_ID,
    secretAccessKey: config.KORTIX_CONFIG_ARCHIVE_S3_SECRET_ACCESS_KEY,
  };
}

/** True when this environment names a bucket for config archives. */
export function configArchiveStorageConfigured(): boolean {
  return config.KORTIX_CONFIG_ARCHIVE_S3_BUCKET.trim().length > 0;
}

let store: ConfigArchiveStore | null = null;

/** The process store. Built lazily so an import never touches the network. */
export function getConfigArchiveStore(): ConfigArchiveStore {
  if (!store) {
    store = new S3ConfigArchiveStore(new ObjectStore(configArchiveTarget), config.KORTIX_CONFIG_ARCHIVE_S3_PREFIX);
  }
  return store;
}

/** Tests only: replace the process store. `null` restores the default. */
export function setConfigArchiveStoreForTests(next: ConfigArchiveStore | null): void {
  store = next;
}

/**
 * Config archive store (docs/specs/config-releases.md, "Store").
 *
 * The store is a cache. The API can rebuild every config archive from its Git
 * mirror, so a store failure never blocks a release. The default
 * implementation uses the Supabase Storage native API. The S3 endpoint is not
 * used: it overwrites an existing key, and the native API refuses it.
 */

import { config } from '../config';

export interface ConfigArchiveStore {
  putIfAbsent(key: string, body: Buffer): Promise<'created' | 'exists'>;
  downloadUrl(key: string, ttlSeconds: number): Promise<string | null>;
  exists(key: string): Promise<boolean>;
}

export const CONFIG_RELEASES_BUCKET = 'kortix-config-releases';
export const CONFIG_ARCHIVE_URL_TTL_SECONDS = 900;

const TREE_ID = /^[0-9a-f]{40}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Object key of a config archive. Keys never share a prefix across projects. */
export function configArchiveKey(projectId: string, configTreeId: string): string {
  if (!UUID.test(projectId)) throw new Error(`invalid project id: ${projectId}`);
  if (!TREE_ID.test(configTreeId)) throw new Error(`invalid config tree id: ${configTreeId}`);
  return `projects/${projectId.toLowerCase()}/trees/${configTreeId}.tar.gz`;
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

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

/** Storage error bodies carry `statusCode` as a string and `error` as a name. */
interface StorageErrorBody {
  statusCode?: string | number;
  error?: string;
  message?: string;
}

async function readErrorBody(response: Response): Promise<StorageErrorBody> {
  const text = await response.text().catch(() => '');
  try {
    const parsed = JSON.parse(text) as unknown;
    return parsed && typeof parsed === 'object' ? (parsed as StorageErrorBody) : { message: text };
  } catch {
    return { message: text };
  }
}

function isDuplicate(status: number, body: StorageErrorBody): boolean {
  if (status === 409) return true;
  return String(body.statusCode) === '409' || /duplicate|already exists/i.test(`${body.error} ${body.message}`);
}

function isNotFound(status: number, body: StorageErrorBody): boolean {
  if (status === 404) return true;
  return String(body.statusCode) === '404' || /not.?found/i.test(`${body.error} ${body.message}`);
}

function describe(status: number, body: StorageErrorBody): string {
  return `HTTP ${status}${body.error ? ` ${body.error}` : ''}${body.message ? `: ${body.message}` : ''}`;
}

/** Encode each key segment. The key layout contains `/` on purpose. */
function encodeKey(key: string): string {
  return key.split('/').map(encodeURIComponent).join('/');
}

export interface SupabaseConfigArchiveStoreOptions {
  /** Supabase origin, for example `http://127.0.0.1:54321`. */
  supabaseUrl: string;
  serviceRoleKey: string;
  bucket?: string;
  fetch?: FetchLike;
}

/**
 * Supabase Storage native API. Behaviour measured against local Supabase on
 * 2026-09-21:
 * - A second upload of one key without `x-upsert` answers HTTP 400 with body
 *   `{"statusCode":"409","error":"Duplicate"}` and keeps the original.
 * - `object/info` of a missing key answers HTTP 400 with a not-found body.
 * - `object/sign` returns `signedURL` relative to `/storage/v1`.
 */
export class SupabaseConfigArchiveStore implements ConfigArchiveStore {
  readonly bucket: string;
  private readonly base: string;
  private readonly key: string;
  private readonly fetchImpl: FetchLike;
  private bucketReady: Promise<void> | null = null;

  constructor(options: SupabaseConfigArchiveStoreOptions) {
    this.base = `${options.supabaseUrl.replace(/\/+$/, '')}/storage/v1`;
    this.key = options.serviceRoleKey;
    this.bucket = options.bucket ?? CONFIG_RELEASES_BUCKET;
    this.fetchImpl = options.fetch ?? ((input, init) => fetch(input, init));
  }

  private headers(extra: Record<string, string> = {}): Record<string, string> {
    return { apikey: this.key, Authorization: `Bearer ${this.key}`, ...extra };
  }

  /** Create the private bucket once per process. A failed attempt is retried on the next call. */
  ensureBucket(): Promise<void> {
    if (!this.bucketReady) {
      this.bucketReady = this.createBucket().catch((error) => {
        this.bucketReady = null;
        throw error;
      });
    }
    return this.bucketReady;
  }

  private async createBucket(): Promise<void> {
    const response = await this.fetchImpl(`${this.base}/bucket`, {
      method: 'POST',
      headers: this.headers({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({ id: this.bucket, name: this.bucket, public: false }),
    });
    if (response.ok) {
      await response.body?.cancel().catch(() => {});
      return;
    }
    const body = await readErrorBody(response);
    if (isDuplicate(response.status, body)) return;
    throw new ConfigArchiveStoreError(`create bucket ${this.bucket} failed: ${describe(response.status, body)}`, response.status);
  }

  async putIfAbsent(key: string, body: Buffer): Promise<'created' | 'exists'> {
    await this.ensureBucket();
    // No `x-upsert`: the native API refuses a second write of one key.
    const response = await this.fetchImpl(`${this.base}/object/${this.bucket}/${encodeKey(key)}`, {
      method: 'POST',
      headers: this.headers({ 'Content-Type': 'application/gzip', 'Cache-Control': 'max-age=31536000, immutable' }),
      body: new Uint8Array(body),
    });
    if (response.ok) {
      await response.body?.cancel().catch(() => {});
      return 'created';
    }
    const error = await readErrorBody(response);
    if (isDuplicate(response.status, error)) return 'exists';
    throw new ConfigArchiveStoreError(`upload ${key} failed: ${describe(response.status, error)}`, response.status);
  }

  async downloadUrl(key: string, ttlSeconds: number): Promise<string | null> {
    await this.ensureBucket();
    const response = await this.fetchImpl(`${this.base}/object/sign/${this.bucket}/${encodeKey(key)}`, {
      method: 'POST',
      headers: this.headers({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({ expiresIn: ttlSeconds }),
    });
    if (!response.ok) {
      const error = await readErrorBody(response);
      if (isNotFound(response.status, error)) return null;
      throw new ConfigArchiveStoreError(`sign ${key} failed: ${describe(response.status, error)}`, response.status);
    }
    const payload = (await response.json().catch(() => null)) as { signedURL?: unknown } | null;
    const signed = typeof payload?.signedURL === 'string' ? payload.signedURL : null;
    if (!signed) throw new ConfigArchiveStoreError(`sign ${key} returned no signedURL`, response.status);
    return /^https?:\/\//.test(signed) ? signed : `${this.base}${signed.startsWith('/') ? '' : '/'}${signed}`;
  }

  async exists(key: string): Promise<boolean> {
    await this.ensureBucket();
    const response = await this.fetchImpl(`${this.base}/object/info/${this.bucket}/${encodeKey(key)}`, {
      method: 'GET',
      headers: this.headers(),
    });
    if (response.ok) {
      await response.body?.cancel().catch(() => {});
      return true;
    }
    const error = await readErrorBody(response);
    if (isNotFound(response.status, error)) return false;
    throw new ConfigArchiveStoreError(`info ${key} failed: ${describe(response.status, error)}`, response.status);
  }

  /**
   * Test cleanup only: delete the named objects, then the bucket. The native
   * `bucket/{id}/empty` call only queues work, so objects are deleted by name.
   */
  async deleteBucketForTests(keys: string[]): Promise<void> {
    if (keys.length > 0) {
      const deleted = await this.fetchImpl(`${this.base}/object/${this.bucket}`, {
        method: 'DELETE',
        headers: this.headers({ 'Content-Type': 'application/json' }),
        body: JSON.stringify({ prefixes: keys }),
      });
      await deleted.body?.cancel().catch(() => {});
    }
    const removed = await this.fetchImpl(`${this.base}/bucket/${this.bucket}`, {
      method: 'DELETE',
      headers: this.headers(),
    });
    await removed.body?.cancel().catch(() => {});
    this.bucketReady = null;
  }
}

/** In-memory store for unit tests. It keeps the native API's first-write-wins rule. */
export class MemoryConfigArchiveStore implements ConfigArchiveStore {
  readonly objects = new Map<string, Buffer>();
  /** When set, every call throws it. Simulates an unavailable store. */
  failWith: Error | null = null;
  puts = 0;

  async putIfAbsent(key: string, body: Buffer): Promise<'created' | 'exists'> {
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
}

let store: ConfigArchiveStore | null = null;

/** The process store. Built lazily so an import never touches the network. */
export function getConfigArchiveStore(): ConfigArchiveStore {
  if (!store) {
    store = new SupabaseConfigArchiveStore({
      supabaseUrl: config.SUPABASE_URL,
      serviceRoleKey: config.SUPABASE_SERVICE_ROLE_KEY,
    });
  }
  return store;
}

/** Tests only: replace the process store. `null` restores the default. */
export function setConfigArchiveStoreForTests(next: ConfigArchiveStore | null): void {
  store = next;
}

/** The storage origin the signed URLs point at, before any public override. */
export function configArchiveStorageOrigin(): string {
  return config.SUPABASE_URL;
}

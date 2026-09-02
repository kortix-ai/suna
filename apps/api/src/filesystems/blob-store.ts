/**
 * Where a shared filesystem's bytes live.
 *
 * Two backends, one address space. Blobs are CONTENT-ADDRESSED — the key is the
 * sha256 of the bytes — so the same string names the same content in PostgreSQL
 * and in S3, `put` is idempotent, and writing identical bytes under twenty
 * paths costs one blob.
 *
 * WHY BOTH. The design huddle named S3, and S3 is the right backend for scale:
 * bytes leave the database, and the object store is built for exactly this.
 * But `pi_runtime_artifacts` already records the constraint that decides the
 * default — PostgreSQL is "the one store every environment has, including
 * self-host, which has no S3". Self-host is a shipping configuration, so an
 * S3-only filesystem is a filesystem our self-hosted customers cannot use, and
 * a preview environment cannot test. S3 when configured; PostgreSQL otherwise.
 *
 * Each stored row records which backend holds its bytes (`filesystem_files.
 * storage`), so a deployment that gains or loses S3 can still read what it
 * wrote before the switch. A global config flag cannot answer that question for
 * a row written last month.
 */
import { createHash } from 'node:crypto';

export type BlobStorageKind = 'pg' | 's3';

export interface BlobStore {
  readonly kind: BlobStorageKind;
  /** Idempotent: the key IS the content, so a repeat write is a no-op. */
  put(sha256: string, bytes: Uint8Array): Promise<void>;
  get(sha256: string): Promise<Uint8Array | null>;
  /** Best-effort; a blob still referenced by another path must not be removed. */
  delete(sha256: string): Promise<void>;
}

export function sha256Hex(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/** The minimum database surface the PostgreSQL backend needs. */
export interface BlobRows {
  insertBlob(sha256: string, size: number, content: Buffer): Promise<void>;
  selectBlob(sha256: string): Promise<Buffer | null>;
  deleteBlob(sha256: string): Promise<void>;
}

export class PostgresBlobStore implements BlobStore {
  readonly kind = 'pg' as const;
  constructor(private readonly rows: BlobRows) {}

  async put(sha256: string, bytes: Uint8Array): Promise<void> {
    await this.rows.insertBlob(sha256, bytes.byteLength, Buffer.from(bytes));
  }

  async get(sha256: string): Promise<Uint8Array | null> {
    const row = await this.rows.selectBlob(sha256);
    return row ? new Uint8Array(row) : null;
  }

  async delete(sha256: string): Promise<void> {
    await this.rows.deleteBlob(sha256);
  }
}

export interface S3BlobStoreOptions {
  bucket: string;
  region: string;
  /** Omit for AWS; set for R2, MinIO, or any S3-compatible endpoint. */
  endpoint?: string;
  /** Key prefix inside the bucket. A trailing slash is added if missing. */
  prefix?: string;
  credentials: { accessKeyId: string; secretAccessKey: string; sessionToken?: string };
  /**
   * Path-style addressing (`{endpoint}/{bucket}/{key}`). Required by MinIO and
   * by any endpoint without wildcard DNS; AWS accepts it too.
   */
  forcePathStyle?: boolean;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

/** Sign an S3 request with SigV4 and perform it. */
export class S3BlobStore implements BlobStore {
  readonly kind = 's3' as const;
  private readonly prefix: string;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;

  constructor(private readonly opts: S3BlobStoreOptions) {
    const p = opts.prefix ?? '';
    this.prefix = p === '' || p.endsWith('/') ? p : `${p}/`;
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.timeoutMs = opts.timeoutMs ?? 30_000;
  }

  /** `{endpoint}/{bucket}/{prefix}{sha256}` — the key is the content hash. */
  url(sha256: string): URL {
    const key = `${this.prefix}${sha256}`;
    if (this.opts.endpoint) {
      const base = this.opts.endpoint.replace(/\/+$/, '');
      return this.opts.forcePathStyle === false
        ? new URL(`${base}/${key}`)
        : new URL(`${base}/${this.opts.bucket}/${key}`);
    }
    return new URL(`https://${this.opts.bucket}.s3.${this.opts.region}.amazonaws.com/${key}`);
  }

  private async signed(method: string, sha256: string, body?: Uint8Array): Promise<Request> {
    // @smithy/signature-v4 is already a dependency (the SES sender uses the
    // same AWS credential chain), so this adds no package and no second
    // hand-rolled signer.
    const { SignatureV4 } = await import('@smithy/signature-v4');
    const { Sha256 } = await import('@aws-crypto/sha256-js');
    const url = this.url(sha256);
    const signer = new SignatureV4({
      service: 's3',
      region: this.opts.region,
      credentials: this.opts.credentials,
      sha256: Sha256,
      // S3 requires the payload hash, never UNSIGNED-PAYLOAD, for these verbs.
      uriEscapePath: false,
    });
    const payload = body ?? new Uint8Array(0);
    const signedReq = await signer.sign({
      method,
      protocol: url.protocol,
      hostname: url.hostname,
      port: url.port ? Number(url.port) : undefined,
      path: url.pathname,
      query: {},
      headers: {
        host: url.host,
        'content-length': String(payload.byteLength),
      },
      body: payload,
    });
    return new Request(url, {
      method,
      headers: signedReq.headers as Record<string, string>,
      body: method === 'GET' || method === 'DELETE' ? undefined : payload,
    });
  }

  private async send(req: Request): Promise<Response> {
    return await this.fetchImpl(req, { signal: AbortSignal.timeout(this.timeoutMs) });
  }

  async put(sha256: string, bytes: Uint8Array): Promise<void> {
    const res = await this.send(await this.signed('PUT', sha256, bytes));
    if (!res.ok) {
      throw new Error(`s3 put ${sha256} failed: ${res.status} ${await safeText(res)}`);
    }
  }

  async get(sha256: string): Promise<Uint8Array | null> {
    const res = await this.send(await this.signed('GET', sha256));
    if (res.status === 404) return null;
    if (!res.ok) {
      throw new Error(`s3 get ${sha256} failed: ${res.status} ${await safeText(res)}`);
    }
    return new Uint8Array(await res.arrayBuffer());
  }

  async delete(sha256: string): Promise<void> {
    const res = await this.send(await this.signed('DELETE', sha256));
    // S3 answers 204 for a delete, and 404 only on some implementations.
    if (!res.ok && res.status !== 404) {
      throw new Error(`s3 delete ${sha256} failed: ${res.status} ${await safeText(res)}`);
    }
  }
}

async function safeText(res: Response): Promise<string> {
  try {
    return (await res.text()).slice(0, 300);
  } catch {
    return '<no body>';
  }
}

export interface FilesystemStorageConfig {
  s3Bucket: string;
  s3Region: string;
  s3Endpoint: string;
  s3Prefix: string;
  s3AccessKeyId: string;
  s3SecretAccessKey: string;
}

/**
 * S3 only when it is FULLY configured — a half-set bucket falls back to
 * PostgreSQL rather than failing every write at runtime. Storage that silently
 * degrades is bad; storage that refuses to start on a missing optional env var
 * is worse, and every environment must be able to serve a filesystem.
 */
export function s3ConfigComplete(cfg: Partial<FilesystemStorageConfig>): boolean {
  return Boolean(cfg.s3Bucket && cfg.s3Region && cfg.s3AccessKeyId && cfg.s3SecretAccessKey);
}

export function createBlobStore(
  cfg: Partial<FilesystemStorageConfig>,
  rows: BlobRows,
  overrides?: { fetchImpl?: typeof fetch },
): BlobStore {
  if (!s3ConfigComplete(cfg)) return new PostgresBlobStore(rows);
  return new S3BlobStore({
    bucket: cfg.s3Bucket!,
    region: cfg.s3Region!,
    endpoint: cfg.s3Endpoint || undefined,
    prefix: cfg.s3Prefix || '',
    credentials: {
      accessKeyId: cfg.s3AccessKeyId!,
      secretAccessKey: cfg.s3SecretAccessKey!,
    },
    fetchImpl: overrides?.fetchImpl,
  });
}

import { describe, expect, test } from 'bun:test';
import {
  createBlobStore,
  PostgresBlobStore,
  S3BlobStore,
  s3ConfigComplete,
  sha256Hex,
  type BlobRows,
} from './blob-store';

/** In-memory stand-in for the three queries the PostgreSQL backend runs. */
function fakeRows(): BlobRows & { store: Map<string, Buffer> } {
  const store = new Map<string, Buffer>();
  return {
    store,
    async insertBlob(sha256, _size, content) {
      // ON CONFLICT DO NOTHING: the key is the content, so first write wins.
      if (!store.has(sha256)) store.set(sha256, content);
    },
    async selectBlob(sha256) {
      return store.get(sha256) ?? null;
    },
    async deleteBlob(sha256) {
      store.delete(sha256);
    },
  };
}

const CREDS = { accessKeyId: 'AKIAEXAMPLE', secretAccessKey: 'secret' };

describe('content addressing', () => {
  test('the key is the sha256 of the bytes', () => {
    // Well-known vector: sha256("abc").
    expect(sha256Hex(new TextEncoder().encode('abc'))).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    );
  });

  test('identical bytes collapse to one blob, whatever path wrote them', async () => {
    const rows = fakeRows();
    const store = new PostgresBlobStore(rows);
    const bytes = new TextEncoder().encode('shared state');
    const key = sha256Hex(bytes);

    await store.put(key, bytes);
    await store.put(key, bytes); // a second path, same content
    expect(rows.store.size).toBe(1);
    expect(new TextDecoder().decode((await store.get(key))!)).toBe('shared state');
  });

  test('a missing blob reads as null, not an exception', async () => {
    expect(await new PostgresBlobStore(fakeRows()).get('deadbeef')).toBeNull();
  });

  test('delete removes it', async () => {
    const rows = fakeRows();
    const store = new PostgresBlobStore(rows);
    const bytes = new TextEncoder().encode('x');
    await store.put(sha256Hex(bytes), bytes);
    await store.delete(sha256Hex(bytes));
    expect(await store.get(sha256Hex(bytes))).toBeNull();
  });
});

describe('backend selection', () => {
  // Storage that silently degrades is bad; storage that refuses to start on a
  // half-configured optional env var is worse. Every environment must serve.
  test('a half-configured S3 falls back to PostgreSQL rather than failing writes', () => {
    expect(s3ConfigComplete({ s3Bucket: 'b' })).toBe(false);
    expect(s3ConfigComplete({ s3Bucket: 'b', s3Region: 'us-east-1' })).toBe(false);
    expect(createBlobStore({ s3Bucket: 'b' }, fakeRows()).kind).toBe('pg');
    expect(createBlobStore({}, fakeRows()).kind).toBe('pg');
  });

  test('a complete S3 config selects S3', () => {
    const cfg = {
      s3Bucket: 'b',
      s3Region: 'us-east-1',
      s3AccessKeyId: 'k',
      s3SecretAccessKey: 's',
    };
    expect(s3ConfigComplete(cfg)).toBe(true);
    expect(createBlobStore(cfg, fakeRows()).kind).toBe('s3');
  });
});

describe('S3 key addressing', () => {
  test('a custom endpoint uses path-style, so MinIO and R2 work without wildcard DNS', () => {
    const store = new S3BlobStore({
      bucket: 'kortix-fs',
      region: 'us-east-1',
      endpoint: 'http://127.0.0.1:19000',
      credentials: CREDS,
    });
    expect(store.url('abc123').toString()).toBe('http://127.0.0.1:19000/kortix-fs/abc123');
  });

  test('a prefix gets exactly one separating slash', () => {
    const withSlash = new S3BlobStore({
      bucket: 'b',
      region: 'r',
      endpoint: 'http://h',
      prefix: 'blobs/',
      credentials: CREDS,
    });
    const without = new S3BlobStore({
      bucket: 'b',
      region: 'r',
      endpoint: 'http://h',
      prefix: 'blobs',
      credentials: CREDS,
    });
    expect(withSlash.url('k').toString()).toBe('http://h/b/blobs/k');
    expect(without.url('k').toString()).toBe('http://h/b/blobs/k');
  });

  test('no endpoint means AWS virtual-host addressing', () => {
    const store = new S3BlobStore({ bucket: 'b', region: 'eu-west-1', credentials: CREDS });
    expect(store.url('k').toString()).toBe('https://b.s3.eu-west-1.amazonaws.com/k');
  });
});

describe('S3 requests are signed', () => {
  test('a PUT carries a SigV4 Authorization header and the payload', async () => {
    let seen: Request | null = null;
    const store = new S3BlobStore({
      bucket: 'b',
      region: 'us-east-1',
      endpoint: 'http://h',
      credentials: CREDS,
      fetchImpl: async (req) => {
        seen = req as Request;
        return new Response('', { status: 200 });
      },
    });
    const bytes = new TextEncoder().encode('payload');
    await store.put(sha256Hex(bytes), bytes);

    expect(seen).not.toBeNull();
    expect(seen!.method).toBe('PUT');
    const auth = seen!.headers.get('authorization') ?? '';
    expect(auth).toContain('AWS4-HMAC-SHA256');
    expect(auth).toContain('Credential=AKIAEXAMPLE/');
    // The payload hash must be signed, never UNSIGNED-PAYLOAD.
    expect(seen!.headers.get('x-amz-content-sha256')).toBe(sha256Hex(bytes));
  });

  test('a 404 on GET is null; any other failure is an error, never silent data loss', async () => {
    const make = (status: number) =>
      new S3BlobStore({
        bucket: 'b',
        region: 'us-east-1',
        endpoint: 'http://h',
        credentials: CREDS,
        fetchImpl: async () => new Response('nope', { status }),
      });
    expect(await make(404).get('k')).toBeNull();
    await expect(make(500).get('k')).rejects.toThrow(/s3 get/);
    await expect(make(403).put('k', new Uint8Array([1]))).rejects.toThrow(/s3 put/);
  });
});

/**
 * The S3 backend against a REAL S3 implementation.
 *
 * A mocked fetch proves the request was shaped the way we think; it cannot
 * prove the signature is one an S3 server accepts. SigV4 fails on details a
 * stand-in never checks — canonical header order, the payload hash, path
 * escaping — so the only honest test of a signer is a server that rejects a
 * wrong one. This runs against MinIO and is SKIPPED when it is not up, so a
 * laptop without Docker still gets a green suite.
 *
 *   docker run -d --name kortix-fs-minio -p 19000:9000 \
 *     -e MINIO_ROOT_USER=kortixtest -e MINIO_ROOT_PASSWORD=kortixtest123 \
 *     minio/minio:latest server /data
 *   docker exec kortix-fs-minio mkdir -p /data/kortix-fs
 */
import { describe, expect, test } from 'bun:test';
import { S3BlobStore, sha256Hex } from './blob-store';

const ENDPOINT = process.env.KORTIX_TEST_S3_ENDPOINT ?? 'http://127.0.0.1:19000';
const BUCKET = process.env.KORTIX_TEST_S3_BUCKET ?? 'kortix-fs';

const reachable = await (async () => {
  try {
    const res = await fetch(`${ENDPOINT}/minio/health/live`, {
      signal: AbortSignal.timeout(1500),
    });
    return res.ok;
  } catch {
    return false;
  }
})();

const maybe = reachable ? describe : describe.skip;
if (!reachable) {
  console.log(`[blob-store.integration] MinIO not reachable at ${ENDPOINT} — skipping`);
}

function store(): S3BlobStore {
  return new S3BlobStore({
    bucket: BUCKET,
    region: 'us-east-1',
    endpoint: ENDPOINT,
    credentials: {
      accessKeyId: process.env.KORTIX_TEST_S3_KEY ?? 'kortixtest',
      secretAccessKey: process.env.KORTIX_TEST_S3_SECRET ?? 'kortixtest123',
    },
  });
}

maybe('S3BlobStore against a real S3 server', () => {
  test('a signature MinIO accepts: put, read back the exact bytes, delete', async () => {
    const s = store();
    // Distinct per run so a leftover object from an earlier run cannot pass
    // this test for us.
    const bytes = new TextEncoder().encode(`shared filesystem state ${process.pid}-${Bun.nanoseconds()}`);
    const key = sha256Hex(bytes);

    await s.put(key, bytes);
    const read = await s.get(key);
    expect(read).not.toBeNull();
    expect(Buffer.from(read!).equals(Buffer.from(bytes))).toBe(true);

    await s.delete(key);
    expect(await s.get(key)).toBeNull();
  });

  test('binary survives the round trip byte-for-byte', async () => {
    const s = store();
    const bytes = new Uint8Array(1024);
    for (let i = 0; i < bytes.length; i++) bytes[i] = (i * 7) % 256;
    const key = sha256Hex(bytes);

    await s.put(key, bytes);
    const read = await s.get(key);
    expect(Buffer.from(read!).equals(Buffer.from(bytes))).toBe(true);
    // Content addressing is only true if what comes back still hashes to the key.
    expect(sha256Hex(read!)).toBe(key);
    await s.delete(key);
  });

  test('a key that was never written reads as null, not an error', async () => {
    expect(await store().get('0'.repeat(64))).toBeNull();
  });

  test('putting the same content twice is a no-op, not a conflict', async () => {
    const s = store();
    const bytes = new TextEncoder().encode(`idempotent ${Bun.nanoseconds()}`);
    const key = sha256Hex(bytes);
    await s.put(key, bytes);
    await s.put(key, bytes);
    expect(sha256Hex((await s.get(key))!)).toBe(key);
    await s.delete(key);
  });

  test('a wrong secret is REJECTED — proving the server verifies the signature', async () => {
    const bad = new S3BlobStore({
      bucket: BUCKET,
      region: 'us-east-1',
      endpoint: ENDPOINT,
      credentials: { accessKeyId: 'kortixtest', secretAccessKey: 'wrong-secret' },
    });
    await expect(bad.put(sha256Hex(new Uint8Array([1])), new Uint8Array([1]))).rejects.toThrow(
      /s3 put/,
    );
  });
});

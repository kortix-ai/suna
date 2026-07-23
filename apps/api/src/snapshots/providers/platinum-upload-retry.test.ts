import { afterEach, describe, expect, test } from 'bun:test';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { rm } from 'node:fs/promises';

function setTestEnv(name: string, value: string): void {
  if (!process.env[name] || process.env[name]?.startsWith('encrypted:')) {
    process.env[name] = value;
  }
}

setTestEnv('DATABASE_URL', 'postgres://postgres:postgres@127.0.0.1:54322/postgres');
setTestEnv('SUPABASE_URL', 'http://127.0.0.1:54321');
setTestEnv('SUPABASE_SERVICE_ROLE_KEY', 'test-service-role');
setTestEnv('API_KEY_SECRET', 'test-api-key-secret');
setTestEnv('TUNNEL_SIGNING_SECRET', 'test-tunnel-signing-secret');
setTestEnv('ALLOWED_SANDBOX_PROVIDERS', 'platinum');
setTestEnv('KORTIX_URL', 'https://api.example.test');
setTestEnv('FRONTEND_URL', 'http://localhost:3000');
setTestEnv('INTERNAL_KORTIX_ENV', 'dev');
setTestEnv('RECALL_BASE_URL', 'https://us-west-2.recall.ai/api/v1');

const { uploadWithRetry } = await import('./platinum');

const originalFetch = globalThis.fetch;
const created: string[] = [];

afterEach(async () => {
  globalThis.fetch = originalFetch;
  for (const p of created.splice(0)) await rm(p, { force: true }).catch(() => {});
});

async function tinyTar(): Promise<string> {
  const path = join(tmpdir(), `ptx-upload-${crypto.randomUUID()}.tar.gz`);
  await Bun.write(path, new Uint8Array(1024));
  created.push(path);
  return path;
}

describe('platinum uploadWithRetry — large-context resilience', () => {
  test('a transient S3 failure RE-PRESIGNS for a fresh URL + key, not the stale one', async () => {
    const tarPath = await tinyTar();
    let presignCalls = 0;
    const seenUrls: string[] = [];
    const presignFn = async () => {
      presignCalls += 1;
      return { upload_url: `https://s3.test/put-${presignCalls}`, context_s3_key: `key-${presignCalls}` };
    };
    let put = 0;
    globalThis.fetch = (async (url: string) => {
      seenUrls.push(String(url));
      put += 1;
      return new Response('', { status: put === 1 ? 408 : 200 });
    }) as typeof fetch;

    const key = await uploadWithRetry(presignFn, tarPath);

    expect(presignCalls).toBe(2);
    expect(key).toBe('key-2');
    expect(seenUrls).toEqual(['https://s3.test/put-1', 'https://s3.test/put-2']);
  }, 15_000);

  test('a non-retryable 403 fails immediately without a second presign', async () => {
    const tarPath = await tinyTar();
    let presignCalls = 0;
    const presignFn = async () => {
      presignCalls += 1;
      return { upload_url: 'https://s3.test/put', context_s3_key: 'key' };
    };
    globalThis.fetch = (async () => new Response('denied', { status: 403 })) as unknown as typeof fetch;

    await expect(uploadWithRetry(presignFn, tarPath)).rejects.toThrow();
    expect(presignCalls).toBe(1);
  }, 15_000);

  test('PHASE 2: an http (non-https) presigned URL is rejected before any PUT', async () => {
    const tarPath = await tinyTar();
    let presignCalls = 0;
    const presignFn = async () => {
      presignCalls += 1;
      return { upload_url: 'http://s3.test/put', context_s3_key: 'key' };
    };
    let puts = 0;
    globalThis.fetch = (async () => {
      puts += 1;
      return new Response('', { status: 200 });
    }) as unknown as typeof fetch;

    await expect(
      uploadWithRetry(presignFn, tarPath, { allowLocal: false, allowedHosts: [] }),
    ).rejects.toThrow(/rejected/);
    expect(puts).toBe(0); // never streamed the context to an unsafe URL
    expect(presignCalls).toBe(1); // terminal, not retried
  }, 15_000);

  test('PHASE 2: an SSRF/private presigned URL is rejected before any PUT', async () => {
    const tarPath = await tinyTar();
    const presignFn = async () => ({ upload_url: 'https://169.254.169.254/x', context_s3_key: 'key' });
    let puts = 0;
    globalThis.fetch = (async () => {
      puts += 1;
      return new Response('', { status: 200 });
    }) as unknown as typeof fetch;

    await expect(
      uploadWithRetry(presignFn, tarPath, { allowLocal: false, allowedHosts: [] }),
    ).rejects.toThrow(/rejected/);
    expect(puts).toBe(0);
  }, 15_000);

  test('PHASE 2: the PUT refuses redirects (redirect: error)', async () => {
    const tarPath = await tinyTar();
    const presignFn = async () => ({ upload_url: 'https://s3.test/put', context_s3_key: 'key' });
    let sawRedirectError = false;
    globalThis.fetch = (async (_url: string, init: RequestInit) => {
      if (init?.redirect === 'error') sawRedirectError = true;
      return new Response('', { status: 200 });
    }) as unknown as typeof fetch;

    const key = await uploadWithRetry(presignFn, tarPath, { allowLocal: false, allowedHosts: [] });
    expect(key).toBe('key');
    expect(sawRedirectError).toBe(true);
  }, 15_000);
});

/**
 * The Supabase store against a real local Supabase at 127.0.0.1:54321.
 *
 * Runs only when that Storage API answers and a service-role key is available
 * (`KORTIX_CONFIG_STORE_TEST_SERVICE_ROLE_KEY`, else `supabase status -o env`).
 * Otherwise every test skips. Each run uses its own bucket and deletes it.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { SupabaseConfigArchiveStore, configArchiveKey } from './store';

const SUPABASE_URL = 'http://127.0.0.1:54321';

async function storageReachable(): Promise<boolean> {
  try {
    const response = await fetch(`${SUPABASE_URL}/storage/v1/status`, { signal: AbortSignal.timeout(1500) });
    await response.body?.cancel().catch(() => {});
    return response.ok;
  } catch {
    return false;
  }
}

function serviceRoleKey(): string | null {
  const fromEnv = process.env.KORTIX_CONFIG_STORE_TEST_SERVICE_ROLE_KEY;
  if (fromEnv) return fromEnv;
  const status = spawnSync('npx', ['--no-install', 'supabase', 'status', '-o', 'env'], {
    cwd: resolve(import.meta.dir, '../../../..'),
    encoding: 'utf8',
    timeout: 20_000,
  });
  if (status.status !== 0) return null;
  const line = status.stdout.split('\n').find((l) => l.startsWith('SERVICE_ROLE_KEY='));
  return line ? line.slice('SERVICE_ROLE_KEY='.length).replace(/^"|"$/g, '') : null;
}

const reachable = await storageReachable();
const key = reachable ? serviceRoleKey() : null;
const live = Boolean(reachable && key);

const PROJECT = crypto.randomUUID();
const TREE = 'b'.repeat(40);
const bucket = `kortix-config-releases-test-${crypto.randomUUID().slice(0, 8)}`;
const store = live ? new SupabaseConfigArchiveStore({ supabaseUrl: SUPABASE_URL, serviceRoleKey: key!, bucket }) : null;
const written: string[] = [];

describe.skipIf(!live)('SupabaseConfigArchiveStore against local Supabase', () => {
  beforeAll(async () => {
    await store!.ensureBucket();
  });

  afterAll(async () => {
    await store?.deleteBucketForTests(written);
    const probe = await fetch(`${SUPABASE_URL}/storage/v1/bucket/${bucket}`, {
      headers: { apikey: key!, Authorization: `Bearer ${key}` },
    });
    await probe.body?.cancel().catch(() => {});
    // The bucket must be gone: this test leaves nothing in the shared Supabase.
    expect(probe.ok).toBe(false);
  });

  test('putIfAbsent creates once and keeps the original on a second write', async () => {
    const objectKey = configArchiveKey(PROJECT, TREE);
    written.push(objectKey);
    expect(await store!.exists(objectKey)).toBe(false);
    expect(await store!.putIfAbsent(objectKey, Buffer.from('original bytes'))).toBe('created');
    expect(await store!.putIfAbsent(objectKey, Buffer.from('replacement bytes'))).toBe('exists');
    expect(await store!.exists(objectKey)).toBe(true);

    const url = await store!.downloadUrl(objectKey, 900);
    expect(url).toStartWith(`${SUPABASE_URL}/storage/v1/object/sign/${bucket}/`);
    // A signed URL downloads with no credentials, and returns the first write.
    const download = await fetch(url!);
    expect(download.status).toBe(200);
    expect(Buffer.from(await download.arrayBuffer()).toString()).toBe('original bytes');
  });

  test('the bucket is private: an unsigned read is refused', async () => {
    const objectKey = configArchiveKey(PROJECT, TREE);
    const response = await fetch(`${SUPABASE_URL}/storage/v1/object/public/${bucket}/${objectKey}`);
    await response.body?.cancel().catch(() => {});
    expect(response.ok).toBe(false);
  });

  test('a missing key: exists is false and downloadUrl is null', async () => {
    const missing = configArchiveKey(PROJECT, 'c'.repeat(40));
    expect(await store!.exists(missing)).toBe(false);
    expect(await store!.downloadUrl(missing, 900)).toBeNull();
  });

  test('a second store instance treats the existing bucket as ready', async () => {
    const again = new SupabaseConfigArchiveStore({ supabaseUrl: SUPABASE_URL, serviceRoleKey: key!, bucket });
    await again.ensureBucket();
    expect(await again.exists(configArchiveKey(PROJECT, TREE))).toBe(true);
  });
});

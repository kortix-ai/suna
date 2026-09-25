/**
 * The config archive store against a REAL local Supabase Storage, through its
 * S3 protocol endpoint — the same `ObjectStore` the cloud uses, only pointed
 * at a different endpoint.
 *
 * This test is where the publish-once claim is MEASURED rather than asserted
 * from a comment: it drives the raw endpoint first (a second PutObject with
 * `If-None-Match: *` OVERWRITES there) and then proves the store's
 * head-then-put path keeps the first write anyway.
 *
 * Runs only when local Supabase answers and its S3 protocol keys are
 * available (`supabase status -o env`, else the well-known CLI defaults).
 * Otherwise every test skips. Every object it writes is deleted.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { PutObjectCommand } from '@aws-sdk/client-s3';
import { ObjectStore } from '../object-store/s3';
import {
  CONFIG_ARCHIVE_CONTENT_TYPE,
  CONFIG_RELEASES_BUCKET,
  S3ConfigArchiveStore,
  configArchiveKey,
} from './store';

const SUPABASE_URL = 'http://127.0.0.1:54321';
const ENDPOINT = `${SUPABASE_URL}/storage/v1/s3`;
const PREFIX = 'config-releases-test';

async function storageReachable(): Promise<boolean> {
  try {
    const response = await fetch(`${SUPABASE_URL}/storage/v1/status`, { signal: AbortSignal.timeout(1500) });
    await response.body?.cancel().catch(() => {});
    return response.ok;
  } catch {
    return false;
  }
}

function s3Keys(): { id: string; secret: string } | null {
  const fromEnv = process.env.KORTIX_CONFIG_ARCHIVE_S3_ACCESS_KEY_ID;
  const secretFromEnv = process.env.KORTIX_CONFIG_ARCHIVE_S3_SECRET_ACCESS_KEY;
  if (fromEnv && secretFromEnv && !fromEnv.startsWith('test-')) return { id: fromEnv, secret: secretFromEnv };
  const status = spawnSync('npx', ['--no-install', 'supabase', 'status', '-o', 'env'], {
    cwd: resolve(import.meta.dir, '../../../..'),
    encoding: 'utf8',
    timeout: 20_000,
  });
  if (status.status !== 0) return null;
  const read = (name: string): string | null => {
    const line = status.stdout.split('\n').find((l) => l.startsWith(`${name}=`));
    return line ? line.slice(name.length + 1).replace(/^"|"$/g, '') : null;
  };
  const id = read('S3_PROTOCOL_ACCESS_KEY_ID');
  const secret = read('S3_PROTOCOL_ACCESS_KEY_SECRET');
  return id && secret ? { id, secret } : null;
}

const reachable = await storageReachable();
const keys = reachable ? s3Keys() : null;
const live = Boolean(reachable && keys);

const PROJECT = crypto.randomUUID();
const TREE = 'b'.repeat(40);

const objects = live
  ? new ObjectStore(() => ({
      name: 'config archive',
      bucket: CONFIG_RELEASES_BUCKET,
      region: 'local',
      endpoint: ENDPOINT,
      forcePathStyle: true,
      accessKeyId: keys!.id,
      secretAccessKey: keys!.secret,
    }))
  : null;
const store = objects ? new S3ConfigArchiveStore(objects, PREFIX) : null;
const written: string[] = [];

describe.skipIf(!live)('config archive store on Supabase Storage (S3 protocol)', () => {
  afterAll(async () => {
    if (!objects) return;
    await objects.remove(written.map((key) => `${PREFIX}/${key}`));
    const left = await objects.list(`${PREFIX}/projects/${PROJECT}/`);
    // This test leaves nothing behind in the shared local bucket.
    expect(left).toHaveLength(0);
  });

  test('the raw endpoint IGNORES If-None-Match — this is why the store heads first', async () => {
    const key = `${PREFIX}/projects/${PROJECT}/trees/raw.tar.gz`;
    written.push(`projects/${PROJECT}/trees/raw.tar.gz`);
    const put = (body: string) =>
      objects!.client().send(
        new PutObjectCommand({
          Bucket: CONFIG_RELEASES_BUCKET,
          Key: key,
          Body: Buffer.from(body),
          ContentType: CONFIG_ARCHIVE_CONTENT_TYPE,
          IfNoneMatch: '*',
        }),
      );
    await put('first');
    // No 412: the header is accepted and ignored.
    await put('second');
    expect(await objects!.getText(key)).toBe('second');
    expect(objects!.publishOnce()).toBe('head-then-put');
  });

  test('putIfAbsent creates once and keeps the original on a second write', async () => {
    const key = configArchiveKey(PROJECT, TREE);
    written.push(key);
    expect(await store!.exists(key)).toBe(false);
    expect(await store!.putIfAbsent(key, Buffer.from('original bytes'))).toBe('created');
    expect(await store!.putIfAbsent(key, Buffer.from('replacement bytes'))).toBe('exists');
    expect(await store!.exists(key)).toBe(true);

    const url = await store!.downloadUrl(key, 900);
    expect(url).toStartWith(`${ENDPOINT}/${CONFIG_RELEASES_BUCKET}/${PREFIX}/`);
    // A presigned URL downloads with no other credentials, and returns the
    // first write.
    const download = await fetch(url!);
    expect(download.status).toBe(200);
    expect(Buffer.from(await download.arrayBuffer()).toString()).toBe('original bytes');
  });

  test('the bucket is private: an unsigned read is refused', async () => {
    const response = await fetch(
      `${SUPABASE_URL}/storage/v1/object/public/${CONFIG_RELEASES_BUCKET}/${PREFIX}/${configArchiveKey(PROJECT, TREE)}`,
    );
    await response.body?.cancel().catch(() => {});
    expect(response.ok).toBe(false);
  });

  test('a missing key: exists is false and downloadUrl is null', async () => {
    const missing = configArchiveKey(PROJECT, 'c'.repeat(40));
    expect(await store!.exists(missing)).toBe(false);
    expect(await store!.downloadUrl(missing, 900)).toBeNull();
  });

  test('pruneProject keeps the newest archives and deletes the rest', async () => {
    const project = crypto.randomUUID();
    const keys = ['1', '2', '3'].map((n) => configArchiveKey(project, n.repeat(40)));
    for (const key of keys) {
      written.push(key);
      await store!.putIfAbsent(key, Buffer.from(key));
      // Distinct LastModified values: Storage stamps at second resolution.
      await Bun.sleep(1100);
    }
    const deleted = await store!.pruneProject(project, 2);
    expect(deleted).toEqual([keys[0]!]);
    expect(await store!.exists(keys[0]!)).toBe(false);
    expect(await store!.exists(keys[1]!)).toBe(true);
    expect(await store!.exists(keys[2]!)).toBe(true);
  }, 30_000);
});

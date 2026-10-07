/**
 * Static App hosting against a real PostgreSQL: publish (content-addressed,
 * deduplicated), serve (manifest, SPA, caching, ranges), retention (retire,
 * free the files, keep the history) and blob reclaim (only unreferenced,
 * never the newest). Storage is an in-memory `SiteStorage`.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { accounts, appArtifacts, appDeploymentEvents, appDeployments, appSiteBlobs, appSiteFiles, apps, projects } from '@kortix/db';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { db } from '../shared/db';
import { createBuildLog } from './build-log';
import { retireSupersededDeployments, rollBackActiveDeployment, sweepAppRetention } from './retention';
import {
  blobKey,
  MAX_COMPRESS_BYTES,
  publishStaticSite,
  reclaimAppSiteBlobs,
  resetStaticSiteCaches,
  serveStaticDeployment,
  type SiteStorage,
} from './static-site';

const confirmed = Boolean(
  process.env.TEST_DATABASE_URL &&
    process.env.KORTIX_TEST_DB_CONFIRM === 'I_UNDERSTAND_THIS_DELETES_TEST_DATA' &&
    process.env.INTERNAL_KORTIX_ENV !== 'prod',
);
const withDb = confirmed ? describe : describe.skip;

const ACCOUNT_ID = '00000000-0000-4000-a000-00000000d901';
const PROJECT_ID = '00000000-0000-4000-a000-00000000d902';
const APP_ID = '00000000-0000-4000-a000-00000000d903';
const ARTIFACT_ID = '00000000-0000-4000-a000-00000000d904';
const dep = (n: number) => `00000000-0000-4000-a000-0000000d${String(910 + n).padStart(4, '0')}`;

function memoryStorage(): SiteStorage & { objects: Map<string, Uint8Array>; puts: number } {
  const objects = new Map<string, Uint8Array>();
  const store = {
    objects,
    puts: 0,
    async put(key: string, bytes: Uint8Array) {
      store.puts += 1;
      objects.set(key, bytes);
    },
    async get(key: string) {
      return objects.get(key) ?? null;
    },
    async remove(keys: string[]) {
      for (const key of keys) objects.delete(key);
    },
  };
  return store;
}

async function site(files: Record<string, string>): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'kortix-static-site-'));
  for (const [path, body] of Object.entries(files)) {
    await mkdir(join(root, path, '..'), { recursive: true });
    await writeFile(join(root, path), body);
  }
  return root;
}

async function cleanup(): Promise<void> {
  await db.update(apps).set({ activeDeploymentId: null }).where(eq(apps.projectId, PROJECT_ID));
  await db.delete(appSiteBlobs).where(eq(appSiteBlobs.accountId, ACCOUNT_ID));
  await db.delete(apps).where(eq(apps.projectId, PROJECT_ID));
  await db.delete(appArtifacts).where(eq(appArtifacts.projectId, PROJECT_ID));
  await db.delete(projects).where(eq(projects.projectId, PROJECT_ID));
  await db.delete(accounts).where(eq(accounts.accountId, ACCOUNT_ID));
}

async function seedDeployments(count: number, status = 'ready'): Promise<void> {
  await db.insert(appDeployments).values(Array.from({ length: count }, (_, i) => ({
    deploymentId: dep(i + 1),
    appId: APP_ID,
    artifactId: ARTIFACT_ID,
    version: i + 1,
    status,
    sourceKind: 'static',
    hostingType: 'static',
    runtimeVersion: 'test',
    runtimeSpec: { spa: true },
    createdBy: PROJECT_ID,
  })));
}

const roots: string[] = [];

withDb('static App hosting', () => {
  beforeEach(async () => {
    await cleanup();
    resetStaticSiteCaches();
    await db.insert(accounts).values({ accountId: ACCOUNT_ID, name: 'static hosting test' });
    await db.insert(projects).values({
      projectId: PROJECT_ID,
      accountId: ACCOUNT_ID,
      name: 'static hosting test',
      repoUrl: 'https://example.test/static-hosting.git',
      metadata: { experimental: { apps: true } },
    });
    await db.insert(apps).values({
      appId: APP_ID,
      accountId: ACCOUNT_ID,
      projectId: PROJECT_ID,
      slug: 'static-hosting',
      name: 'static',
      routeKey: 'dddddddddddddd01',
    });
    await db.insert(appArtifacts).values({
      artifactId: ARTIFACT_ID,
      accountId: ACCOUNT_ID,
      projectId: PROJECT_ID,
      kind: 'archive',
      status: 'ready',
    });
  });
  afterEach(async () => {
    await cleanup();
    for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
  });

  test('publish stores each distinct file once per account, and a redeploy uploads only what changed', async () => {
    await seedDeployments(2, 'building');
    const storage = memoryStorage();
    const v1 = await site({
      'index.html': '<!doctype html><div id=app></div>',
      'assets/index-D8j1YYcB.js': 'console.log(1)',
      'a.txt': 'same',
      'b.txt': 'same',
    });
    roots.push(v1);
    const first = await publishStaticSite({ deploymentId: dep(1), accountId: ACCOUNT_ID, sourceDir: v1, storage });
    expect(first).toEqual({ files: 4, bytes: first.bytes, uploadedBlobs: 3, reusedBlobs: 0 });
    expect(storage.objects.size).toBe(3);

    const v2 = await site({
      'index.html': '<!doctype html><div id=app></div>',
      'assets/index-Q9x2LmP4.js': 'console.log(2)',
      'a.txt': 'same',
      'b.txt': 'same',
    });
    roots.push(v2);
    const second = await publishStaticSite({ deploymentId: dep(2), accountId: ACCOUNT_ID, sourceDir: v2, storage });
    expect(second.uploadedBlobs).toBe(1);
    expect(second.reusedBlobs).toBe(2);
    // A retried publish is idempotent: no upload, no duplicate rows.
    const putsBefore = storage.puts;
    await publishStaticSite({ deploymentId: dep(2), accountId: ACCOUNT_ID, sourceDir: v2, storage });
    expect(storage.puts).toBe(putsBefore);
    const rows = await db.select().from(appSiteFiles).where(eq(appSiteFiles.deploymentId, dep(2)));
    expect(rows.map((row) => row.path).sort()).toEqual(['a.txt', 'assets/index-Q9x2LmP4.js', 'b.txt', 'index.html']);
  });

  test('serve: files, SPA shell, revalidation, HEAD, ranges and methods', async () => {
    await seedDeployments(1, 'building');
    const storage = memoryStorage();
    const root = await site({
      'index.html': '<!doctype html><title>shell</title>',
      'assets/index-D8j1YYcB.js': 'console.log("hello")',
      'video.bin': '0123456789',
      'big.js': 'x'.repeat(4096),
    });
    roots.push(root);
    await publishStaticSite({ deploymentId: dep(1), accountId: ACCOUNT_ID, sourceDir: root, storage });
    const serve = (path: string, init: RequestInit = {}) =>
      serveStaticDeployment({
        request: new Request(`https://app.test${path}`, init),
        url: new URL(`https://app.test${path}`),
        accountId: ACCOUNT_ID,
        deploymentId: dep(1),
        spa: true,
        publicApp: false,
        storage,
      });

    const page = await serve('/');
    expect(page.status).toBe(200);
    expect(page.headers.get('content-type')).toContain('text/html');
    expect(page.headers.get('cache-control')).toBe('private, no-cache');
    expect(page.headers.get('content-security-policy')).toContain('frame-ancestors');
    expect(await page.text()).toContain('shell');

    const asset = await serve('/assets/index-D8j1YYcB.js');
    expect(asset.headers.get('cache-control')).toBe('private, max-age=31536000, immutable');
    // A private App's files never reach the shared edge cache.
    expect(asset.headers.get('x-kortix-edge-cacheable')).toBeNull();
    expect(asset.headers.get('cloudflare-cdn-cache-control')).toBe('no-store');
    expect(asset.headers.get('content-type')).toContain('javascript');

    // A public App's files are marked shareable; the Worker caches only the immutable ones.
    const publicAsset = await serveStaticDeployment({
      request: new Request('https://app.test/assets/index-D8j1YYcB.js'),
      url: new URL('https://app.test/assets/index-D8j1YYcB.js'),
      accountId: ACCOUNT_ID,
      deploymentId: dep(1),
      spa: true,
      publicApp: true,
      storage,
    });
    expect(publicAsset.headers.get('cache-control')).toBe('public, max-age=31536000, immutable');
    expect(publicAsset.headers.get('x-kortix-edge-cacheable')).toBe('public');

    const deepLink = await serve('/deals/42', { headers: { accept: 'text/html' } });
    expect(deepLink.status).toBe(200);
    expect(await deepLink.text()).toContain('shell');
    expect((await serve('/assets/missing.js')).status).toBe(404);

    const etag = page.headers.get('etag')!;
    const notModified = await serve('/', { headers: { 'if-none-match': etag } });
    expect(notModified.status).toBe(304);
    expect(notModified.headers.get('vary')).toBe('accept-encoding');

    const head = await serve('/assets/index-D8j1YYcB.js', { method: 'HEAD' });
    expect(head.status).toBe(200);
    expect(head.headers.get('content-length')).toBe(String('console.log("hello")'.length));
    expect(await head.text()).toBe('');

    // Compression: Brotli when accepted, decoding to the exact stored bytes.
    const big = await serve('/big.js', { headers: { 'accept-encoding': 'br, gzip' } });
    expect(big.headers.get('content-encoding')).toBe('br');
    expect(big.headers.get('vary')).toBe('accept-encoding');
    const { brotliDecompressSync } = await import('node:zlib');
    expect(brotliDecompressSync(Buffer.from(await big.arrayBuffer())).toString()).toBe('x'.repeat(4096));
    expect((await serve('/big.js')).headers.get('content-encoding')).toBeNull();
    expect((await serve('/', { headers: { 'if-none-match': etag.replace(/^W\//, '') } })).status).toBe(304);

    const partial = await serve('/video.bin', { headers: { range: 'bytes=2-5' } });
    expect(partial.status).toBe(206);
    expect(partial.headers.get('content-range')).toBe('bytes 2-5/10');
    expect(await partial.text()).toBe('2345');
    expect((await serve('/video.bin', { headers: { range: 'bytes=50-60' } })).status).toBe(416);

    expect((await serve('/', { method: 'POST' })).status).toBe(405);

    // Error answers carry the Cloudflare no-store header like every App response.
    const missing = await serve('/assets/missing.js');
    expect(missing.status).toBe(404);
    expect(missing.headers.get('cloudflare-cdn-cache-control')).toBe('no-store');
    storage.objects.delete(blobKey(ACCOUNT_ID, createHash('sha256').update('0123456789').digest('hex')));
    resetStaticSiteCaches();
    const gone = await serve('/video.bin');
    expect(gone.status).toBe(503);
    expect(gone.headers.get('cloudflare-cdn-cache-control')).toBe('no-store');
    expect(gone.headers.get('retry-after')).toBe('5');
  });

  test('a body over 4 MiB is served uncompressed, and concurrent requests share one storage read', async () => {
    await seedDeployments(1, 'building');
    const storage = memoryStorage();
    let gets = 0;
    const get = storage.get.bind(storage);
    storage.get = async (key: string) => {
      gets += 1;
      await Bun.sleep(100); // a storage download takes time; requests arrive meanwhile
      return get(key);
    };
    const large = 'x'.repeat(MAX_COMPRESS_BYTES + 1);
    const root = await site({ 'data.json': large });
    roots.push(root);
    await publishStaticSite({ deploymentId: dep(1), accountId: ACCOUNT_ID, sourceDir: root, storage });
    const serve = () =>
      serveStaticDeployment({
        request: new Request('https://app.test/data.json?x=1', { headers: { 'accept-encoding': 'br, gzip' } }),
        url: new URL('https://app.test/data.json?x=1'),
        accountId: ACCOUNT_ID,
        deploymentId: dep(1),
        spa: false,
        publicApp: true,
        storage,
      });
    const responses = await Promise.all([serve(), serve(), serve()]);
    expect(gets).toBe(1);
    for (const response of responses) {
      expect(response.status).toBe(200);
      expect(response.headers.get('content-encoding')).toBeNull();
      expect(response.headers.get('content-length')).toBe(String(large.length));
    }
    expect(await responses[0]!.text()).toBe(large);
  });

  test('retention keeps the active and the newest N others, frees their files, keeps the history', async () => {
    await seedDeployments(8);
    await db.update(apps).set({ activeDeploymentId: dep(3) }).where(eq(apps.appId, APP_ID));
    for (let i = 1; i <= 8; i += 1) {
      await db.insert(appSiteFiles).values({
        deploymentId: dep(i), accountId: ACCOUNT_ID, path: 'index.html', sha256: `${i}`.repeat(64).slice(0, 64), sizeBytes: 1, contentType: 'text/html',
      });
      await db.insert(appDeploymentEvents).values([
        { deploymentId: dep(i), type: 'build_log', message: 'line' },
        { deploymentId: dep(i), type: 'deployment_activated', message: 'serving' },
      ]);
    }

    const retired = await retireSupersededDeployments(APP_ID, 3);

    // Kept: active v3 + the 3 newest others (v8, v7, v6). Retired: v5, v4, v2, v1.
    expect(retired.sort()).toEqual([dep(1), dep(2), dep(4), dep(5)].sort());
    const statuses = await db.select({ id: appDeployments.deploymentId, status: appDeployments.status })
      .from(appDeployments).where(eq(appDeployments.appId, APP_ID));
    const status = new Map(statuses.map((row) => [row.id, row.status]));
    expect([3, 6, 7, 8].map((n) => status.get(dep(n)))).toEqual(['ready', 'ready', 'ready', 'ready']);
    expect([1, 2, 4, 5].map((n) => status.get(dep(n)))).toEqual(['deleted', 'deleted', 'deleted', 'deleted']);
    const files = await db.select({ id: appSiteFiles.deploymentId }).from(appSiteFiles)
      .where(eq(appSiteFiles.accountId, ACCOUNT_ID));
    expect(files.map((row) => row.id).sort()).toEqual([dep(3), dep(6), dep(7), dep(8)].sort());
    const events = await db.select({ type: appDeploymentEvents.type }).from(appDeploymentEvents)
      .where(eq(appDeploymentEvents.deploymentId, dep(1)));
    expect(events.map((row) => row.type).sort()).toEqual(['deployment_activated', 'deployment_retired']);
    // Running it again retires nothing more.
    expect(await retireSupersededDeployments(APP_ID, 3)).toEqual([]);
  });

  test('batched build log lines read back in the order they were printed', async () => {
    await seedDeployments(1, 'building');
    const log = createBuildLog(dep(1));
    for (let i = 0; i < 450; i += 1) log.line(`line ${i}`);
    await log.close();
    const rows = await db.select({ message: appDeploymentEvents.message, level: appDeploymentEvents.level })
      .from(appDeploymentEvents)
      .where(and(eq(appDeploymentEvents.deploymentId, dep(1)), eq(appDeploymentEvents.type, 'build_log')))
      .orderBy(appDeploymentEvents.createdAt);
    expect(rows.map((row) => row.message)).toEqual(Array.from({ length: 450 }, (_, i) => `line ${i}`));
    expect(new Set(rows.map((row) => row.level))).toEqual(new Set(['debug']));
  });

  test('the sweep drops a failed deployment build log after 14 days and keeps its lifecycle events', async () => {
    await seedDeployments(3, 'failed');
    const daysAgo = (days: number) => new Date(Date.now() - days * 86_400_000);
    await db.update(appDeployments).set({ updatedAt: daysAgo(15) }).where(eq(appDeployments.deploymentId, dep(1)));
    await db.update(appDeployments).set({ updatedAt: daysAgo(13) }).where(eq(appDeployments.deploymentId, dep(2)));
    await db.update(appDeployments).set({ status: 'ready', updatedAt: daysAgo(30) }).where(eq(appDeployments.deploymentId, dep(3)));
    for (let i = 1; i <= 3; i += 1) {
      await db.insert(appDeploymentEvents).values([
        { deploymentId: dep(i), type: 'build_log', message: 'line' },
        { deploymentId: dep(i), type: 'deployment_failed', message: 'failed' },
      ]);
    }

    const result = await sweepAppRetention(5);

    expect(result.failedBuildLogLines).toBe(1);
    const left = await db.select({ id: appDeploymentEvents.deploymentId, type: appDeploymentEvents.type })
      .from(appDeploymentEvents)
      .where(inArray(appDeploymentEvents.deploymentId, [dep(1), dep(2), dep(3)]));
    const types = (n: number) => left.filter((row) => row.id === dep(n)).map((row) => row.type).sort();
    expect(types(1)).toEqual(['deployment_failed']);
    expect(types(2)).toEqual(['build_log', 'deployment_failed']);
    expect(types(3)).toEqual(['build_log', 'deployment_failed']);
  });

  test('a rollback racing retention never points the App at a retired deployment (50 runs)', async () => {
    for (let run = 0; run < 50; run += 1) {
      await db.update(apps).set({ activeDeploymentId: null }).where(eq(apps.appId, APP_ID));
      await db.delete(appDeployments).where(eq(appDeployments.appId, APP_ID));
      await seedDeployments(8);
      await db.update(apps).set({ activeDeploymentId: dep(8) }).where(eq(apps.appId, APP_ID));

      // keep=3 retires v1-v4; the rollback targets v1.
      const [retired, rolledBack] = await Promise.all([
        retireSupersededDeployments(APP_ID, 3),
        rollBackActiveDeployment(APP_ID, dep(1)),
      ]);

      const [row] = await db.select({ active: apps.activeDeploymentId }).from(apps).where(eq(apps.appId, APP_ID));
      const [target] = await db.select({ status: appDeployments.status }).from(appDeployments)
        .where(eq(appDeployments.deploymentId, row!.active!));
      expect(target?.status).toBe('ready');
      // Exactly one side won: either the rollback moved first (v1 is live and kept)
      // or retention did (v1 is retired and the rollback was refused).
      if (rolledBack) expect(retired).not.toContain(dep(1));
      else expect(retired).toContain(dep(1));
    }
  });

  test('a rollback to a deployment of another App, or one not ready, is refused', async () => {
    await seedDeployments(2);
    await db.update(appDeployments).set({ status: 'failed' }).where(eq(appDeployments.deploymentId, dep(2)));
    expect(await rollBackActiveDeployment(APP_ID, dep(2))).toBeNull();
    expect(await rollBackActiveDeployment('00000000-0000-4000-a000-00000000dfff', dep(1))).toBeNull();
    expect((await rollBackActiveDeployment(APP_ID, dep(1)))?.activeDeploymentId).toBe(dep(1));
  });

  test('blob reclaim removes only unreferenced blobs past the grace, from storage and the ledger', async () => {
    await seedDeployments(1);
    const storage = memoryStorage();
    const kept = 'a'.repeat(64);
    const orphan = 'b'.repeat(64);
    const fresh = 'c'.repeat(64);
    for (const sha of [kept, orphan, fresh]) storage.objects.set(blobKey(ACCOUNT_ID, sha), new Uint8Array([1]));
    await db.insert(appSiteBlobs).values([
      { accountId: ACCOUNT_ID, sha256: kept, sizeBytes: 1, createdAt: new Date(Date.now() - 3 * 3600_000) },
      { accountId: ACCOUNT_ID, sha256: orphan, sizeBytes: 1, createdAt: new Date(Date.now() - 3 * 3600_000) },
      { accountId: ACCOUNT_ID, sha256: fresh, sizeBytes: 1 },
    ]);
    await db.insert(appSiteFiles).values({
      deploymentId: dep(1), accountId: ACCOUNT_ID, path: 'index.html', sha256: kept, sizeBytes: 1, contentType: 'text/html',
    });

    const result = await reclaimAppSiteBlobs(storage);

    expect(result.reclaimed).toBeGreaterThanOrEqual(1);
    expect(storage.objects.has(blobKey(ACCOUNT_ID, orphan))).toBe(false);
    expect(storage.objects.has(blobKey(ACCOUNT_ID, kept))).toBe(true);
    expect(storage.objects.has(blobKey(ACCOUNT_ID, fresh))).toBe(true);
    const left = await db.select({ sha: appSiteBlobs.sha256 }).from(appSiteBlobs)
      .where(and(eq(appSiteBlobs.accountId, ACCOUNT_ID), inArray(appSiteBlobs.sha256, [kept, orphan, fresh])));
    expect(left.map((row) => row.sha).sort()).toEqual([kept, fresh].sort());
  });

  test('a failed object delete keeps the ledger rows, so the next pass retries', async () => {
    const orphan = 'd'.repeat(64);
    await db.insert(appSiteBlobs).values({ accountId: ACCOUNT_ID, sha256: orphan, sizeBytes: 1, createdAt: new Date(Date.now() - 3 * 3600_000) });
    const failing: SiteStorage = { put: async () => {}, get: async () => null, remove: async () => { throw new Error('storage down'); } };
    await expect(reclaimAppSiteBlobs(failing)).rejects.toThrow('storage down');
    const [row] = await db.select({ n: sql<number>`count(*)::int` }).from(appSiteBlobs)
      .where(and(eq(appSiteBlobs.accountId, ACCOUNT_ID), eq(appSiteBlobs.sha256, orphan)));
    expect(row!.n).toBe(1);
  });
});

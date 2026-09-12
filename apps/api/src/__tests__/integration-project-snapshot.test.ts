/**
 * Integration (real local Postgres + real S3-compatible storage): the project
 * snapshot PRODUCER end to end — enqueue → worker claim → build from the Git
 * mirror → conditional publish (archive, then manifest) → readiness row — and
 * the descriptor the Git proxy hands a sandbox.
 *
 * Runs the PRODUCTION code paths (project-snapshot.ts, project-snapshot-store.ts,
 * project-snapshot-worker.ts) against a real bucket through the AWS SDK with an
 * endpoint override (local MinIO). Nothing is mocked. Assertions read the
 * actual objects back (HeadObject / GetObject) and the actual ledger rows.
 *
 * Required environment (the run FAILS, never skips, when it is missing):
 *   DATABASE_URL                              local Postgres
 *   KORTIX_PROJECT_SNAPSHOT_S3_BUCKET/…       a reachable S3-compatible bucket
 *
 * Run:
 *   cd apps/api && KORTIX_PROJECT_SNAPSHOT_S3_BUCKET=kortix-project-snapshots-test \
 *     dotenvx run --ignore=MISSING_ENV_FILE -f .env.local -f .env -- \
 *     bun test --isolate src/__tests__/integration-project-snapshot.test.ts
 */
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { eq, sql } from 'drizzle-orm';
import { HeadBucketCommand } from '@aws-sdk/client-s3';
import { projectGitConnections, projectSnapshotArchives, projects } from '@kortix/db';
import { db } from '../shared/db';
import { config } from '../config';
import {
  enqueueProjectSnapshot,
  normalizeSnapshotRef,
  readProjectSnapshot,
  readReadyProjectSnapshot,
  resolveProjectSnapshotPinForSession,
  retryProjectSnapshot,
} from '../git-proxy/project-snapshot';
import { runProjectSnapshotWorkerOnce } from '../git-proxy/project-snapshot-worker';
import {
  __resetProjectSnapshotS3ClientForTests,
  getObjectText,
  headObject,
  presignProjectSnapshotDownload,
  projectSnapshotArchiveKey,
  projectSnapshotBucket,
  projectSnapshotManifestKey,
  projectSnapshotS3Client,
  projectSnapshotStorageConfigured,
} from '../git-proxy/project-snapshot-store';

const WORKER = `integration-${process.pid}`;
let root = '';
let remote = '';
let accountId = '';
const projectIds: string[] = [];
let projectId = '';
let firstSha = '';
let secondSha = '';

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, {
    cwd,
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'Snapshot Integration',
      GIT_AUTHOR_EMAIL: 'snapshot-it@kortix.test',
      GIT_COMMITTER_NAME: 'Snapshot Integration',
      GIT_COMMITTER_EMAIL: 'snapshot-it@kortix.test',
    },
    encoding: 'utf8',
  }).trim();
}

beforeAll(async () => {
  if (!process.env.DATABASE_URL) throw new Error('integration-project-snapshot: DATABASE_URL is required (local Postgres)');
  if (!projectSnapshotStorageConfigured()) {
    throw new Error('integration-project-snapshot: KORTIX_PROJECT_SNAPSHOT_S3_BUCKET (+ endpoint/credentials) is required — start local MinIO and set the KORTIX_PROJECT_SNAPSHOT_S3_* variables');
  }
  __resetProjectSnapshotS3ClientForTests();
  await projectSnapshotS3Client().send(new HeadBucketCommand({ Bucket: projectSnapshotBucket() }));

  const rows = (await db.execute(sql`select account_id from kortix.accounts limit 1`)) as unknown as Array<{ account_id: string }>;
  if (!rows[0]) throw new Error('integration-project-snapshot: no account in the local DB — seed one first');
  accountId = rows[0].account_id;

  // A real bare upstream on disk; the API's mirror clones it over file://.
  root = mkdtempSync(join(tmpdir(), 'kortix-snapshot-it-'));
  remote = join(root, 'remote.git');
  git(root, 'init', '-q', '--bare', '-b', 'main', remote);
  const work = join(root, 'work');
  git(root, 'clone', '-q', remote, work);
  git(work, 'checkout', '-q', '-b', 'main');
  writeFileSync(join(work, 'README.md'), 'snapshot integration v1\n');
  mkdirSync(join(work, 'src'));
  for (let i = 0; i < 20; i += 1) writeFileSync(join(work, 'src', `f${i}.txt`), `${'v1 '.repeat(200)}\n`);
  git(work, 'add', '-A');
  git(work, 'commit', '-q', '-m', 'v1');
  git(work, 'push', '-q', 'origin', 'main');
  firstSha = git(work, 'rev-parse', 'HEAD');
  writeFileSync(join(work, 'README.md'), 'snapshot integration v2\n');
  git(work, 'commit', '-q', '-am', 'v2');
  git(work, 'push', '-q', 'origin', 'main');
  secondSha = git(work, 'rev-parse', 'HEAD');

  projectId = crypto.randomUUID();
  projectIds.push(projectId);
  await db.insert(projects).values({
    projectId,
    accountId,
    name: 'snapshot-integration',
    repoUrl: remote,
    defaultBranch: 'main',
  });
  await db.insert(projectGitConnections).values({
    accountId,
    projectId,
    provider: 'git',
    repoUrl: remote,
    upstreamUrl: remote,
    repoOwner: 'kortix-it',
    repoName: 'snapshot-integration',
    externalRepoId: '990001',
    defaultBranch: 'main',
    authMethod: 'none',
  });
});

afterAll(async () => {
  for (const id of projectIds) {
    await db.delete(projects).where(eq(projects.projectId, id)).catch(() => {});
  }
  if (root) rmSync(root, { recursive: true, force: true });
});

async function drainWorker(maxPasses = 5): Promise<Awaited<ReturnType<typeof runProjectSnapshotWorkerOnce>>> {
  const all: Awaited<ReturnType<typeof runProjectSnapshotWorkerOnce>> = [];
  for (let i = 0; i < maxPasses; i += 1) {
    const processed = await runProjectSnapshotWorkerOnce(WORKER, 10);
    all.push(...processed);
    if (processed.length === 0) break;
  }
  return all;
}

describe('project snapshot producer (real DB + real bucket)', () => {
  test('enqueue is idempotent per (project, sha) and normalizes the ref', async () => {
    expect(await enqueueProjectSnapshot({ projectId, ref: 'refs/heads/main', commitSha: firstSha, repoUrl: remote })).toBe('queued');
    expect(await enqueueProjectSnapshot({ projectId, ref: 'main', commitSha: firstSha, repoUrl: remote })).toBe('exists');
    const row = await readProjectSnapshot(projectId, firstSha);
    expect(row).toMatchObject({ status: 'queued', ref: 'main', repoOwner: 'kortix-it', repoName: 'snapshot-integration', externalRepoId: '990001' });
    expect(normalizeSnapshotRef('refs/heads/main')).toBe('main');
  });

  test('the worker builds, publishes archive-then-manifest, and flips the row to ready', async () => {
    const processed = await drainWorker();
    const mine = processed.find((p) => p.commitSha === firstSha);
    expect(mine?.outcome).toBe('ready');
    expect(mine?.archive).toBe('created');

    const ready = await readReadyProjectSnapshot(projectId, firstSha);
    expect(ready).not.toBeNull();
    expect(ready!.objectPrefix).toBe(`kortix-it/snapshot-integration/${firstSha}/990001/project-snapshot-v1/`);
    expect(ready!.archiveBytes).toBeGreaterThan(0);
    expect(ready!.entryCount).toBeGreaterThan(20);

    // The actual objects, not the exit code.
    const archiveKey = projectSnapshotArchiveKey(ready!.objectPrefix, ready!.archiveSha256);
    const head = await headObject(archiveKey);
    expect(head?.bytes).toBe(ready!.archiveBytes);
    const manifest = JSON.parse((await getObjectText(projectSnapshotManifestKey(ready!.objectPrefix))) ?? '{}');
    expect(manifest).toMatchObject({
      format: 'project-snapshot-v1',
      commit_sha: firstSha,
      ref: 'main',
      repository: { owner: 'kortix-it', name: 'snapshot-integration', external_id: '990001' },
      archive: { key: archiveKey, sha256: ready!.archiveSha256, bytes: ready!.archiveBytes, container: 'tar', compression: 'gzip' },
    });
  });

  test('the presigned descriptor URL downloads exactly the published bytes, with no credential', async () => {
    const ready = await readReadyProjectSnapshot(projectId, firstSha);
    const archiveKey = projectSnapshotArchiveKey(ready!.objectPrefix, ready!.archiveSha256);
    const { url, expiresAt } = await presignProjectSnapshotDownload(archiveKey, 120);
    expect(expiresAt.getTime()).toBeGreaterThan(Date.now());
    const res = await fetch(url);
    expect(res.status).toBe(200);
    const bytes = Buffer.from(await res.arrayBuffer());
    expect(bytes.byteLength).toBe(ready!.archiveBytes);
    expect(createHash('sha256').update(bytes).digest('hex')).toBe(ready!.archiveSha256);
    // The archive really is a sanitized checkout at that commit.
    const dir = join(root, 'extract');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(root, 'dl.tar.gz'), bytes);
    execFileSync('tar', ['-xzf', join(root, 'dl.tar.gz'), '-C', dir]);
    expect(git(dir, 'rev-parse', 'HEAD')).toBe(firstSha);
    expect(git(dir, 'remote')).toBe('');
    expect(git(dir, 'status', '--porcelain')).toBe('');
  });

  test('session pin lookup: hit for a ready sha, miss (and enqueue) for a new one', async () => {
    const hit = await resolveProjectSnapshotPinForSession({ projectId, ref: 'main', commitSha: firstSha, repoUrl: remote });
    expect(hit.cache).toBe('hit');
    expect(hit.pin).toMatch(new RegExp(`^${firstSha}:[0-9a-f]{64}:\\d+$`));
    const miss = await resolveProjectSnapshotPinForSession({ projectId, ref: 'main', commitSha: secondSha, repoUrl: remote });
    expect(miss).toEqual({ pin: null, cache: 'miss' });
    // The miss queued the build for the next session; give the fire-and-forget insert a tick.
    await new Promise((r) => setTimeout(r, 200));
    expect((await readProjectSnapshot(projectId, secondSha))?.status).toBe('queued');
  });

  test('an overlapping revision update produces its own ready row and never touches the older one', async () => {
    const before = await readProjectSnapshot(projectId, firstSha);
    const processed = await drainWorker();
    expect(processed.find((p) => p.commitSha === secondSha)?.outcome).toBe('ready');
    const after = await readProjectSnapshot(projectId, firstSha);
    expect(after?.status).toBe('ready');
    expect(after?.archiveSha256).toBe(before?.archiveSha256);
    expect(after?.readyAt?.getTime()).toBe(before?.readyAt?.getTime());
    const second = await readReadyProjectSnapshot(projectId, secondSha);
    expect(second?.archiveSha256).not.toBe(after?.archiveSha256);
  });

  test('a duplicate build of a ready sha reuses the published objects (idempotent, no overwrite)', async () => {
    const ready = await readReadyProjectSnapshot(projectId, firstSha);
    const archiveKey = projectSnapshotArchiveKey(ready!.objectPrefix, ready!.archiveSha256);
    const etagBefore = (await headObject(archiveKey))?.etag;
    // Force a rebuild attempt through the same worker path.
    await db
      .update(projectSnapshotArchives)
      .set({ status: 'queued', nextAttemptAt: new Date(), lockedBy: null, lockedUntil: null })
      .where(eq(projectSnapshotArchives.snapshotId, ready!.snapshotId));
    const processed = await drainWorker();
    const again = processed.find((p) => p.commitSha === firstSha);
    expect(again?.outcome).toBe('ready');
    expect(again?.archive).toBe('exists');
    expect((await headObject(archiveKey))?.etag).toBe(etagBefore);
    expect((await readReadyProjectSnapshot(projectId, firstSha))?.archiveSha256).toBe(ready!.archiveSha256);
  });

  test('a failed upload leaves no readiness behind and is retried, not published partially', async () => {
    const thirdProject = crypto.randomUUID();
    projectIds.push(thirdProject);
    await db.insert(projects).values({ projectId: thirdProject, accountId, name: 'snapshot-fail', repoUrl: remote, defaultBranch: 'main' });
    await db.insert(projectGitConnections).values({
      accountId,
      projectId: thirdProject,
      provider: 'git',
      repoUrl: remote,
      upstreamUrl: remote,
      repoOwner: 'kortix-it',
      repoName: 'snapshot-fail',
      externalRepoId: '990002',
      defaultBranch: 'main',
      authMethod: 'none',
    });
    expect(await enqueueProjectSnapshot({ projectId: thirdProject, ref: 'main', commitSha: firstSha, repoUrl: remote })).toBe('queued');

    // Point the producer at a bucket that does not exist for ONE pass.
    const realBucket = config.KORTIX_PROJECT_SNAPSHOT_S3_BUCKET;
    (config as { KORTIX_PROJECT_SNAPSHOT_S3_BUCKET: string }).KORTIX_PROJECT_SNAPSHOT_S3_BUCKET = `${realBucket}-does-not-exist`;
    __resetProjectSnapshotS3ClientForTests();
    let failed: Awaited<ReturnType<typeof runProjectSnapshotWorkerOnce>>;
    try {
      failed = await runProjectSnapshotWorkerOnce(WORKER, 10);
    } finally {
      (config as { KORTIX_PROJECT_SNAPSHOT_S3_BUCKET: string }).KORTIX_PROJECT_SNAPSHOT_S3_BUCKET = realBucket;
      __resetProjectSnapshotS3ClientForTests();
    }
    const attempt = failed.find((p) => p.projectId === thirdProject);
    expect(attempt?.outcome).toBe('requeued');
    const row = await readProjectSnapshot(thirdProject, firstSha);
    expect(row?.status).toBe('queued');
    expect(row?.attempts).toBe(1);
    expect(row?.lastError).toBeTruthy();
    expect(row?.readyAt).toBeNull();
    expect(await readReadyProjectSnapshot(thirdProject, firstSha)).toBeNull();
    // Nothing advertised for that project's prefix in the real bucket.
    expect(await getObjectText(`kortix-it/snapshot-fail/${firstSha}/990002/project-snapshot-v1/manifest.json`)).toBeNull();

    // Retry now (the backoff would otherwise wait 30 s) and succeed.
    expect(await retryProjectSnapshot(thirdProject, firstSha)).toBe(true);
    const recovered = await drainWorker();
    expect(recovered.find((p) => p.projectId === thirdProject)?.outcome).toBe('ready');
    expect((await readReadyProjectSnapshot(thirdProject, firstSha))?.archiveBytes).toBeGreaterThan(0);
  });
});

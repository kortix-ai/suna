/**
 * Publication lifecycle against the real database: deduplication, two
 * publishers racing one lease, crash-before-readiness, retry budget, the
 * desired-vs-ready separation that stops an old build replacing a new revision,
 * and the REAL worker driving a queued revision all the way to two durable
 * objects in the store.
 *
 * Run:
 *   cd apps/api && dotenvx run -- bun test --isolate src/__tests__/integration-repo-snapshot-lifecycle.test.ts
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { sql } from 'drizzle-orm';
import { db } from '../shared/db';
import { normalizeRepoSnapshotIdentity, type RepoSnapshotManifest, payloadKey } from '../repo-snapshots/format';
import {
  REPO_SNAPSHOT_MAX_ATTEMPTS,
  beginRefObservation,
  claimRepoSnapshot,
  enqueueRepoSnapshot,
  findReadyRepoSnapshot,
  findRepoSnapshot,
  markRepoSnapshotAttemptFailed,
  markRepoSnapshotReady,
  observeRepoRef,
  readRepoRef,
  renewRepoSnapshotLease,
  repoSnapshotRetryDelayMs,
  requeueRepoSnapshot,
} from '../repo-snapshots/store';

let hasDb = false;
let hasStorage = false;
const repositoryId = String(800000000 + Math.floor(Math.random() * 90000000));
/** Every synthetic repository id this file creates rows for, so none is left behind. */
const createdRepositoryIds: string[] = [repositoryId];
const shaA = 'a'.repeat(39) + '1';
const shaB = 'b'.repeat(39) + '2';

function identityFor(commitSha: string) {
  return normalizeRepoSnapshotIdentity({ repositoryId, owner: 'kortix-ai', repo: 'lifecycle', commitSha });
}

function manifestFor(commitSha: string): RepoSnapshotManifest {
  const identity = identityFor(commitSha);
  const digest = commitSha.repeat(2).slice(0, 64);
  return {
    format: 'kortix.project-snapshot.v1',
    source: {
      provider: 'github',
      repository_id: identity.repositoryId,
      owner: identity.owner,
      repo: identity.repo,
      commit_sha: identity.commitSha,
      tree_sha: 'c'.repeat(40),
    },
    payload: {
      key: payloadKey(identity, digest, 'gzip'),
      compression: 'gzip',
      sha256: digest,
      compressed_bytes: 100,
      expanded_bytes: 200,
      entry_count: 5,
    },
    checkout: { git_metadata: 'sanitized-shallow', layout_version: 1 },
    producer_version: 'lifecycle-test',
  };
}

beforeAll(async () => {
  try {
    await db.execute(sql`select 1 from kortix.repo_snapshots limit 1`);
    hasDb = true;
  } catch {
    hasDb = false;
  }
  try {
    const { requireRepoSnapshotBucket, s3HeadObject } = await import('../repo-snapshots/s3');
    await s3HeadObject(requireRepoSnapshotBucket(), `preflight/${crypto.randomUUID()}`);
    hasStorage = true;
  } catch {
    hasStorage = false;
  }
});

afterAll(async () => {
  if (!hasDb) return;
  for (const id of createdRepositoryIds) {
    await db.execute(sql`delete from kortix.repo_snapshots where repository_id = ${id}`).catch(() => {});
    await db.execute(sql`delete from kortix.repo_snapshot_refs where repository_id = ${id}`).catch(() => {});
  }
});

describe('the real worker publishes a queued revision', () => {
  test('queued -> leased -> built -> uploaded -> ready, with both objects durable', async () => {
    if (!hasDb || !hasStorage) return;
    const { execFileSync } = await import('node:child_process');
    const { mkdirSync, mkdtempSync, rmSync, writeFileSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');

    const root = mkdtempSync(join(tmpdir(), 'kortix-worker-lifecycle-'));
    const upstream = join(root, 'upstream');
    mkdirSync(upstream);
    const git = (...args: string[]) =>
      execFileSync('git', args, {
        cwd: upstream,
        env: {
          ...process.env,
          GIT_AUTHOR_NAME: 'Worker Fixture',
          GIT_AUTHOR_EMAIL: 'worker@example.invalid',
          GIT_COMMITTER_NAME: 'Worker Fixture',
          GIT_COMMITTER_EMAIL: 'worker@example.invalid',
        },
        encoding: 'utf8',
      }).trim();
    git('init', '-b', 'main');
    writeFileSync(join(upstream, 'kortix.yaml'), 'kortix_version: 2\n');
    git('add', '-A');
    git('commit', '-m', 'worker fixture');
    const workerSha = git('rev-parse', 'HEAD');

    const accounts = (await db.execute(
      sql`select account_id from kortix.accounts limit 1`,
    )) as unknown as Array<{ account_id: string }>;
    if (!accounts[0]) {
      rmSync(root, { recursive: true, force: true });
      return;
    }
    const projectId = crypto.randomUUID();
    const workerRepositoryId = String(980000000 + Math.floor(Math.random() * 9000000));
    createdRepositoryIds.push(workerRepositoryId);
    await db.execute(sql`
      insert into kortix.projects (project_id, account_id, name, repo_url, default_branch, manifest_path, status, metadata)
      values (${projectId}, ${accounts[0].account_id}, 'repo-snapshot-worker', ${`file://${upstream}`},
              'main', 'kortix.yaml', 'active',
              ${JSON.stringify({
                git: {
                  provider: 'github',
                  owner: 'kortix-ai',
                  name: 'worker-fixture',
                  external_repo_id: workerRepositoryId,
                  // GitHub IDENTITY with a local SOURCE: `resolveUpstreamUrl`
                  // prefers an explicit upstream_url, so the fixture keeps the
                  // repository id the object key needs without pointing the
                  // producer at a repository that does not exist.
                  upstream_url: `file://${upstream}`,
                  auth: { method: 'none' },
                },
              })}::jsonb)`);

    const cache = mkdtempSync(join(tmpdir(), 'kortix-worker-mirror-'));
    const previousCache = process.env.KORTIX_GIT_CACHE_DIR;
    process.env.KORTIX_GIT_CACHE_DIR = cache;
    try {
      const { runRepoSnapshotTick } = await import('../repo-snapshots/worker');
      const { requireRepoSnapshotBucket, s3HeadObject } = await import('../repo-snapshots/s3');
      const identity = normalizeRepoSnapshotIdentity({
        repositoryId: workerRepositoryId,
        owner: 'kortix-ai',
        repo: 'worker-fixture',
        commitSha: workerSha,
      });
      const queued = await enqueueRepoSnapshot({ identity, sourceProjectId: projectId, sourceRef: 'main' });
      expect(queued.status).toBe('queued');

      const ticked = await runRepoSnapshotTick();
      expect(ticked.published).toBeGreaterThan(0);

      const row = await findRepoSnapshot(identity);
      expect(row?.status).toBe('ready');
      expect(row?.errorCode).toBeNull();
      expect(row?.payloadKey).toBeTruthy();
      expect(row?.manifestKey).toBeTruthy();

      // The ROW is not the artifact. Both objects must actually be in the store.
      const bucket = requireRepoSnapshotBucket();
      const payload = await s3HeadObject(bucket, row!.payloadKey!);
      const manifest = await s3HeadObject(bucket, row!.manifestKey!);
      expect(payload?.contentLength).toBe(row!.compressedBytes);
      expect(manifest?.contentLength).toBeGreaterThan(0);

      // The key carries the requested identity components, in order.
      expect(row!.payloadKey).toContain(
        `kortix-ai/worker-fixture/${workerSha}/${workerRepositoryId}/project-snapshot-v1/`,
      );
      expect(row!.payloadKey!.endsWith(`${row!.archiveSha256}.tar.gz`)).toBe(true);
    } finally {
      if (previousCache) process.env.KORTIX_GIT_CACHE_DIR = previousCache;
      else delete process.env.KORTIX_GIT_CACHE_DIR;
      await db.execute(sql`delete from kortix.repo_snapshots where repository_id = ${workerRepositoryId}`).catch(() => {});
      await db.execute(sql`delete from kortix.projects where project_id = ${projectId}`).catch(() => {});
      rmSync(root, { recursive: true, force: true });
      rmSync(cache, { recursive: true, force: true });
    }
  }, 180_000);
});

describe('repo snapshot publication lifecycle', () => {
  test('duplicate enqueues collapse onto one row', async () => {
    if (!hasDb) return;
    const identity = identityFor(shaA);
    const first = await enqueueRepoSnapshot({ identity, sourceRef: 'main' });
    const second = await enqueueRepoSnapshot({ identity, sourceRef: 'main' });
    const third = await enqueueRepoSnapshot({ identity, sourceRef: 'refs/heads/main' });
    expect(second.snapshotId).toBe(first.snapshotId);
    expect(third.snapshotId).toBe(first.snapshotId);
    const rows = (await db.execute(
      sql`select count(*)::int as n from kortix.repo_snapshots where repository_id = ${repositoryId}`,
    )) as unknown as Array<{ n: number }>;
    expect(rows[0]?.n).toBe(1);
  });

  test('only one publisher holds the lease; the loser cannot write readiness', async () => {
    if (!hasDb) return;
    const winner = await claimRepoSnapshot('owner-a');
    expect(winner?.status).toBe('building');
    // A second worker finds nothing claimable while the lease is live.
    expect(await claimRepoSnapshot('owner-b')).toBeNull();
    // …and cannot renew or complete a lease it does not hold.
    await expect(renewRepoSnapshotLease(winner!.snapshotId, 'owner-b')).rejects.toThrow(/lost/);
    expect(
      await markRepoSnapshotReady({
        snapshotId: winner!.snapshotId,
        owner: 'owner-b',
        manifest: manifestFor(shaA),
        manifestKey: 'ignored',
      }),
    ).toBeNull();

    const ready = await markRepoSnapshotReady({
      snapshotId: winner!.snapshotId,
      owner: 'owner-a',
      manifest: manifestFor(shaA),
      manifestKey: `kortix-ai/lifecycle/${shaA}/${repositoryId}/project-snapshot-v1/manifest.json`,
    });
    expect(ready?.status).toBe('ready');
    expect(ready?.archiveSha256).toBe(manifestFor(shaA).payload.sha256);
    expect(ready?.leaseOwner).toBeNull();
  });

  test('a ready row is never re-queued or downgraded by another enqueue', async () => {
    if (!hasDb) return;
    const identity = identityFor(shaA);
    const again = await enqueueRepoSnapshot({ identity, sourceRef: 'main' });
    expect(again.status).toBe('ready');
    expect(await claimRepoSnapshot('owner-c')).toBeNull();
    expect(await requeueRepoSnapshot(again.snapshotId)).toBeNull();
    expect((await findReadyRepoSnapshot(identity))?.status).toBe('ready');
  });

  test('a crash before readiness retries with backoff, then fails terminally', async () => {
    if (!hasDb) return;
    const identity = identityFor(shaB);
    await enqueueRepoSnapshot({ identity, sourceRef: 'main' });
    for (let attempt = 1; attempt <= REPO_SNAPSHOT_MAX_ATTEMPTS; attempt++) {
      const claimed = await claimRepoSnapshot(`owner-${attempt}`);
      expect(claimed?.attemptCount).toBe(attempt);
      await markRepoSnapshotAttemptFailed({
        snapshotId: claimed!.snapshotId,
        owner: `owner-${attempt}`,
        attempt,
        code: 'Error',
        message: 'transient',
        terminal: false,
      });
      const row = await findRepoSnapshot(identity);
      if (attempt < REPO_SNAPSHOT_MAX_ATTEMPTS) {
        expect(row?.status).toBe('queued');
        // Backed off: it is not immediately claimable again.
        expect(row?.nextAttemptAt).not.toBeNull();
        expect(await claimRepoSnapshot('eager')).toBeNull();
        // Move the clock forward the way the scheduler would.
        await db.execute(
          sql`update kortix.repo_snapshots set next_attempt_at = now() - interval '1 second'
              where snapshot_id = ${row!.snapshotId}`,
        );
      } else {
        expect(row?.status).toBe('failed');
        expect(row?.error).toBe('transient');
      }
    }
    expect(repoSnapshotRetryDelayMs(1)).toBeLessThan(repoSnapshotRetryDelayMs(3));
    // An operator can put a terminally failed revision back in the queue.
    const failed = await findRepoSnapshot(identity);
    expect((await requeueRepoSnapshot(failed!.snapshotId))?.status).toBe('queued');
  });

  test('a permanent failure stops immediately instead of burning the budget', async () => {
    if (!hasDb) return;
    const identity = identityFor(shaB);
    const claimed = await claimRepoSnapshot('owner-permanent');
    await markRepoSnapshotAttemptFailed({
      snapshotId: claimed!.snapshotId,
      owner: 'owner-permanent',
      attempt: 1,
      code: 'RepoSnapshotSourceMovedError',
      message: 'commit is unreachable',
      terminal: true,
    });
    const row = await findRepoSnapshot(identity);
    expect(row?.status).toBe('failed');
    expect(row?.errorCode).toBe('RepoSnapshotSourceMovedError');
    expect(row?.nextAttemptAt).toBeNull();
  });

  test('desired revision advances independently of what is ready', async () => {
    if (!hasDb) return;
    const base = { provider: 'github' as const, repositoryId, owner: 'kortix-ai', repo: 'lifecycle' };
    const first = await observeRepoRef({ identity: base, ref: 'main', desiredSha: shaA, via: 'webhook' });
    const second = await observeRepoRef({ identity: base, ref: 'main', desiredSha: shaB, via: 'reconcile' });
    expect(second.revision).toBeGreaterThan(first.revision);
    expect(second.desiredSha).toBe(shaB);
    // shaA is the READY one; the desired revision has already moved past it, so
    // a slow shaA build can never present itself as current.
    expect((await findReadyRepoSnapshot(identityFor(shaA)))?.commitSha).toBe(shaA);
    expect((await readRepoRef(base, 'main'))?.desiredSha).toBe(shaB);

    // A deleted branch clears the desired revision rather than leaving a stale one.
    const cleared = await observeRepoRef({ identity: base, ref: 'main', desiredSha: null, via: 'webhook' });
    expect(cleared.desiredSha).toBeNull();
    expect(cleared.revision).toBeGreaterThan(second.revision);
  });
});

/**
 * Ordering between a ref lookup that started earlier and one that finished
 * first, against the real table.
 *
 * These are the races that erase a good revision: a 404 that was already in
 * flight when the branch came back, and a reconcile that overtakes a webhook.
 * Ordering is a database generation, not a clock — two replicas disagree about
 * time, and two observations inside one millisecond are indistinguishable by it.
 */
describe('observation ordering is a generation, not a clock', () => {
  const raceRepositoryId = String(700000000 + Math.floor(Math.random() * 90000000));
  createdRepositoryIds.push(raceRepositoryId);
  const identity = { provider: 'github' as const, repositoryId: raceRepositoryId, owner: 'kortix-ai', repo: 'race' };
  const ref = `race-${Math.floor(Math.random() * 1e6)}`;
  const shaA = '1'.repeat(40);
  const shaB = '2'.repeat(40);
  const shaC = '3'.repeat(40);

  afterAll(async () => {
    if (!hasDb) return;
    await db
      .execute(sql`delete from kortix.repo_snapshot_refs where repository_id = ${raceRepositoryId}`)
      .catch(() => {});
  });

  test('a delayed 404 cannot erase a branch recreated while it was in flight', async () => {
    if (!hasDb) return;
    // A looks up a ref that does not exist yet, so it holds a null generation.
    const late404 = await beginRefObservation(identity, ref);
    expect(late404.generation).toBeNull();

    // Meanwhile the branch is created and someone records it.
    const created = await beginRefObservation(identity, ref);
    await observeRepoRef({ identity, ref, desiredSha: shaB, via: 'webhook', token: created });
    expect((await readRepoRef(identity, ref))?.desiredSha).toBe(shaB);

    // A finally returns 404. A null generation is an assertion that the ref was
    // unknown, so the write is insert-only and loses to the row that now exists.
    const row = await observeRepoRef({ identity, ref, desiredSha: null, via: 'reconcile', token: late404 });
    expect(row.desiredSha).toBe(shaB);
    expect((await readRepoRef(identity, ref))?.desiredSha).toBe(shaB);
  });

  test('a stale-generation deletion cannot erase a newer revision', async () => {
    if (!hasDb) return;
    const stale = await beginRefObservation(identity, ref);
    expect(stale.generation).not.toBeNull();

    const fresh = await beginRefObservation(identity, ref);
    await observeRepoRef({ identity, ref, desiredSha: shaA, via: 'webhook', token: fresh });

    const row = await observeRepoRef({ identity, ref, desiredSha: null, via: 'reconcile', token: stale });
    expect(row.desiredSha).toBe(shaA);
  });

  test('a stale-generation observation cannot overwrite a newer SHA', async () => {
    if (!hasDb) return;
    const stale = await beginRefObservation(identity, ref);
    const fresh = await beginRefObservation(identity, ref);
    await observeRepoRef({ identity, ref, desiredSha: shaB, via: 'webhook', token: fresh });

    const row = await observeRepoRef({ identity, ref, desiredSha: shaC, via: 'reconcile', token: stale });
    expect(row.desiredSha).toBe(shaB);
  });

  test('consecutive observations both apply, whatever the clock says', async () => {
    if (!hasDb) return;
    // Back to back, inside the same millisecond as far as any timestamp is
    // concerned. A time comparison drops the second one; a generation does not.
    const first = await beginRefObservation(identity, ref);
    const one = await observeRepoRef({ identity, ref, desiredSha: shaA, via: 'webhook', token: first });
    const second = await beginRefObservation(identity, ref);
    const two = await observeRepoRef({ identity, ref, desiredSha: shaC, via: 'webhook', token: second });

    expect(Number(two.revision)).toBe(Number(one.revision) + 1);
    expect(two.desiredSha).toBe(shaC);
  });

  test('a deletion with the current generation does apply', async () => {
    if (!hasDb) return;
    const token = await beginRefObservation(identity, ref);
    const row = await observeRepoRef({ identity, ref, desiredSha: null, via: 'reconcile', token });
    expect(row.desiredSha).toBeNull();
    // And it keeps a deadline, or the due scan would never look at it again.
    const scheduled = await observeRepoRef({
      identity,
      ref,
      desiredSha: null,
      via: 'reconcile',
      reconcileAfter: new Date(Date.now() + 60_000),
      token: await beginRefObservation(identity, ref),
    });
    expect(scheduled.reconcileAfter).not.toBeNull();
  });
});

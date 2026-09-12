/**
 * Publication lifecycle against the real database: deduplication, two
 * publishers racing one lease, crash-before-readiness, retry budget, and the
 * desired-vs-ready separation that stops an old build replacing a new revision.
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
const repositoryId = String(800000000 + Math.floor(Math.random() * 90000000));
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
});

afterAll(async () => {
  if (!hasDb) return;
  await db.execute(sql`delete from kortix.repo_snapshots where repository_id = ${repositoryId}`).catch(() => {});
  await db.execute(sql`delete from kortix.repo_snapshot_refs where repository_id = ${repositoryId}`).catch(() => {});
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

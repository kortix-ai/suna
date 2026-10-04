/**
 * Integration test (real local PostgreSQL): one replica holds the build of a
 * snapshot identity; another replica's claim fails until the holder releases
 * it or the claim expires. A lease row with another owner is exactly what the
 * other replica writes, so the test writes that row itself.
 */
import { expect, test } from 'bun:test';
import { workerLeaderLease } from '@kortix/db';
import { eq, sql } from 'drizzle-orm';
import { db } from '../lib/db';
import { claimSnapshotBuild, releaseSnapshotBuild, waitForSnapshotBuildRelease } from '../snapshots/build-claim';

const otherReplicaHolds = (key: string, expiresInSeconds: number) =>
  db.insert(workerLeaderLease).values({
    lockKey: `snapshot-build:${key}`,
    ownerId: 'other-replica',
    expiresAt: sql`now() + make_interval(secs => ${expiresInSeconds})`,
  });

// async: a drizzle query runs only once awaited.
async function dropOtherReplica(key: string): Promise<void> {
  await db.delete(workerLeaderLease).where(eq(workerLeaderLease.lockKey, `snapshot-build:${key}`));
}

test('a build another replica holds is not claimed; once it releases, the waiter wakes and claims', async () => {
  const key = `daytona:img-${crypto.randomUUID()}`;
  await otherReplicaHolds(key, 600);
  expect(await claimSnapshotBuild(key)).toBe(false);
  // This replica's release must not free another replica's claim.
  await releaseSnapshotBuild(key);
  expect(await claimSnapshotBuild(key)).toBe(false);

  const started = Date.now();
  setTimeout(() => void dropOtherReplica(key), 200);
  await waitForSnapshotBuildRelease(key, 10_000, 50);
  expect(Date.now() - started).toBeLessThan(2_000);
  expect(await claimSnapshotBuild(key)).toBe(true);
  // Held by this replica now: a second claim from here is refused too.
  expect(await claimSnapshotBuild(key)).toBe(false);
  await releaseSnapshotBuild(key);
  expect(await claimSnapshotBuild(key)).toBe(true);
  await releaseSnapshotBuild(key);
});

test('an expired claim (its replica died mid-build) is taken over', async () => {
  const key = `daytona:img-${crypto.randomUUID()}`;
  await otherReplicaHolds(key, -1);
  await waitForSnapshotBuildRelease(key, 1_000, 50);
  expect(await claimSnapshotBuild(key)).toBe(true);
  await releaseSnapshotBuild(key);
});

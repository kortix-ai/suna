/**
 * One provider build per snapshot identity across ALL API replicas.
 *
 * `ensureSandboxImage` collapses concurrent builds inside one process
 * (`inflightBuilds`). Two replicas that both read `missing` before either
 * started a provider build each ran their own: two same-name provider builds
 * (one conflicts and fails its session) and two build-log rows. A lease row in
 * `kortix.worker_leader_lease` — the table leader election already uses — names
 * the replica that builds; the others wait for it to finish.
 *
 * The claim is a short lease the builder renews while it builds (`holdSnapshotBuild`),
 * so a replica that dies mid-build frees the key within `SNAPSHOT_BUILD_CLAIM_TTL_MS`,
 * and a build longer than the lease keeps its claim. A clean shutdown releases
 * every claim at once (`releaseAllSnapshotBuilds`). Waiters give up after
 * `SNAPSHOT_BUILD_WAIT_MS`, the longest a provider build runs.
 */
import { workerLeaderLease } from '@kortix/db';
import { and, eq, gte, sql } from 'drizzle-orm';
import { db } from '../shared/db';

const OWNER = `${process.pid}:${crypto.randomUUID()}`;
export const SNAPSHOT_BUILD_CLAIM_TTL_MS = 90_000;
export const SNAPSHOT_BUILD_HEARTBEAT_MS = 30_000;
export const SNAPSHOT_BUILD_WAIT_MS = 12 * 60 * 1000;
const RELEASE_POLL_MS = 3_000;

const leaseKey = (buildKey: string) => `snapshot-build:${buildKey}`;

/** True when this replica now holds the build for `buildKey`. */
export async function claimSnapshotBuild(buildKey: string): Promise<boolean> {
  const ttlSec = Math.ceil(SNAPSHOT_BUILD_CLAIM_TTL_MS / 1000);
  const rows = await db.execute(sql`
    INSERT INTO kortix.worker_leader_lease AS l (lock_key, owner_id, expires_at, updated_at)
    VALUES (${leaseKey(buildKey)}, ${OWNER}, now() + make_interval(secs => ${ttlSec}), now())
    ON CONFLICT (lock_key) DO UPDATE
      SET owner_id = EXCLUDED.owner_id, expires_at = EXCLUDED.expires_at, updated_at = now()
      WHERE l.expires_at < now()
    RETURNING owner_id
  `);
  const list = Array.isArray(rows) ? rows : ((rows as { rows?: unknown[] }).rows ?? []);
  return list.length > 0;
}

export async function releaseSnapshotBuild(buildKey: string): Promise<void> {
  await db
    .delete(workerLeaderLease)
    .where(and(eq(workerLeaderLease.lockKey, leaseKey(buildKey)), eq(workerLeaderLease.ownerId, OWNER)));
}

/** Extend this replica's claim. False when the claim is gone (expired and taken over, or released). */
export async function renewSnapshotBuild(buildKey: string): Promise<boolean> {
  const ttlSec = Math.ceil(SNAPSHOT_BUILD_CLAIM_TTL_MS / 1000);
  const rows = await db
    .update(workerLeaderLease)
    .set({ expiresAt: sql`now() + make_interval(secs => ${ttlSec})`, updatedAt: sql`now()` })
    .where(and(eq(workerLeaderLease.lockKey, leaseKey(buildKey)), eq(workerLeaderLease.ownerId, OWNER)))
    .returning({ lockKey: workerLeaderLease.lockKey });
  return rows.length > 0;
}

// replica-local: the claims THIS process holds (the rows in worker_leader_lease are the shared truth), each with its heartbeat timer.
const held = new Map<string, ReturnType<typeof setTimeout>>();

/** Keep the claim alive while the build runs. Returns the function that stops the heartbeat. */
export function holdSnapshotBuild(buildKey: string): () => void {
  const beat = () => {
    void renewSnapshotBuild(buildKey)
      .catch(() => false)
      .then((alive) => {
        if (alive && held.has(buildKey)) {
          const timer = setTimeout(beat, SNAPSHOT_BUILD_HEARTBEAT_MS);
          timer.unref?.();
          held.set(buildKey, timer);
        }
      });
  };
  const timer = setTimeout(beat, SNAPSHOT_BUILD_HEARTBEAT_MS);
  timer.unref?.();
  held.set(buildKey, timer);
  return () => {
    clearTimeout(held.get(buildKey));
    held.delete(buildKey);
  };
}

/** Shutdown: free every claim this process holds so peers do not wait out the lease. */
export async function releaseAllSnapshotBuilds(): Promise<void> {
  for (const timer of held.values()) clearTimeout(timer);
  held.clear();
  await db
    .delete(workerLeaderLease)
    .where(and(eq(workerLeaderLease.ownerId, OWNER), sql`${workerLeaderLease.lockKey} LIKE 'snapshot-build:%'`));
}

/** Resolves once no live claim holds `buildKey`, or after `timeoutMs`. */
export async function waitForSnapshotBuildRelease(
  buildKey: string,
  timeoutMs = SNAPSHOT_BUILD_WAIT_MS,
  pollMs = RELEASE_POLL_MS,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const [held] = await db
      .select({ lockKey: workerLeaderLease.lockKey })
      .from(workerLeaderLease)
      .where(and(eq(workerLeaderLease.lockKey, leaseKey(buildKey)), gte(workerLeaderLease.expiresAt, new Date())))
      .limit(1);
    if (!held) return;
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
}

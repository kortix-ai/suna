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
 * The TTL is the longest any caller waits on a provider build, so a replica
 * that dies mid-build frees the key without help.
 */
import { workerLeaderLease } from '@kortix/db';
import { and, eq, gte, sql } from 'drizzle-orm';
import { db } from '../lib/db';

const OWNER = `${process.pid}:${crypto.randomUUID()}`;
export const SNAPSHOT_BUILD_CLAIM_TTL_MS = 12 * 60 * 1000;
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

/** Resolves once no live claim holds `buildKey`, or after `timeoutMs`. */
export async function waitForSnapshotBuildRelease(
  buildKey: string,
  timeoutMs = SNAPSHOT_BUILD_CLAIM_TTL_MS,
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

/**
 * Durable state for repository snapshots: the publication ledger
 * (`kortix.repo_snapshots`) and the observed-revision table
 * (`kortix.repo_snapshot_refs`).
 *
 * Lease and retry mechanics follow `apps/src/apps/deployment-worker.ts`
 * exactly — an ownership-checked CAS on every state change, so a reclaimed
 * lease can never be written over by the replica that lost it.
 */
import { repoSnapshotRefs, repoSnapshots } from '@kortix/db';
import { and, asc, eq, inArray, isNull, lt, lte, or, sql } from 'drizzle-orm';
import { db } from '../shared/db';
import {
  REPO_SNAPSHOT_FORMAT,
  normalizeRefKey,
  type RepoSnapshotCompression,
  type RepoSnapshotIdentity,
  type RepoSnapshotManifest,
} from './format';

export type RepoSnapshotRow = typeof repoSnapshots.$inferSelect;
export type RepoSnapshotRefRow = typeof repoSnapshotRefs.$inferSelect;

export const REPO_SNAPSHOT_LEASE_MS = 5 * 60_000;
export const REPO_SNAPSHOT_MAX_ATTEMPTS = 4;
const ACTIVE_STATUSES = ['queued', 'building'] as const;

export function repoSnapshotRetryDelayMs(attempt: number): number {
  return Math.min(10 * 60_000, 5_000 * 2 ** Math.max(0, attempt - 1));
}

/**
 * Queue one revision for publication, or return the row that already covers it.
 *
 * Deduplicated by (provider, repository_id, commit_sha, format) — the same
 * identity the S3 key is derived from — so duplicate webhooks, a webhook racing
 * a reconcile, and two API replicas all collapse onto one row. A `failed` row
 * whose attempts are exhausted is NOT resurrected here; `requeue` is explicit.
 */
export async function enqueueRepoSnapshot(input: {
  identity: RepoSnapshotIdentity;
  sourceProjectId?: string | null;
  sourceRef?: string | null;
}): Promise<RepoSnapshotRow> {
  const { identity } = input;
  const [row] = await db
    .insert(repoSnapshots)
    .values({
      provider: identity.provider,
      repositoryId: identity.repositoryId,
      owner: identity.owner,
      repo: identity.repo,
      commitSha: identity.commitSha,
      format: REPO_SNAPSHOT_FORMAT,
      status: 'queued',
      sourceProjectId: input.sourceProjectId ?? null,
      sourceRef: input.sourceRef ?? null,
    })
    .onConflictDoUpdate({
      target: [
        repoSnapshots.provider,
        repoSnapshots.repositoryId,
        repoSnapshots.commitSha,
        repoSnapshots.format,
      ],
      // Touch-only: never downgrade a ready row, never reset another worker's
      // attempt budget. Owner/repo are refreshed so a rename keeps the
      // human-readable prefix current for FUTURE publications only.
      set: {
        owner: identity.owner,
        repo: identity.repo,
        updatedAt: new Date(),
      },
    })
    .returning();
  return row!;
}

/** Force a failed or stale row back into the queue (backfill, manual retry). */
export async function requeueRepoSnapshot(snapshotId: string): Promise<RepoSnapshotRow | null> {
  const [row] = await db
    .update(repoSnapshots)
    .set({
      status: 'queued',
      attemptCount: 0,
      nextAttemptAt: null,
      leaseOwner: null,
      leaseExpiresAt: null,
      errorCode: null,
      error: null,
      updatedAt: new Date(),
    })
    .where(and(eq(repoSnapshots.snapshotId, snapshotId), sql`${repoSnapshots.status} <> 'ready'`))
    .returning();
  return row ?? null;
}

export async function findRepoSnapshot(
  identity: Pick<RepoSnapshotIdentity, 'provider' | 'repositoryId' | 'commitSha'>,
): Promise<RepoSnapshotRow | null> {
  const [row] = await db
    .select()
    .from(repoSnapshots)
    .where(
      and(
        eq(repoSnapshots.provider, identity.provider),
        eq(repoSnapshots.repositoryId, identity.repositoryId),
        eq(repoSnapshots.commitSha, identity.commitSha),
        eq(repoSnapshots.format, REPO_SNAPSHOT_FORMAT),
      ),
    )
    .limit(1);
  return row ?? null;
}

export async function findReadyRepoSnapshot(
  identity: Pick<RepoSnapshotIdentity, 'provider' | 'repositoryId' | 'commitSha'>,
): Promise<RepoSnapshotRow | null> {
  const row = await findRepoSnapshot(identity);
  return row && row.status === 'ready' ? row : null;
}

export async function claimRepoSnapshot(
  owner: string,
  now = new Date(),
): Promise<RepoSnapshotRow | null> {
  const [candidate] = await db
    .select({ snapshotId: repoSnapshots.snapshotId, attemptCount: repoSnapshots.attemptCount })
    .from(repoSnapshots)
    .where(
      and(
        inArray(repoSnapshots.status, [...ACTIVE_STATUSES]),
        or(isNull(repoSnapshots.nextAttemptAt), lte(repoSnapshots.nextAttemptAt, now)),
        or(isNull(repoSnapshots.leaseExpiresAt), lt(repoSnapshots.leaseExpiresAt, now)),
      ),
    )
    .orderBy(asc(repoSnapshots.createdAt))
    .limit(1);
  if (!candidate) return null;

  const [claimed] = await db
    .update(repoSnapshots)
    .set({
      status: 'building',
      leaseOwner: owner,
      leaseExpiresAt: new Date(now.getTime() + REPO_SNAPSHOT_LEASE_MS),
      attemptCount: candidate.attemptCount + 1,
      updatedAt: now,
    })
    .where(
      and(
        eq(repoSnapshots.snapshotId, candidate.snapshotId),
        inArray(repoSnapshots.status, [...ACTIVE_STATUSES]),
        or(isNull(repoSnapshots.leaseExpiresAt), lt(repoSnapshots.leaseExpiresAt, now)),
      ),
    )
    .returning();
  return claimed ?? null;
}

export async function renewRepoSnapshotLease(snapshotId: string, owner: string): Promise<void> {
  const rows = await db
    .update(repoSnapshots)
    .set({ leaseExpiresAt: new Date(Date.now() + REPO_SNAPSHOT_LEASE_MS), updatedAt: new Date() })
    .where(
      and(
        eq(repoSnapshots.snapshotId, snapshotId),
        eq(repoSnapshots.leaseOwner, owner),
        eq(repoSnapshots.status, 'building'),
      ),
    )
    .returning({ snapshotId: repoSnapshots.snapshotId });
  if (rows.length === 0) throw new Error(`lost repo snapshot lease ${snapshotId}`);
}

/**
 * Publish the readiness record. Idempotent by design: a crash between the S3
 * upload and this write retries the whole build and lands here with the same
 * digest, and a row that some other replica already marked ready is left alone.
 */
export async function markRepoSnapshotReady(input: {
  snapshotId: string;
  owner: string;
  manifest: RepoSnapshotManifest;
  manifestKey: string;
}): Promise<RepoSnapshotRow | null> {
  const { manifest } = input;
  const [row] = await db
    .update(repoSnapshots)
    .set({
      status: 'ready',
      manifestKey: input.manifestKey,
      payloadKey: manifest.payload.key,
      archiveSha256: manifest.payload.sha256,
      compression: manifest.payload.compression as RepoSnapshotCompression,
      treeSha: manifest.source.tree_sha,
      compressedBytes: manifest.payload.compressed_bytes,
      expandedBytes: manifest.payload.expanded_bytes,
      entryCount: manifest.payload.entry_count,
      producerVersion: manifest.producer_version,
      leaseOwner: null,
      leaseExpiresAt: null,
      errorCode: null,
      error: null,
      readyAt: new Date(),
      updatedAt: new Date(),
    })
    .where(and(eq(repoSnapshots.snapshotId, input.snapshotId), eq(repoSnapshots.leaseOwner, input.owner)))
    .returning();
  return row ?? null;
}

export async function markRepoSnapshotAttemptFailed(input: {
  snapshotId: string;
  owner: string;
  attempt: number;
  code: string;
  message: string;
  terminal: boolean;
}): Promise<void> {
  const terminal = input.terminal || input.attempt >= REPO_SNAPSHOT_MAX_ATTEMPTS;
  await db
    .update(repoSnapshots)
    .set({
      status: terminal ? 'failed' : 'queued',
      errorCode: input.code,
      error: input.message.slice(0, 2000),
      nextAttemptAt: terminal ? null : new Date(Date.now() + repoSnapshotRetryDelayMs(input.attempt)),
      leaseOwner: null,
      leaseExpiresAt: null,
      updatedAt: new Date(),
    })
    .where(and(eq(repoSnapshots.snapshotId, input.snapshotId), eq(repoSnapshots.leaseOwner, input.owner)));
}

// ── Observed revisions ──────────────────────────────────────────────────────

export type RefObservationSource = 'webhook' | 'reconcile' | 'proxy_push' | 'import';

/**
 * Record the latest SHA the control plane has OBSERVED for one ref.
 *
 * `revision` is a server-side counter, not a timestamp and not the webhook's
 * arrival order: GitHub delivers out of order and a commit timestamp is
 * attacker-controlled. A write only takes effect when it carries a strictly
 * higher revision, which is how a slow reconcile loses to a newer webhook.
 */
/**
 * Record the latest SHA the control plane has OBSERVED for one ref.
 *
 * `observedAt` is when the tip was RESOLVED from the provider, not when this
 * row is written, and a write only lands if it is strictly newer than what is
 * stored. Those are different clocks: a reconcile that resolved at T1 can reach
 * the database after a webhook that resolved at T2 > T1, and without this guard
 * the slower request would overwrite the newer truth with an older SHA. Webhook
 * ARRIVAL order is never trusted for the same reason.
 *
 * Returns the row that is now authoritative — which is the stored one when this
 * observation lost.
 */
export async function observeRepoRef(input: {
  identity: Pick<RepoSnapshotIdentity, 'provider' | 'repositoryId' | 'owner' | 'repo'>;
  ref: string;
  desiredSha: string | null;
  via: RefObservationSource;
  reconcileAfter?: Date | null;
  /** When the tip was resolved from the provider. Defaults to now. */
  observedAt?: Date;
}): Promise<RepoSnapshotRefRow> {
  const now = new Date();
  const observedAt = input.observedAt ?? now;
  // One canonical spelling per branch; see `normalizeRefKey`.
  const ref = normalizeRefKey(input.ref);
  const [row] = await db
    .insert(repoSnapshotRefs)
    .values({
      provider: input.identity.provider,
      repositoryId: input.identity.repositoryId,
      owner: input.identity.owner,
      repo: input.identity.repo,
      ref,
      desiredSha: input.desiredSha,
      revision: 1,
      observedAt,
      observedVia: input.via,
      reconcileAfter: input.reconcileAfter ?? null,
    })
    .onConflictDoUpdate({
      target: [repoSnapshotRefs.provider, repoSnapshotRefs.repositoryId, repoSnapshotRefs.ref],
      set: {
        desiredSha: input.desiredSha,
        owner: input.identity.owner,
        repo: input.identity.repo,
        revision: sql`${repoSnapshotRefs.revision} + 1`,
        observedAt,
        observedVia: input.via,
        reconcileAfter: input.reconcileAfter ?? null,
        updatedAt: now,
      },
      // Drop a stale observation instead of applying it. The bound is passed as
      // an ISO string with an explicit cast: a raw `sql` fragment does not carry
      // the column's type, so a JS Date reaches the driver unserialized.
      where: sql`${repoSnapshotRefs.observedAt} < ${observedAt.toISOString()}::timestamptz`,
    })
    .returning();
  if (row) return row;
  // The guard rejected this write. The stored row is the authoritative one.
  const current = await readRepoRef(input.identity, ref);
  if (current) return current;
  throw new Error(`ref observation for ${ref} was rejected and the row could not be read back`);
}

/**
 * Make sure this ref is re-examined later, WITHOUT asserting anything about its
 * revision.
 *
 * Preparation that fails before it ever learns a SHA used to leave no row at
 * all, and `claimRefsDueForReconcile` only sees rows — so a project whose very
 * first preparation failed was never retried by anything. This creates the row
 * with no desired revision when it is missing, and otherwise only moves the
 * reconcile deadline, so it can never clobber a good SHA with null.
 */
export async function ensureRefReconcileScheduled(input: {
  identity: Pick<RepoSnapshotIdentity, 'provider' | 'repositoryId' | 'owner' | 'repo'>;
  ref: string;
  at: Date;
}): Promise<void> {
  const now = new Date();
  await db
    .insert(repoSnapshotRefs)
    .values({
      provider: input.identity.provider,
      repositoryId: input.identity.repositoryId,
      owner: input.identity.owner,
      repo: input.identity.repo,
      ref: normalizeRefKey(input.ref),
      desiredSha: null,
      revision: 0,
      observedAt: now,
      observedVia: 'reconcile',
      reconcileAfter: input.at,
    })
    .onConflictDoUpdate({
      target: [repoSnapshotRefs.provider, repoSnapshotRefs.repositoryId, repoSnapshotRefs.ref],
      set: { reconcileAfter: input.at, updatedAt: now },
    });
}

export async function readRepoRef(
  identity: Pick<RepoSnapshotIdentity, 'provider' | 'repositoryId'>,
  ref: string,
): Promise<RepoSnapshotRefRow | null> {
  const [row] = await db
    .select()
    .from(repoSnapshotRefs)
    .where(
      and(
        eq(repoSnapshotRefs.provider, identity.provider),
        eq(repoSnapshotRefs.repositoryId, identity.repositoryId),
        eq(repoSnapshotRefs.ref, normalizeRefKey(ref)),
      ),
    )
    .limit(1);
  return row ?? null;
}

/** Refs whose re-resolution against the provider is due. */
export async function claimRefsDueForReconcile(limit: number, now = new Date()): Promise<RepoSnapshotRefRow[]> {
  return db
    .select()
    .from(repoSnapshotRefs)
    .where(lte(repoSnapshotRefs.reconcileAfter, now))
    .orderBy(asc(repoSnapshotRefs.reconcileAfter))
    .limit(limit);
}

export async function scheduleRefReconcile(
  identity: Pick<RepoSnapshotIdentity, 'provider' | 'repositoryId'>,
  ref: string,
  at: Date,
): Promise<void> {
  await db
    .update(repoSnapshotRefs)
    .set({ reconcileAfter: at, updatedAt: new Date() })
    .where(
      and(
        eq(repoSnapshotRefs.provider, identity.provider),
        eq(repoSnapshotRefs.repositoryId, identity.repositoryId),
        eq(repoSnapshotRefs.ref, normalizeRefKey(ref)),
      ),
    );
}

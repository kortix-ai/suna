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
/** How long a claimed ref is hidden from other replicas' reconcile scans. */
export const REPO_SNAPSHOT_RECONCILE_LEASE_MS = 2 * 60_000;
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
 * A token taken BEFORE a ref lookup starts, and handed back to
 * `observeRepoRef` when it finishes.
 *
 * It is the row's `revision` as the database reported it — a generation, not a
 * clock. Clocks do not work here: two replicas can disagree, a replica running
 * ahead would suppress every later real observation until the others caught up,
 * and two observations inside one millisecond would silently drop one of them.
 */
export interface RefObservationToken {
  /**
   * `revision` at the moment the lookup began; null when no row existed.
   *
   * A null generation is a real assertion — "this ref was unknown when I
   * started" — and loses to any row that exists by the time the write lands.
   */
  generation: number | null;
  /**
   * The ref key the generation was read FROM.
   *
   * A generation only means something for the row it came from. One branch can
   * be stored under two keys during a rollout, and the authoritative one can
   * change between the lookup and the write — a consolidation deletes the
   * legacy row while a rolling replica writes the canonical one. Without this,
   * a counter read from the legacy row would authenticate a write to a
   * different row that happens to sit at the same number.
   */
  ref: string;
}

/** Take the generation token for a ref before resolving its tip. */
export async function beginRefObservation(
  identity: Pick<RepoSnapshotIdentity, 'provider' | 'repositoryId'>,
  ref: string,
): Promise<RefObservationToken> {
  const key = await storedRefKey(db, identity, ref);
  const row = await readRepoRefByKey(db, identity, key);
  return { generation: row ? Number(row.revision) : null, ref: key };
}

/**
 * Record the latest SHA the control plane has OBSERVED for one ref.
 *
 * Ordering is a compare-and-set on the row's generation, taken by
 * `beginRefObservation` before the lookup ran. The write lands only if nobody
 * else has observed this ref since — so a slow reconcile that started earlier
 * can never overwrite a newer webhook just by finishing later, and a late 404
 * cannot erase a SHA recorded while it was in flight.
 *
 * Losing a race drops THIS observation rather than applying it. That is the
 * safe direction: reconciliation re-resolves, so a dropped observation costs a
 * cycle, while an applied stale one is wrong until something else corrects it.
 *
 * Returns the row that is now authoritative — the stored one when this
 * observation lost.
 */
export async function observeRepoRef(input: {
  identity: Pick<RepoSnapshotIdentity, 'provider' | 'repositoryId' | 'owner' | 'repo'>;
  ref: string;
  desiredSha: string | null;
  via: RefObservationSource;
  reconcileAfter?: Date | null;
  /**
   * The generation this observation started from. Omit ONLY for a write with
   * no preceding lookup; every provider-resolved observation must carry one.
   */
  token?: RefObservationToken;
}): Promise<RepoSnapshotRefRow> {
  const now = new Date();
  // One row per branch, whichever spelling that row already uses — resolved and
  // written under the branch lock, so the key cannot move between the two. See
  // `withRefLock`. New rows get the canonical key.
  return withRefLock(input.identity, input.ref, async (tx, ref) => {
  // The token was taken from a specific row. If the authoritative row is a
  // different one now — the legacy spelling was consolidated away while this
  // lookup ran — the generation it carries describes a row that no longer
  // exists, and must not authenticate a write to the survivor.
  if (input.token && input.token.ref !== ref) {
    const current = await readRepoRefByKey(tx, input.identity, ref);
    if (current) return current;
  }
  const [row] = await tx
    .insert(repoSnapshotRefs)
    .values({
      provider: input.identity.provider,
      repositoryId: input.identity.repositoryId,
      owner: input.identity.owner,
      repo: input.identity.repo,
      ref,
      desiredSha: input.desiredSha,
      revision: 1,
      observedAt: now,
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
        observedAt: now,
        observedVia: input.via,
        reconcileAfter: input.reconcileAfter ?? null,
        updatedAt: now,
      },
      // CAS on the generation.
      //
      // `generation: null` is NOT "no token". It means no row existed when this
      // lookup began, so on conflict somebody created one while it was in
      // flight and this result is stale: the write becomes insert-only. Only a
      // caller with no preceding lookup at all (no token) writes unconditionally.
      where: input.token
        ? input.token.generation === null
          ? sql`false`
          : sql`${repoSnapshotRefs.revision} = ${input.token.generation}`
        : undefined,
    })
    .returning();
  if (row) return row;
  // The guard rejected this write. The stored row is the authoritative one.
  const current = await readRepoRefByKey(tx, input.identity, ref);
  if (current) return current;
  throw new Error(`ref observation for ${ref} was rejected and the row could not be read back`);
  });
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
  await withRefLock(input.identity, input.ref, async (tx, ref) =>
    tx
      .insert(repoSnapshotRefs)
      .values({
        provider: input.identity.provider,
        repositoryId: input.identity.repositoryId,
        owner: input.identity.owner,
        repo: input.identity.repo,
        ref,
        desiredSha: null,
        revision: 0,
        observedAt: now,
        observedVia: 'reconcile',
        reconcileAfter: input.at,
      })
      .onConflictDoUpdate({
        target: [repoSnapshotRefs.provider, repoSnapshotRefs.repositoryId, repoSnapshotRefs.ref],
        set: { reconcileAfter: input.at, updatedAt: now },
      }),
  );
}

/**
 * The spelling this ref is actually STORED under.
 *
 * Rows written before ref keys were normalized hold `refs/heads/main`, and a
 * deployment mid-rollout can still produce one. Such a row is invisible to a
 * lookup for `main`, so its revision is never read, its generation comes back
 * null, and a write creates a SECOND row for the same branch — two revisions of
 * one ref, one of them permanently due for reconciliation.
 *
 * So every store entry point resolves the stored spelling first: the canonical
 * key when a row for it exists, the legacy alias when only that one does, and
 * the canonical key when neither exists (which is what a new row gets). The
 * migration that consolidates existing aliases makes this a no-op over time; it
 * stays because a rolling deploy can always write one more.
 */
async function storedRefKey(
  executor: RefExecutor,
  identity: Pick<RepoSnapshotIdentity, 'provider' | 'repositoryId'>,
  ref: string,
): Promise<string> {
  const canonical = normalizeRefKey(ref);
  const [row] = await executor
    .select({ ref: repoSnapshotRefs.ref })
    .from(repoSnapshotRefs)
    .where(
      and(
        eq(repoSnapshotRefs.provider, identity.provider),
        eq(repoSnapshotRefs.repositoryId, identity.repositoryId),
        inArray(repoSnapshotRefs.ref, [canonical, `refs/heads/${canonical}`]),
      ),
    )
    // Canonical wins when both exist, so a consolidation in flight cannot make
    // the alias authoritative.
    .orderBy(sql`case when ${repoSnapshotRefs.ref} = ${canonical} then 0 else 1 end`)
    .limit(1);
  return row?.ref ?? canonical;
}

/** `db`, or a transaction handle. Every ref statement runs through one of these. */
type RefExecutor = Pick<typeof db, 'select' | 'insert' | 'update' | 'execute'>;

async function readRepoRefByKey(
  executor: RefExecutor,
  identity: Pick<RepoSnapshotIdentity, 'provider' | 'repositoryId'>,
  key: string,
): Promise<RepoSnapshotRefRow | null> {
  const [row] = await executor
    .select()
    .from(repoSnapshotRefs)
    .where(
      and(
        eq(repoSnapshotRefs.provider, identity.provider),
        eq(repoSnapshotRefs.repositoryId, identity.repositoryId),
        eq(repoSnapshotRefs.ref, key),
      ),
    )
    .limit(1);
  return row ?? null;
}

/**
 * Run `fn` with this BRANCH locked, whichever key it is stored under.
 *
 * Resolving the stored key and writing to it are two statements, and between
 * them the key itself can move: the consolidation migration renames a legacy
 * row to the canonical one. A write that resolved the old key and then inserted
 * it would recreate the legacy row the migration had just removed, with a stale
 * SHA and no generation to lose against. The lock is taken on the CANONICAL
 * name, so every writer for one branch serializes on the same key no matter
 * which spelling it started from — and the migration takes the same lock.
 */
async function withRefLock<T>(
  identity: Pick<RepoSnapshotIdentity, 'provider' | 'repositoryId'>,
  ref: string,
  fn: (executor: RefExecutor, key: string) => Promise<T>,
): Promise<T> {
  const canonical = normalizeRefKey(ref);
  return db.transaction(async (tx) => {
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtextextended(${`${identity.provider}:${identity.repositoryId}:${canonical}`}, 0))`,
    );
    return fn(tx as unknown as RefExecutor, await storedRefKey(tx as unknown as RefExecutor, identity, ref));
  });
}

export async function readRepoRef(
  identity: Pick<RepoSnapshotIdentity, 'provider' | 'repositoryId'>,
  ref: string,
): Promise<RepoSnapshotRefRow | null> {
  return readRepoRefByKey(db, identity, await storedRefKey(db, identity, ref));
}

/**
 * CLAIM the refs whose re-resolution is due, pushing their deadline out in the
 * same statement.
 *
 * A plain SELECT let every replica pick up the same rows and resolve them
 * concurrently, which is wasted provider quota and a generation race that both
 * sides then lose. The UPDATE ... RETURNING is atomic, so one replica takes
 * each row and the others move on; if the claimer dies, the pushed-out deadline
 * expires and the row becomes claimable again.
 */
export async function claimRefsDueForReconcile(
  limit: number,
  now = new Date(),
): Promise<RepoSnapshotRefRow[]> {
  const lease = new Date(now.getTime() + REPO_SNAPSHOT_RECONCILE_LEASE_MS);
  const claimed = await db.execute(sql`
    update kortix.repo_snapshot_refs as target
       set reconcile_after = ${lease.toISOString()}::timestamptz,
           updated_at = ${now.toISOString()}::timestamptz
     where (target.provider, target.repository_id, target.ref) in (
       select due.provider, due.repository_id, due.ref
         from kortix.repo_snapshot_refs as due
        where due.reconcile_after <= ${now.toISOString()}::timestamptz
        order by due.reconcile_after asc
        limit ${limit}
        for update skip locked
     )
     returning target.*`);
  return (claimed as unknown as RepoSnapshotRefRow[]).map((row) => ({
    ...row,
    // `db.execute` returns raw snake_case; callers read the Drizzle shape.
    repositoryId: (row as never as { repository_id: string }).repository_id,
    desiredSha: (row as never as { desired_sha: string | null }).desired_sha,
    observedAt: new Date((row as never as { observed_at: string }).observed_at),
    observedVia: (row as never as { observed_via: string }).observed_via,
    reconcileAfter: new Date((row as never as { reconcile_after: string }).reconcile_after),
  })) as RepoSnapshotRefRow[];
}

export async function scheduleRefReconcile(
  identity: Pick<RepoSnapshotIdentity, 'provider' | 'repositoryId'>,
  ref: string,
  at: Date,
): Promise<void> {
  await withRefLock(identity, ref, async (tx, key) =>
    tx
      .update(repoSnapshotRefs)
      .set({ reconcileAfter: at, updatedAt: new Date() })
      .where(
        and(
          eq(repoSnapshotRefs.provider, identity.provider),
          eq(repoSnapshotRefs.repositoryId, identity.repositoryId),
          eq(repoSnapshotRefs.ref, key),
        ),
      ),
  );
}

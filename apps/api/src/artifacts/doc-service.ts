/**
 * Live co-editing of doc Artifacts (KRTX-3670): the store and relay of Yjs
 * updates. Browsers POST updates; each gets the next per-Artifact `seq`; every
 * client GETs the updates after the last seq it holds. One browser tab, the
 * lease holder, writes the Markdown file through the ordinary save route and
 * then records the flush here. Every seed starts a new `epoch`; a reset (or
 * the GC job, `doc-gc.ts`) deletes the state and its rows.
 *
 * Locks, in this order: the Artifact row FOR KEY SHARE (a concurrent delete of
 * the Artifact then answers 404, never a foreign-key error), then the state
 * row. Seq allocation holds the state row until COMMIT, so update rows commit
 * in seq order: a reader that sees seq n also sees every seq below it.
 * Compaction (`compactArtifactDoc`) runs after the append commits, under a
 * transaction-scoped try-lock, never waits on a lock and never integrates Yjs.
 *
 * Callers pass plain values; the access check is the route's.
 */
import { and, asc, eq, gt, gte, inArray, isNull, lt, lte, sql } from 'drizzle-orm';
import { artifactDocState, artifactDocUpdates, artifacts } from '@kortix/db';
import { logger } from '../lib/logger';
import { recordAuditEvent } from '../shared/audit';
import { db } from '../shared/db';
import {
  DOC_COMPACTION_BACKOFF_MS,
  DOC_COMPACT_ROWS,
  DOC_MAX_CONTRIBUTORS,
  DOC_MAX_BYTES_TOTAL,
  DOC_PAGE_MAX_BYTES,
  DOC_PAGE_MAX_ROWS,
  compactionWindow,
  decideFlush,
  decideLease,
  decideReset,
  leaseLive,
  pageCut,
  type DocLease,
  type DocLeaseKind,
} from './doc-rules';
import { checkDocUpdate, compactDocUpdates, mergesAlone } from './doc-yjs';

export class ArtifactDocError extends Error {
  constructor(
    readonly status: 400 | 404 | 409 | 413,
    message: string,
    readonly code: string,
    /** Fields the response carries beside `error` and `code` (`epoch` on `epoch_mismatch`). */
    readonly detail?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'ArtifactDocError';
  }
}

const notSeeded = () => new ArtifactDocError(409, 'This doc has no live state yet: seed it first', 'doc_not_seeded');

/**
 * A write that names the epoch it was made in (optional, so older clients keep
 * working): another epoch → 409 `epoch_mismatch` with the current one. The
 * client then rebuilds at once instead of learning of a reset from its next pull.
 */
function assertEpoch(stored: string, given: string | undefined): void {
  if (given !== undefined && given !== stored) {
    throw new ArtifactDocError(409, 'This doc was reset: its live state has another epoch', 'epoch_mismatch', { epoch: stored });
  }
}

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

/**
 * The Artifact row FOR KEY SHARE, first in every write: a delete of the
 * Artifact waits for this transaction, or this one finds the row gone → 404.
 */
async function lockArtifact(tx: Tx, artifactId: string): Promise<void> {
  const [row] = await tx.select({ id: artifacts.artifactId }).from(artifacts).where(eq(artifacts.artifactId, artifactId)).for('key share');
  if (!row) throw new ArtifactDocError(404, 'Artifact not found', 'not_found');
}

export interface ArtifactDocRead {
  seeded: boolean;
  epoch: string | null;
  latestSeq: number;
  updates: Array<{ seq: number; bytes: Buffer }>;
  hasMore: boolean;
  flushed: { seq: number; version: string | null; markdown?: string } | null;
  lease: { holder: string; expiresAt: Date } | null;
}

export interface ArtifactDocLeaseResult {
  kind: DocLeaseKind;
  leader: boolean;
  holder: string | null;
  expiresAt: Date | null;
}

export type ArtifactDocCompaction =
  | { done: true; fromSeq: number; toSeq: number; rows: number; quarantined?: number[] }
  | { done: false; reason: 'busy' | 'below_threshold' | 'backoff' | 'too_large' | 'failed' };

/** The database clock, in ms: every replica decides a lease on one clock. */
const dbNowMs = sql<number>`(extract(epoch from clock_timestamp()) * 1000)::float8`;

function liveLease(lease: DocLease, now: Date): { holder: string; expiresAt: Date } | null {
  return leaseLive(lease, now) ? { holder: lease.holder!, expiresAt: lease.expiresAt! } : null;
}

/**
 * The updates after `after`, ascending, at most `DOC_PAGE_MAX_BYTES` per page,
 * with the epoch, the flush and the live lease. No stored row is larger than
 * the page limit (a push ≤ 512 KiB, a seed ≤ 2 MiB, a merged row ≤ the page
 * limit). One repeatable-read snapshot: a compaction between the reads cannot
 * drop a row. `base`: the flushed Markdown as well.
 */
export async function readArtifactDoc(artifactId: string, input: { after: number; base: boolean }): Promise<ArtifactDocRead> {
  return db.transaction(async (tx) => {
    const [state] = await tx.select({
      epoch: artifactDocState.epoch,
      nextSeq: artifactDocState.nextSeq,
      flushedSeq: artifactDocState.flushedSeq,
      flushedVersion: artifactDocState.flushedVersion,
      flushedMarkdown: input.base ? artifactDocState.flushedMarkdown : sql<null>`null`,
      holder: artifactDocState.leaseHolder,
      userId: artifactDocState.leaseUserId,
      expiresAt: artifactDocState.leaseExpiresAt,
      nowMs: dbNowMs,
    }).from(artifactDocState).where(eq(artifactDocState.artifactId, artifactId));
    if (!state) return { seeded: false, epoch: null, latestSeq: 0, updates: [], hasMore: false, flushed: null, lease: null };

    const sizes = await tx.select({ seq: artifactDocUpdates.seq, size: sql<number>`octet_length(${artifactDocUpdates.bytes})` })
      .from(artifactDocUpdates)
      .where(and(eq(artifactDocUpdates.artifactId, artifactId), gt(artifactDocUpdates.seq, input.after)))
      .orderBy(asc(artifactDocUpdates.seq))
      .limit(DOC_PAGE_MAX_ROWS + 1);
    const cut = pageCut(sizes.map((row) => ({ seq: row.seq, size: Number(row.size) })), DOC_PAGE_MAX_BYTES, DOC_PAGE_MAX_ROWS);
    const last = cut.count > 0 ? sizes[cut.count - 1]!.seq : input.after;
    const updates = cut.count === 0 ? [] : await tx.select({ seq: artifactDocUpdates.seq, bytes: artifactDocUpdates.bytes })
      .from(artifactDocUpdates)
      .where(and(eq(artifactDocUpdates.artifactId, artifactId), gt(artifactDocUpdates.seq, input.after), lte(artifactDocUpdates.seq, last)))
      .orderBy(asc(artifactDocUpdates.seq));

    const now = new Date(Number(state.nowMs));
    return {
      seeded: true,
      epoch: state.epoch,
      latestSeq: state.nextSeq - 1,
      updates,
      hasMore: cut.hasMore,
      flushed: {
        seq: state.flushedSeq,
        version: state.flushedVersion,
        ...(input.base ? { markdown: state.flushedMarkdown ?? '' } : {}),
      },
      lease: liveLease({ holder: state.holder, userId: state.userId, expiresAt: state.expiresAt }, now),
    };
  }, { isolationLevel: 'repeatable read', accessMode: 'read only' });
}

/**
 * The first update: the doc built from the file's Markdown at `version`. It is
 * seq 1 of a new epoch, and it is in the file (flushed_seq 1). 409
 * `doc_seeded` when the doc already has a state: the caller GETs it instead.
 */
export async function seedArtifactDoc(
  artifactId: string,
  input: { update: Buffer; markdown: string; version: string; userId: string },
): Promise<{ seq: number; epoch: string }> {
  return db.transaction(async (tx) => {
    await lockArtifact(tx, artifactId);
    const [created] = await tx.insert(artifactDocState).values({
      artifactId,
      bytesTotal: input.update.length,
      nextSeq: 2,
      flushedSeq: 1,
      flushedVersion: input.version,
      flushedMarkdown: input.markdown,
    }).onConflictDoNothing({ target: artifactDocState.artifactId }).returning({ epoch: artifactDocState.epoch });
    if (!created) throw new ArtifactDocError(409, 'This doc already has a live state: read it instead', 'doc_seeded');
    await tx.insert(artifactDocUpdates).values({ artifactId, seq: 1, bytes: input.update, createdBy: input.userId });
    return { seq: 1, epoch: created.epoch };
  });
}

/**
 * Append one update: the next seq, under the state row's lock until COMMIT.
 * 413 `doc_too_large` when the stored bytes would pass `DOC_MAX_BYTES_TOTAL`.
 * `rows`: the rows the Artifact holds now; past `DOC_COMPACT_ROWS` the caller
 * runs `compactArtifactDoc` after this returns.
 */
export async function appendArtifactDocUpdate(
  artifactId: string,
  input: { update: Buffer; userId: string; epoch?: string },
): Promise<{ seq: number; rows: number }> {
  return db.transaction(async (tx) => {
    await lockArtifact(tx, artifactId);
    const [state] = await tx.select({ epoch: artifactDocState.epoch, bytesTotal: artifactDocState.bytesTotal })
      .from(artifactDocState).where(eq(artifactDocState.artifactId, artifactId)).for('update');
    if (!state) throw notSeeded();
    assertEpoch(state.epoch, input.epoch);
    if (state.bytesTotal + input.update.length > DOC_MAX_BYTES_TOTAL) {
      throw new ArtifactDocError(413, `This doc's live state holds at most ${DOC_MAX_BYTES_TOTAL / 1048576} MiB of updates`, 'doc_too_large');
    }
    const [next] = await tx.update(artifactDocState)
      .set({
        nextSeq: sql`${artifactDocState.nextSeq} + 1`,
        bytesTotal: sql`${artifactDocState.bytesTotal} + ${input.update.length}`,
        // Who wrote: named by the next flush (`markArtifactDocFlushed`), one audit row each.
        pendingContributors: sql`case when ${input.userId}::uuid = any(${artifactDocState.pendingContributors})
            or cardinality(${artifactDocState.pendingContributors}) >= ${DOC_MAX_CONTRIBUTORS}
          then ${artifactDocState.pendingContributors}
          else array_append(${artifactDocState.pendingContributors}, ${input.userId}::uuid) end`,
        updatedAt: sql`now()`,
      })
      .where(eq(artifactDocState.artifactId, artifactId))
      .returning({ nextSeq: artifactDocState.nextSeq });
    const seq = next!.nextSeq - 1;
    await tx.insert(artifactDocUpdates).values({ artifactId, seq, bytes: input.update, createdBy: input.userId });
    const [count] = await tx.select({ rows: sql<number>`count(*)::int` }).from(artifactDocUpdates)
      .where(and(eq(artifactDocUpdates.artifactId, artifactId), isNull(artifactDocUpdates.quarantinedAt)));
    return { seq, rows: Number(count?.rows ?? 0) };
  });
}

/** Back off compaction for this Artifact (`DOC_COMPACTION_BACKOFF_MS`). Never touches updated_at. */
async function stampCompactionFailed(artifactId: string): Promise<void> {
  await db.update(artifactDocState).set({ compactionFailedAt: sql`clock_timestamp()` }).where(eq(artifactDocState.artifactId, artifactId));
}

/** Scan every row, then merge: the merged bytes, null past the page limit, or 'failed'. */
function mergeRows(rows: Array<{ bytes: Buffer }>): Uint8Array | null | 'failed' {
  // Every row is scanned before Yjs reads it: a row stored before a check existed never reaches a decode.
  if (rows.some((row) => !checkDocUpdate(new Uint8Array(row.bytes), 'seed').ok)) return 'failed';
  try {
    return compactDocUpdates(rows.map((row) => new Uint8Array(row.bytes)), DOC_PAGE_MAX_BYTES);
  } catch {
    return 'failed';
  }
}

/**
 * Merge the oldest update rows into one row that keeps the highest of their
 * seqs (`compactionWindow`), when the Artifact holds more than the threshold
 * (quarantined rows do not count). `Y.mergeUpdates` only
 * (`compactDocUpdates`): never integration. The window reads at most
 * `DOC_PAGE_MAX_BYTES`, and a merged row larger than that is dropped.
 *
 * When the merge fails, the rows no Yjs reader takes (`mergesAlone`: they fail
 * the scan, or fail a merge with an empty update) are quarantined: they stay
 * where they are and are still served, but no compaction reads them again, so
 * one bad row can never stall compaction or fill the doc. The rest merge.
 * A failure with no such row, or a merge past the page limit, stamps
 * `compaction_failed_at`: none runs again for 10 min, never one per push.
 * One compaction per Artifact at a time; a second one answers `busy` at once
 * instead of waiting. Appends never conflict with it: they only insert rows
 * above every seq it touches.
 */
export async function compactArtifactDoc(artifactId: string): Promise<ArtifactDocCompaction> {
  const outcome = await db.transaction(async (tx): Promise<ArtifactDocCompaction> => {
    const res = await tx.execute(sql`select pg_try_advisory_xact_lock(hashtextextended(${`artifact-doc:${artifactId}`}, 0)) as ok`);
    if ((res as unknown as Array<{ ok: boolean }>)[0]?.ok !== true) return { done: false, reason: 'busy' };
    const [state] = await tx.select({
      backoff: sql<boolean>`coalesce(${artifactDocState.compactionFailedAt} > now() - make_interval(secs => ${DOC_COMPACTION_BACKOFF_MS / 1000}), false)`,
    }).from(artifactDocState).where(eq(artifactDocState.artifactId, artifactId));
    if (!state) return { done: false, reason: 'below_threshold' };
    if (state.backoff) return { done: false, reason: 'backoff' };
    const live = and(eq(artifactDocUpdates.artifactId, artifactId), isNull(artifactDocUpdates.quarantinedAt));
    const sizes = await tx.select({ seq: artifactDocUpdates.seq, size: sql<number>`octet_length(${artifactDocUpdates.bytes})` })
      .from(artifactDocUpdates)
      .where(live)
      .orderBy(asc(artifactDocUpdates.seq));
    if (sizes.length <= DOC_COMPACT_ROWS) return { done: false, reason: 'below_threshold' };
    const plan = compactionWindow(sizes.map((row) => ({ seq: row.seq, size: Number(row.size) })));
    if (!plan) return { done: false, reason: 'too_large' };
    let rows = await tx.select({ seq: artifactDocUpdates.seq, bytes: artifactDocUpdates.bytes }).from(artifactDocUpdates)
      .where(and(live, gte(artifactDocUpdates.seq, plan.fromSeq), lte(artifactDocUpdates.seq, plan.toSeq)))
      .orderBy(asc(artifactDocUpdates.seq));
    let merged = mergeRows(rows);
    let quarantined: number[] = [];
    if (merged === 'failed') {
      // Bounded: each row once, on its own, within the window's byte budget.
      quarantined = rows.filter((row) => !mergesAlone(new Uint8Array(row.bytes))).map((row) => row.seq);
      if (quarantined.length === 0) {
        logger.warn('[artifact-doc] compaction failed', { artifactId, fromSeq: plan.fromSeq, toSeq: plan.toSeq });
        return { done: false, reason: 'failed' };
      }
      await tx.update(artifactDocUpdates).set({ quarantinedAt: sql`now()` })
        .where(and(eq(artifactDocUpdates.artifactId, artifactId), inArray(artifactDocUpdates.seq, quarantined)));
      logger.warn('[artifact-doc] quarantined rows no Yjs reader takes', { artifactId, seqs: quarantined });
      rows = rows.filter((row) => !quarantined.includes(row.seq));
      if (rows.length < 2) return { done: false, reason: 'below_threshold' };
      merged = mergeRows(rows);
      if (merged === 'failed') return { done: false, reason: 'failed' };
    }
    if (!merged) return { done: false, reason: 'too_large' };
    const fromSeq = rows[0]!.seq;
    const toSeq = rows[rows.length - 1]!.seq;
    const removed = rows.reduce((total, row) => total + row.bytes.length, 0);
    // A merged row holds several people's updates: it names none of them (who wrote is recorded at each flush).
    await tx.update(artifactDocUpdates).set({ bytes: Buffer.from(merged), createdBy: null })
      .where(and(eq(artifactDocUpdates.artifactId, artifactId), eq(artifactDocUpdates.seq, toSeq)));
    await tx.delete(artifactDocUpdates)
      .where(and(live, gte(artifactDocUpdates.seq, fromSeq), lt(artifactDocUpdates.seq, toSeq)));
    await tx.update(artifactDocState)
      .set({ bytesTotal: sql`greatest(0, ${artifactDocState.bytesTotal} - ${removed} + ${merged.length})` })
      .where(eq(artifactDocState.artifactId, artifactId));
    return { done: true, fromSeq, toSeq, rows: rows.length, ...(quarantined.length > 0 ? { quarantined } : {}) };
  });
  if (!outcome.done && (outcome.reason === 'failed' || outcome.reason === 'too_large')) await stampCompactionFailed(artifactId);
  return outcome;
}

/** `POST …/doc/lease`: acquire, renew or release, decided by `decideLease` on the database clock. */
export async function leaseArtifactDoc(
  artifactId: string,
  input: { holder: string; userId: string; release: boolean; epoch?: string },
): Promise<ArtifactDocLeaseResult> {
  return db.transaction(async (tx) => {
    await lockArtifact(tx, artifactId);
    const [state] = await tx.select({
      epoch: artifactDocState.epoch,
      holder: artifactDocState.leaseHolder,
      userId: artifactDocState.leaseUserId,
      expiresAt: artifactDocState.leaseExpiresAt,
      nowMs: dbNowMs,
    }).from(artifactDocState).where(eq(artifactDocState.artifactId, artifactId)).for('update');
    if (!state) throw notSeeded();
    assertEpoch(state.epoch, input.epoch);
    const now = new Date(Number(state.nowMs));
    const decision = decideLease({ holder: state.holder, userId: state.userId, expiresAt: state.expiresAt }, input, now);
    if (decision.write) {
      await tx.update(artifactDocState).set({
        leaseHolder: decision.next.holder,
        leaseUserId: decision.next.userId,
        leaseExpiresAt: decision.next.expiresAt,
        updatedAt: sql`now()`,
      }).where(eq(artifactDocState.artifactId, artifactId));
    }
    const live = liveLease(decision.next, now);
    return { kind: decision.kind, leader: decision.leader, holder: live?.holder ?? null, expiresAt: live?.expiresAt ?? null };
  });
}

export interface ArtifactDocFlushResult {
  flushedSeq: number;
  /** Everyone whose pushes this flush wrote to the file (the pending list), distinct. */
  contributors: string[];
  /** The seqs this flush covers: (the previous flushed seq, `toSeq`]. */
  fromSeq: number;
  toSeq: number;
}

/**
 * `POST …/doc/flushed`: the lease holder wrote the file at `version` with the
 * updates up to `seq`. 409 `not_leader` for anyone else; 400 `invalid_seq`
 * past the newest update. The flushed fields move only forward.
 *
 * `currentVersion`: the file's entry version now, which the caller reads
 * from Files; `version` must equal it (409 `version_mismatch` otherwise).
 *
 * Returns who wrote (`contributors`, at most `DOC_MAX_CONTRIBUTORS`): the
 * people who pushed since the last flush, for one audit row each
 * (`recordArtifactDocEdits`), only when this flush advanced past the previous
 * one: a replay or an equal seq names nobody. The list clears when this flush
 * reaches the newest push; otherwise it is kept, so a writer whose push came
 * after `seq` is named by the next flush too. A writer may be named twice; a
 * writer is never dropped.
 */
export async function markArtifactDocFlushed(
  artifactId: string,
  input: { holder: string; userId: string; seq: number; version: string; markdown: string; currentVersion: string | null; epoch?: string },
): Promise<ArtifactDocFlushResult> {
  return db.transaction(async (tx) => {
    await lockArtifact(tx, artifactId);
    const [state] = await tx.select({
      epoch: artifactDocState.epoch,
      nextSeq: artifactDocState.nextSeq,
      flushedSeq: artifactDocState.flushedSeq,
      pendingContributors: artifactDocState.pendingContributors,
      holder: artifactDocState.leaseHolder,
      userId: artifactDocState.leaseUserId,
      expiresAt: artifactDocState.leaseExpiresAt,
    }).from(artifactDocState).where(eq(artifactDocState.artifactId, artifactId)).for('update');
    if (!state) throw notSeeded();
    assertEpoch(state.epoch, input.epoch);
    const decision = decideFlush(
      {
        flushedSeq: state.flushedSeq,
        latestSeq: state.nextSeq - 1,
        lease: { holder: state.holder, userId: state.userId, expiresAt: state.expiresAt },
        currentVersion: input.currentVersion,
      },
      input,
    );
    if (!decision.ok) {
      if (decision.code === 'not_leader') throw new ArtifactDocError(409, 'Only the tab that holds the lease records a flush', 'not_leader');
      if (decision.code === 'version_mismatch') {
        throw new ArtifactDocError(409, 'The file is not at that version now: record only the save you just made', 'version_mismatch', { current_version: input.currentVersion });
      }
      throw new ArtifactDocError(400, `seq ${input.seq} is past the newest update (${state.nextSeq - 1})`, 'invalid_seq');
    }
    if (!decision.apply) return { flushedSeq: state.flushedSeq, contributors: [], fromSeq: state.flushedSeq + 1, toSeq: state.flushedSeq };
    const clear = decision.advanced && input.seq >= state.nextSeq - 1;
    await tx.update(artifactDocState).set({
      flushedSeq: input.seq,
      flushedVersion: input.version,
      flushedMarkdown: input.markdown,
      ...(clear ? { pendingContributors: sql`'{}'::uuid[]` } : {}),
      updatedAt: sql`now()`,
    }).where(eq(artifactDocState.artifactId, artifactId));
    const contributors = decision.advanced ? state.pendingContributors.slice(0, DOC_MAX_CONTRIBUTORS) : [];
    return { flushedSeq: input.seq, contributors, fromSeq: state.flushedSeq + 1, toSeq: input.seq };
  });
}

/**
 * `POST …/doc/reset`: delete the live state and every update row in one
 * transaction (a poisoned update, or a client that must start over). The
 * lease holder may reset, and anyone while the lease is free or expired;
 * another live holder → 409 `not_leader`. A doc with no state: nothing to do.
 */
export async function resetArtifactDoc(artifactId: string, input: { holder: string; userId: string }): Promise<{ reset: true }> {
  return db.transaction(async (tx) => {
    await lockArtifact(tx, artifactId);
    const [state] = await tx.select({
      holder: artifactDocState.leaseHolder,
      userId: artifactDocState.leaseUserId,
      expiresAt: artifactDocState.leaseExpiresAt,
      nowMs: dbNowMs,
    }).from(artifactDocState).where(eq(artifactDocState.artifactId, artifactId)).for('update');
    if (state) {
      const lease = { holder: state.holder, userId: state.userId, expiresAt: state.expiresAt };
      if (!decideReset(lease, input, new Date(Number(state.nowMs)))) {
        throw new ArtifactDocError(409, 'Another tab holds the lease: only it may reset this doc', 'not_leader');
      }
      await tx.delete(artifactDocState).where(eq(artifactDocState.artifactId, artifactId));
    }
    await tx.delete(artifactDocUpdates).where(eq(artifactDocUpdates.artifactId, artifactId));
    return { reset: true as const };
  });
}

/**
 * One `project.artifact.doc.edit` audit row per person whose pushes a flush
 * wrote to the file: the lease holder saves the file, but the text is theirs.
 * The row's actor is the writer; the request's own identity (its caller, IP,
 * session) is not copied onto it.
 */
export async function recordArtifactDocEdits(input: {
  accountId: string;
  projectId: string;
  artifactId: string;
  flushedBy: string;
  version: string;
  flush: ArtifactDocFlushResult;
}): Promise<void> {
  for (const contributor of input.flush.contributors) {
    await recordAuditEvent({
      accountId: input.accountId,
      projectId: input.projectId,
      actorUserId: contributor,
      actorType: 'human',
      sessionId: null,
      agentId: null,
      onBehalfOfUserId: null,
      credentialKind: null,
      credentialId: null,
      ip: null,
      userAgent: null,
      action: 'project.artifact.doc.edit',
      resourceType: 'artifact',
      resourceId: input.artifactId,
      outcome: 'success',
      metadata: { from_seq: input.flush.fromSeq, to_seq: input.flush.toSeq, version: input.version, flushed_by: input.flushedBy },
    });
  }
}

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
import { artifactDocClients, artifactDocRoots, artifactDocState, artifactDocUpdates, artifacts } from '@kortix/db';
import { logger } from '../lib/logger';
import { recordAuditEvent } from '../shared/audit';
import { db } from '../shared/db';
import {
  DOC_COMPACTION_BACKOFF_MS,
  DOC_COMPACT_ROWS,
  DOC_INDEX_ROW_BYTES,
  DOC_MAX_BYTES_TOTAL,
  DOC_MAX_CLIENTS,
  DOC_MAX_CONTRIBUTORS,
  DOC_MAX_ROOTS,
  DOC_PAGE_MAX_BYTES,
  DOC_PAGE_MAX_ROWS,
  DOC_PAGE_MAX_STRUCTS,
  DOC_ROOT_LOOKUP_BATCH,
  DOC_UPDATE_MAX_BYTES,
  DOC_UPDATE_ROW_BYTES,
  compactionWindow,
  decideFlush,
  decideLease,
  decideReset,
  leaseLive,
  pageCut,
  settleWriters,
  type DocLease,
  type DocLeaseKind,
} from './doc-rules';
import { collectRefs, decideRoots, rootLookups, type DocRefs, type DocRootReason } from './doc-roots';
import type { DocPlacement } from './doc-scan';
import { DOC_MAX_STRUCTS, checkDocUpdate, compactDocUpdates, measureDocUpdate, mergesAlone } from './doc-yjs';

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

const ROOT_REFUSALS: Record<DocRootReason, string> = {
  root_not_element: 'An item at the root of the doc must be an XML element (a block)',
  unknown_origin: 'An item names an origin this doc does not hold',
  clock_gap: 'The update leaves a hole in its client’s clocks',
  clock_overlap: 'The update sends stored items again, placed differently',
};

/** A Postgres bigint[] literal of integers (every value is a Yjs client or clock, at most 2^53). */
const bigints = (values: readonly number[]) => `{${values.join(',')}}`;

/** What the root check read under the lock: its bound is the point (`DOC_ROOT_LOOKUP_BATCH`, `DOC_MAX_ROOTS`, `DOC_MAX_CLIENTS`). */
export interface DocIndexReads {
  /** Queries on `artifact_doc_roots`: at most 2 (the batched lookup and the re-sent range), or 1 range scan. */
  rootQueries: number;
  /** Rows they returned: at most 2 × `DOC_ROOT_LOOKUP_BATCH` + 1, or `DOC_MAX_ROOTS`. */
  rootRows: number;
  /** Rows of `artifact_doc_clients` read: one per distinct client the update names, at most `DOC_MAX_CLIENTS` + 1. */
  clientRows: number;
}

/**
 * The index rows one update needs, read under the state row's lock with
 * bounded work whatever the payload names (`refs`: deduplicated before the
 * lock, `collectRefs`):
 *   - clients: one query, one row per distinct client. An ID is stored when
 *     its clock is below its client's next clock: one comparison per ID in
 *     memory. More distinct clients than the doc may hold → one of them is
 *     unknown; nothing is read and every ID of a client not read is unknown;
 *   - roots, only for stored IDs: up to `DOC_ROOT_LOOKUP_BATCH` of them (and a
 *     re-sent range of at most that many structs) → one batched lookup and
 *     one range read. More → one range scan of the doc's whole root index
 *     (at most `DOC_MAX_ROOTS` rows, the cap), checked in memory.
 */
async function readDocIndex(tx: Tx, artifactId: string, placement: DocPlacement & { client: number }, refs: DocRefs) {
  const own = placement.client;
  const reads: DocIndexReads = { rootQueries: 0, rootRows: 0, clientRows: 0 };
  const nextClocks = new Map<number, number>();
  if (refs.clients.length <= DOC_MAX_CLIENTS + 1) {
    const rows = await tx.select({ client: artifactDocClients.client, nextClock: artifactDocClients.nextClock }).from(artifactDocClients)
      .where(and(eq(artifactDocClients.artifactId, artifactId), inArray(artifactDocClients.client, refs.clients)));
    reads.clientRows = rows.length;
    for (const row of rows) nextClocks.set(row.client, row.nextClock);
  }
  const current = nextClocks.has(own);
  const nextClock = nextClocks.get(own) ?? 0;
  const lookups = rootLookups(placement, nextClock, refs);
  const known = (client: number, clock: number) => clock < (nextClocks.get(client) ?? 0);
  const stored = lookups.refs.filter(([client, clock]) => known(client, clock));
  const roots = new Set<string>();
  const storedRoots = new Set<number>();
  const batched = stored.length <= DOC_ROOT_LOOKUP_BATCH && (!lookups.overlap || lookups.overlap.limit <= DOC_ROOT_LOOKUP_BATCH);
  if (!batched) {
    // One range scan of the primary key: the whole index of this doc, at most DOC_MAX_ROOTS rows.
    const rows = await tx.select({ client: artifactDocRoots.client, clock: artifactDocRoots.clock }).from(artifactDocRoots)
      .where(eq(artifactDocRoots.artifactId, artifactId));
    reads.rootQueries += 1;
    reads.rootRows += rows.length;
    for (const row of rows) {
      roots.add(`${row.client}:${row.clock}`);
      if (lookups.overlap && row.client === own && row.clock >= lookups.overlap.from && row.clock < lookups.overlap.to) storedRoots.add(row.clock);
    }
  } else {
    if (stored.length > 0) {
      const rows = await tx.execute(sql`select r.client::text as client, r.clock::text as clock
          from kortix.artifact_doc_roots r
          join unnest(${bigints(stored.map(([client]) => client))}::bigint[], ${bigints(stored.map(([, clock]) => clock))}::bigint[]) as q(client, clock)
            on r.client = q.client and r.clock = q.clock
         where r.artifact_id = ${artifactId}::uuid`) as unknown as Array<{ client: string; clock: string }>;
      reads.rootQueries += 1;
      reads.rootRows += rows.length;
      for (const row of rows) roots.add(`${row.client}:${row.clock}`);
    }
    if (lookups.overlap) {
      const rows = await tx.select({ clock: artifactDocRoots.clock }).from(artifactDocRoots)
        .where(and(
          eq(artifactDocRoots.artifactId, artifactId),
          eq(artifactDocRoots.client, own),
          gte(artifactDocRoots.clock, lookups.overlap.from),
          lt(artifactDocRoots.clock, lookups.overlap.to),
        ))
        .orderBy(asc(artifactDocRoots.clock))
        .limit(lookups.overlap.limit);
      reads.rootQueries += 1;
      reads.rootRows += rows.length;
      for (const row of rows) storedRoots.add(row.clock);
    }
  }
  return {
    current,
    nextClock,
    stored: { nextClock, known, root: (client: number, clock: number) => roots.has(`${client}:${clock}`), storedRoots },
    reads,
  };
}

/**
 * The root rule for one seed or push (`doc-roots.ts`), under the state row's
 * lock: read the index for the IDs the update names (`readDocIndex`, bounded),
 * decide, and write the update's new root-level IDs and its client's clock.
 * 400 `invalid_update` with the `reason` otherwise. Without `placement` (a
 * caller that did not scan the bytes) nothing is checked or indexed. `refs`:
 * `collectRefs(placement)`, computed before the caller took the lock.
 *
 * The index rows are the doc's storage too: each new row costs
 * `DOC_INDEX_ROW_BYTES` of `budget.bytesTotal` (the doc's total with this
 * update's row already charged), the roots stay within `DOC_MAX_ROOTS` and the
 * clients within `DOC_MAX_CLIENTS`; otherwise 413 `doc_too_large` and nothing
 * is written. Returns the rows added and their cost, for the state row, and
 * what the check read.
 */
async function placeRoots(
  tx: Tx,
  artifactId: string,
  placement: DocPlacement | undefined,
  refs: DocRefs | null,
  budget: { bytesTotal: number; rootRows: number; clientRows: number },
): Promise<{ roots: number; clients: number; bytes: number; reads: DocIndexReads }> {
  const none = { roots: 0, clients: 0, bytes: 0, reads: { rootQueries: 0, rootRows: 0, clientRows: 0 } };
  if (!placement || placement.client === null) return none;
  const own = placement.client;
  const index = await readDocIndex(tx, artifactId, { ...placement, client: own }, refs ?? collectRefs(placement));
  const { current, nextClock } = index;
  const decision = decideRoots(placement, index.stored);
  if (!decision.ok) throw new ArtifactDocError(400, ROOT_REFUSALS[decision.reason], 'invalid_update', { reason: decision.reason });
  const newClient = !current && decision.nextClock > nextClock ? 1 : 0;
  if (budget.rootRows + decision.roots.length > DOC_MAX_ROOTS) {
    throw new ArtifactDocError(413, `This doc's live state holds at most ${DOC_MAX_ROOTS} blocks at its root: save the file instead`, 'doc_too_large');
  }
  if (budget.clientRows + newClient > DOC_MAX_CLIENTS) {
    throw new ArtifactDocError(413, `This doc's live state holds the edits of at most ${DOC_MAX_CLIENTS} tabs: save the file instead`, 'doc_too_large');
  }
  if (budget.bytesTotal + (decision.roots.length + newClient) * DOC_INDEX_ROW_BYTES > DOC_MAX_BYTES_TOTAL) {
    throw new ArtifactDocError(413, `This doc's live state holds at most ${DOC_MAX_BYTES_TOTAL / 1048576} MiB`, 'doc_too_large');
  }
  let addedRoots = 0;
  if (decision.roots.length > 0) {
    // Counted from what was inserted: the accounting matches the rows exactly.
    const inserted = await tx.execute(sql`with added as (
        insert into kortix.artifact_doc_roots (artifact_id, client, clock)
        select ${artifactId}::uuid, ${String(own)}::bigint, unnest(${bigints(decision.roots)}::bigint[])
        on conflict do nothing
        returning 1)
      select count(*)::int as n from added`);
    addedRoots = (inserted as unknown as Array<{ n: number }>)[0]?.n ?? 0;
  }
  let addedClients = 0;
  if (decision.nextClock > nextClock) {
    const [upserted] = await tx.insert(artifactDocClients).values({ artifactId, client: own, nextClock: decision.nextClock })
      .onConflictDoUpdate({
        target: [artifactDocClients.artifactId, artifactDocClients.client],
        set: { nextClock: sql`greatest(${artifactDocClients.nextClock}, excluded.next_clock)` },
      })
      // xmax = 0: this statement inserted the row (an update of an existing row sets it).
      .returning({ inserted: sql<boolean>`(xmax = 0)` });
    addedClients = upserted?.inserted ? 1 : 0;
  }
  return { roots: addedRoots, clients: addedClients, bytes: (addedRoots + addedClients) * DOC_INDEX_ROW_BYTES, reads: index.reads };
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
  | { done: false; reason: 'busy' | 'below_threshold' | 'backoff' | 'too_large' | 'failed' | 'stale' };

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

    const sizes = await tx.select({
      seq: artifactDocUpdates.seq,
      size: sql<number>`octet_length(${artifactDocUpdates.bytes})`,
      structs: artifactDocUpdates.structs,
    })
      .from(artifactDocUpdates)
      .where(and(eq(artifactDocUpdates.artifactId, artifactId), gt(artifactDocUpdates.seq, input.after)))
      .orderBy(asc(artifactDocUpdates.seq))
      .limit(DOC_PAGE_MAX_ROWS + 1);
    const cut = pageCut(
      sizes.map((row) => ({ seq: row.seq, size: Number(row.size), structs: row.structs })),
      { bytes: DOC_PAGE_MAX_BYTES, structs: DOC_PAGE_MAX_STRUCTS },
      DOC_PAGE_MAX_ROWS,
    );
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
  input: { update: Buffer; markdown: string; version: string; userId: string; structs?: number; placement?: DocPlacement },
): Promise<{ seq: number; epoch: string }> {
  // Deduplicated before the transaction: under the lock only bounded reads run.
  const refs = input.placement ? collectRefs(input.placement) : null;
  return db.transaction(async (tx) => {
    await lockArtifact(tx, artifactId);
    // The seed's row is charged like any update row (`DOC_UPDATE_ROW_BYTES`); its index rows are added below.
    const [created] = await tx.insert(artifactDocState).values({
      artifactId,
      bytesTotal: input.update.length + DOC_UPDATE_ROW_BYTES,
      nextSeq: 2,
      flushedSeq: 1,
      flushedVersion: input.version,
      flushedMarkdown: input.markdown,
    }).onConflictDoNothing({ target: artifactDocState.artifactId }).returning({ epoch: artifactDocState.epoch });
    if (!created) throw new ArtifactDocError(409, 'This doc already has a live state: read it instead', 'doc_seeded');
    const index = await placeRoots(tx, artifactId, input.placement, refs, { bytesTotal: input.update.length + DOC_UPDATE_ROW_BYTES, rootRows: 0, clientRows: 0 });
    if (index.bytes > 0) {
      await tx.update(artifactDocState).set({
        bytesTotal: sql`${artifactDocState.bytesTotal} + ${index.bytes}`,
        rootRows: index.roots,
        clientRows: index.clients,
      }).where(eq(artifactDocState.artifactId, artifactId));
    }
    await tx.insert(artifactDocUpdates).values({ artifactId, seq: 1, epoch: created.epoch, bytes: input.update, createdBy: input.userId, structs: input.structs ?? 0 });
    return { seq: 1, epoch: created.epoch };
  });
}

/**
 * Append one update: the next seq, under the state row's lock until COMMIT.
 * 413 `doc_too_large` when the stored bytes would pass `DOC_MAX_BYTES_TOTAL`.
 * `rows`: the rows the Artifact holds now; past `DOC_COMPACT_ROWS` the doc is
 * marked (`compaction_requested_at`) for the worker to compact.
 */
export async function appendArtifactDocUpdate(
  artifactId: string,
  input: { update: Buffer; userId: string; epoch?: string; structs?: number; placement?: DocPlacement },
): Promise<{ seq: number; rows: number; index: DocIndexReads }> {
  // Deduplicated before the transaction: under the lock only bounded reads run (`readDocIndex`).
  const refs = input.placement ? collectRefs(input.placement) : null;
  return db.transaction(async (tx) => {
    await lockArtifact(tx, artifactId);
    const [state] = await tx.select({
      epoch: artifactDocState.epoch,
      bytesTotal: artifactDocState.bytesTotal,
      rootRows: artifactDocState.rootRows,
      clientRows: artifactDocState.clientRows,
    }).from(artifactDocState).where(eq(artifactDocState.artifactId, artifactId)).for('update');
    if (!state) throw notSeeded();
    assertEpoch(state.epoch, input.epoch);
    // The update's bytes and its row (`DOC_UPDATE_ROW_BYTES`): a stream of tiny pushes is charged what it stores.
    const charge = input.update.length + DOC_UPDATE_ROW_BYTES;
    if (state.bytesTotal + charge > DOC_MAX_BYTES_TOTAL) {
      throw new ArtifactDocError(413, `This doc's live state holds at most ${DOC_MAX_BYTES_TOTAL / 1048576} MiB`, 'doc_too_large');
    }
    const index = await placeRoots(tx, artifactId, input.placement, refs, { bytesTotal: state.bytesTotal + charge, rootRows: state.rootRows, clientRows: state.clientRows });
    const [next] = await tx.update(artifactDocState)
      .set({
        nextSeq: sql`${artifactDocState.nextSeq} + 1`,
        bytesTotal: sql`${artifactDocState.bytesTotal} + ${charge + index.bytes}`,
        rootRows: sql`${artifactDocState.rootRows} + ${index.roots}`,
        clientRows: sql`${artifactDocState.clientRows} + ${index.clients}`,
        // Who wrote, with this push's seq (the old next_seq): named once, by the flush that covers it (`settleWriters`).
        pendingWriters: sql`case when (${artifactDocState.pendingWriters} -> ${input.userId}::text) is not null
            or (select count(*) from jsonb_object_keys(${artifactDocState.pendingWriters})) < ${DOC_MAX_CONTRIBUTORS}
          then ${artifactDocState.pendingWriters} || jsonb_build_object(${input.userId}::text, ${artifactDocState.nextSeq})
          else ${artifactDocState.pendingWriters} end`,
        updatedAt: sql`now()`,
      })
      .where(eq(artifactDocState.artifactId, artifactId))
      .returning({ nextSeq: artifactDocState.nextSeq });
    const seq = next!.nextSeq - 1;
    await tx.insert(artifactDocUpdates).values({ artifactId, seq, epoch: state.epoch, bytes: input.update, createdBy: input.userId, structs: input.structs ?? 0 });
    const [count] = await tx.select({ rows: sql<number>`count(*)::int` }).from(artifactDocUpdates)
      .where(and(eq(artifactDocUpdates.artifactId, artifactId), isNull(artifactDocUpdates.quarantinedAt)));
    const rows = Number(count?.rows ?? 0);
    // Past the threshold the push only marks the doc: the worker compacts it (`doc-compaction.ts`), never a web replica.
    if (rows > DOC_COMPACT_ROWS) {
      await tx.update(artifactDocState)
        .set({ compactionRequestedAt: sql`coalesce(${artifactDocState.compactionRequestedAt}, now())` })
        .where(eq(artifactDocState.artifactId, artifactId));
    }
    return { seq, rows, index: index.reads };
  });
}

/** Back off compaction for this Artifact's `epoch` (`DOC_COMPACTION_BACKOFF_MS`); a later epoch keeps none. Never touches updated_at. */
async function stampCompactionFailed(artifactId: string, epoch: string): Promise<void> {
  await db.update(artifactDocState).set({ compactionFailedAt: sql`clock_timestamp()` })
    .where(and(eq(artifactDocState.artifactId, artifactId), eq(artifactDocState.epoch, epoch)));
}

/** Scan every row, then merge: the merged bytes, null past the page limit, or 'failed'. */
function mergeRows(rows: Array<{ bytes: Buffer }>): Uint8Array | null | 'failed' {
  // Every row is scanned before Yjs reads it: a row stored before a check existed never reaches a decode.
  if (rows.some((row) => !checkDocUpdate(new Uint8Array(row.bytes), 'seed').ok)) return 'failed';
  try {
    // The merged row is stored and served like a push: it meets a push's caps, or the window is skipped.
    return compactDocUpdates(rows.map((row) => new Uint8Array(row.bytes)), { maxBytes: DOC_UPDATE_MAX_BYTES, maxStructs: DOC_MAX_STRUCTS });
  } catch {
    return 'failed';
  }
}

/**
 * ONE compaction step, run by the worker (`doc-compaction.ts`), never by a web
 * replica: merge the oldest update rows of one small window
 * (`compactionWindow`: at most 256 KiB and 50,000 structs) into one row that
 * keeps the highest of their seqs, when the Artifact holds more than the
 * threshold (quarantined rows do not count). `Y.mergeUpdates` only
 * (`compactDocUpdates`): never integration. A merged row past the caps of a
 * push is dropped.
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
 *
 * Scoped to the epoch it planned against. The plan and the merge read without
 * locks, so a push is never held up by a merge. The write phase then takes the
 * state row FOR UPDATE (a reset or the GC job deletes it under the same lock),
 * and checks that the state still has the planned epoch and that the planned
 * rows are still there, live, with the same byte lengths. Otherwise the step
 * answers `stale` and writes nothing: a reset and re-seed reuse seqs from 1.
 * Every write names that epoch too (quarantine, merged row, delete,
 * `bytes_total`, the compaction mark and the back-off stamp).
 */
export async function compactArtifactDoc(artifactId: string): Promise<ArtifactDocCompaction> {
  let planned: string | null = null;
  const outcome = await db.transaction(async (tx): Promise<ArtifactDocCompaction> => {
    const res = await tx.execute(sql`select pg_try_advisory_xact_lock(hashtextextended(${`artifact-doc:${artifactId}`}, 0)) as ok`);
    if ((res as unknown as Array<{ ok: boolean }>)[0]?.ok !== true) return { done: false, reason: 'busy' };
    // ── Plan, without locks ──────────────────────────────────────────────────
    const [state] = await tx.select({
      epoch: artifactDocState.epoch,
      backoff: sql<boolean>`coalesce(${artifactDocState.compactionFailedAt} > now() - make_interval(secs => ${DOC_COMPACTION_BACKOFF_MS / 1000}), false)`,
    }).from(artifactDocState).where(eq(artifactDocState.artifactId, artifactId));
    if (!state) return { done: false, reason: 'below_threshold' };
    const epoch = state.epoch;
    planned = epoch;
    if (state.backoff) return { done: false, reason: 'backoff' };
    const ofEpoch = and(eq(artifactDocUpdates.artifactId, artifactId), eq(artifactDocUpdates.epoch, epoch));
    const live = and(ofEpoch, isNull(artifactDocUpdates.quarantinedAt));
    const sizes = await tx.select({
      seq: artifactDocUpdates.seq,
      size: sql<number>`octet_length(${artifactDocUpdates.bytes})`,
      structs: artifactDocUpdates.structs,
    })
      .from(artifactDocUpdates)
      .where(live)
      .orderBy(asc(artifactDocUpdates.seq));
    if (sizes.length <= DOC_COMPACT_ROWS) {
      // Nothing to do for this epoch: its mark goes (a push past the threshold sets it again).
      await tx.update(artifactDocState).set({ compactionRequestedAt: null })
        .where(and(eq(artifactDocState.artifactId, artifactId), eq(artifactDocState.epoch, epoch)));
      return { done: false, reason: 'below_threshold' };
    }
    const plan = compactionWindow(sizes.map((row) => ({ seq: row.seq, size: Number(row.size), structs: row.structs })));
    if (!plan) return { done: false, reason: 'too_large' };
    const windowRows = await tx.select({ seq: artifactDocUpdates.seq, bytes: artifactDocUpdates.bytes }).from(artifactDocUpdates)
      .where(and(live, gte(artifactDocUpdates.seq, plan.fromSeq), lte(artifactDocUpdates.seq, plan.toSeq)))
      .orderBy(asc(artifactDocUpdates.seq));
    let rows = windowRows;
    let merged = mergeRows(rows);
    let quarantined: number[] = [];
    if (merged === 'failed') {
      // Bounded: each row once, on its own, within the window's byte budget.
      quarantined = rows.filter((row) => !mergesAlone(new Uint8Array(row.bytes))).map((row) => row.seq);
      if (quarantined.length === 0) {
        logger.warn('[artifact-doc] compaction failed', { artifactId, fromSeq: plan.fromSeq, toSeq: plan.toSeq });
        return { done: false, reason: 'failed' };
      }
      rows = rows.filter((row) => !quarantined.includes(row.seq));
      merged = rows.length < 2 ? null : mergeRows(rows);
      if (merged === 'failed') return { done: false, reason: 'failed' };
    }
    if (!merged && quarantined.length === 0) return { done: false, reason: 'too_large' };

    // ── Write, under the state row's lock, only if nothing moved ─────────────
    const [current] = await tx.select({ epoch: artifactDocState.epoch }).from(artifactDocState)
      .where(eq(artifactDocState.artifactId, artifactId)).for('update');
    if (!current || current.epoch !== epoch) return { done: false, reason: 'stale' };
    const now = await tx.select({ seq: artifactDocUpdates.seq, size: sql<number>`octet_length(${artifactDocUpdates.bytes})` })
      .from(artifactDocUpdates)
      .where(and(live, gte(artifactDocUpdates.seq, plan.fromSeq), lte(artifactDocUpdates.seq, plan.toSeq)))
      .orderBy(asc(artifactDocUpdates.seq));
    const same = now.length === windowRows.length
      && now.every((row, i) => row.seq === windowRows[i]!.seq && Number(row.size) === windowRows[i]!.bytes.length);
    if (!same) return { done: false, reason: 'stale' };
    if (quarantined.length > 0) {
      await tx.update(artifactDocUpdates).set({ quarantinedAt: sql`now()` })
        .where(and(ofEpoch, inArray(artifactDocUpdates.seq, quarantined)));
      logger.warn('[artifact-doc] quarantined rows no Yjs reader takes', { artifactId, seqs: quarantined });
    }
    if (!merged) return rows.length < 2 ? { done: false, reason: 'below_threshold' } : { done: false, reason: 'too_large' };
    const fromSeq = rows[0]!.seq;
    const toSeq = rows[rows.length - 1]!.seq;
    const removed = rows.reduce((total, row) => total + row.bytes.length, 0);
    // A merged row holds several people's updates: it names none of them (who wrote is recorded at each flush).
    const mergedStructs = measureDocUpdate(merged, 'seed');
    await tx.update(artifactDocUpdates).set({ bytes: Buffer.from(merged), createdBy: null, structs: mergedStructs.ok ? mergedStructs.structs : 0 })
      .where(and(ofEpoch, eq(artifactDocUpdates.seq, toSeq)));
    await tx.delete(artifactDocUpdates)
      .where(and(live, gte(artifactDocUpdates.seq, fromSeq), lt(artifactDocUpdates.seq, toSeq)));
    await tx.update(artifactDocState)
      // `rows.length` rows (their bytes and row charges) become one row; the index is unchanged.
      .set({ bytesTotal: sql`greatest(0, ${artifactDocState.bytesTotal} - ${removed + (rows.length - 1) * DOC_UPDATE_ROW_BYTES} + ${merged.length})` })
      .where(and(eq(artifactDocState.artifactId, artifactId), eq(artifactDocState.epoch, epoch)));
    return { done: true, fromSeq, toSeq, rows: rows.length, ...(quarantined.length > 0 ? { quarantined } : {}) };
  });
  if (planned && !outcome.done && (outcome.reason === 'failed' || outcome.reason === 'too_large')) await stampCompactionFailed(artifactId, planned);
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
 * Returns who wrote (`contributors`, at most `DOC_MAX_CONTRIBUTORS`), for one
 * audit row each (`recordArtifactDocEdits`): the writers whose LAST push is in
 * (the previous flushed seq, `seq`] (`settleWriters`). They leave the pending
 * map; a writer with a newer push stays and is named by the flush that covers
 * it. A replay, an equal seq or an older seq names nobody, so stepwise flushes
 * name each push once.
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
      pendingWriters: artifactDocState.pendingWriters,
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
    // The state row is locked FOR UPDATE: no push changes the map between this read and the write.
    const settled = decision.advanced ? settleWriters(state.pendingWriters, state.flushedSeq, input.seq) : null;
    await tx.update(artifactDocState).set({
      flushedSeq: input.seq,
      flushedVersion: input.version,
      flushedMarkdown: input.markdown,
      ...(settled ? { pendingWriters: settled.remaining } : {}),
      updatedAt: sql`now()`,
    }).where(eq(artifactDocState.artifactId, artifactId));
    return { flushedSeq: input.seq, contributors: settled?.named ?? [], fromSeq: state.flushedSeq + 1, toSeq: input.seq };
  });
}

/**
 * `POST …/doc/reset`: delete the live state, under its row lock, in one
 * transaction (a poisoned update, or a client that must start over). Its
 * update rows and root index go with it (foreign keys on the state). The
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
      // Cascades to this epoch's rows (`artifact_doc_updates_epoch_fk`), roots and clients: no other epoch's rows exist.
      await tx.delete(artifactDocState).where(eq(artifactDocState.artifactId, artifactId));
    }
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

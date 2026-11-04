/**
 * The decisions of co-edited doc Artifacts (KRTX-3670), as pure functions:
 * who holds the lease, which flush counts, how a page of updates is cut, and
 * which rows compaction merges. `doc-service.ts` applies them in SQL
 * transactions; nothing here reads a clock or a database.
 */

/** A lease lasts this long; the holder renews it every 5 s. */
export const DOC_LEASE_TTL_MS = 15_000;
/** One pushed update, decoded. */
export const DOC_UPDATE_MAX_BYTES = 512 * 1024;
/**
 * The seed update, decoded. It is the whole doc, so it is larger than one
 * push: a 1 MiB Markdown file encodes to more than 512 KiB of Yjs state.
 */
export const DOC_SEED_UPDATE_MAX_BYTES = 2 * 1024 * 1024;
/** The Markdown of a seed or a flush, in UTF-8 bytes (the co-editing guard's limit). */
export const DOC_MARKDOWN_MAX_BYTES = 1_048_576;
/** Update bytes in one GET page; a single larger row still goes out alone. */
export const DOC_PAGE_MAX_BYTES = 8 * 1024 * 1024;
/** Rows read for one page at most. */
export const DOC_PAGE_MAX_ROWS = 1_000;
/** Structs in one page (a viewer integrates at most this many per pull): the cap of one push. */
export const DOC_PAGE_MAX_STRUCTS = 200_000;
/** An Artifact with more update rows than this is compacted (by the worker, `doc-compaction.ts`). */
export const DOC_COMPACT_ROWS = 500;
/**
 * One compaction step merges at most this many bytes and structs. `Y.mergeUpdates`
 * costs per struct: 0.07-0.35 µs measured here on crafted shapes (4-byte items,
 * interleaved clocks), up to ~2 µs reported elsewhere. 50,000 structs keep one
 * step near 100 ms in the slowest case and near 20 ms here.
 */
export const DOC_COMPACT_WINDOW_BYTES = 256 * 1024;
export const DOC_COMPACT_WINDOW_STRUCTS = 50_000;
/** After a compaction that threw (or would pass the page limit), none for this long. */
export const DOC_COMPACTION_BACKOFF_MS = 10 * 60_000;
/** Stored update bytes per Artifact; past it a push answers 413 `doc_too_large` and clients fall back to autosave. */
export const DOC_MAX_BYTES_TOTAL = 16 * 1024 * 1024;
/** Pushed bytes per person per API process. */
export const DOC_BYTE_RATE = { bytesPerSecond: 2 * 1024 * 1024, burstBytes: 4 * 1024 * 1024 } as const;
/** The GC job deletes a doc state idle this long, with its lease free or expired this long, and everything flushed. */
export const DOC_GC_IDLE_MS = 10 * 60_000;

export interface DocLease {
  holder: string | null;
  userId: string | null;
  expiresAt: Date | null;
}

const FREE: DocLease = { holder: null, userId: null, expiresAt: null };

/** The lease is this caller's: the same client id from the same person. */
function ours(lease: DocLease, holder: string, userId: string): boolean {
  return lease.holder === holder && lease.userId === userId;
}

/** Someone holds the lease and it has not ended. */
export function leaseLive(lease: DocLease, now: Date): boolean {
  return lease.holder !== null && lease.expiresAt !== null && lease.expiresAt.getTime() > now.getTime();
}

/**
 * What a lease call did. `renew` (our own live lease, every 5 s per tab) is a
 * heartbeat: it writes no audit row. A release of a lease that is not ours is
 * `contested`.
 */
export type DocLeaseKind = 'acquire' | 'renew' | 'release' | 'contested';

/**
 * `POST …/doc/lease`. Acquire when the lease is free, expired or already ours;
 * renew when ours; release when ours. A live lease of another tab, or the same
 * client id from another person, is contested: `leader: false`, nothing written.
 * `write`: the row must be updated to `next`.
 */
export function decideLease(
  current: DocLease,
  request: { holder: string; userId: string; release: boolean },
  now: Date,
): { kind: DocLeaseKind; leader: boolean; write: boolean; next: DocLease } {
  const mine = ours(current, request.holder, request.userId);
  if (request.release) {
    return mine ? { kind: 'release', leader: false, write: true, next: FREE } : { kind: 'contested', leader: false, write: false, next: current };
  }
  if (mine || !leaseLive(current, now)) {
    return {
      kind: mine && leaseLive(current, now) ? 'renew' : 'acquire',
      leader: true,
      write: true,
      next: { holder: request.holder, userId: request.userId, expiresAt: new Date(now.getTime() + DOC_LEASE_TTL_MS) },
    };
  }
  return { kind: 'contested', leader: false, write: false, next: current };
}

/**
 * `POST …/doc/reset`: the lease holder may reset, and anyone (with write
 * access) while the lease is free or expired. Another live holder → 409.
 */
export function decideReset(current: DocLease, request: { holder: string; userId: string }, now: Date): boolean {
  return ours(current, request.holder, request.userId) || !leaseLive(current, now);
}

/** Writers one flush names at most, and the pending list holds at most. */
export const DOC_MAX_CONTRIBUTORS = 200;

/**
 * `POST …/doc/flushed`. Only the lease holder records a flush; a lease that
 * expired but nobody took over is still its holder's (no one else wrote the
 * file). A seq past the newest update is refused: those updates do not exist.
 * The version must be the file's entry version now (read server-side from
 * Files): a replay of an old flush, an invented version, or a doc without a
 * file is refused. An older seq is accepted and sets nothing (`apply: false`).
 * `advanced`: the flush moved past the previous one, so the file holds new
 * writers' text; a replay or an equal seq names nobody.
 */
export function decideFlush(
  state: { flushedSeq: number; latestSeq: number; lease: DocLease; currentVersion: string | null },
  input: { holder: string; userId: string; seq: number; version: string },
): { ok: true; apply: boolean; advanced: boolean } | { ok: false; code: 'not_leader' | 'invalid_seq' | 'version_mismatch' } {
  if (!ours(state.lease, input.holder, input.userId)) return { ok: false, code: 'not_leader' };
  if (input.seq > state.latestSeq) return { ok: false, code: 'invalid_seq' };
  if (state.currentVersion === null || input.version !== state.currentVersion) return { ok: false, code: 'version_mismatch' };
  return { ok: true, apply: input.seq >= state.flushedSeq, advanced: input.seq > state.flushedSeq };
}

/**
 * How many of `rows` (ascending seq) one page carries: as many as fit the
 * `budget` in bytes and in structs, and always at least one, so a large row
 * cannot stall a client (no stored row passes either budget alone). `hasMore`
 * when rows are left, or the caller read `maxRows` + 1.
 */
export function pageCut(
  rows: ReadonlyArray<{ seq: number; size: number; structs: number }>,
  budget: { bytes: number; structs: number },
  maxRows = Number.POSITIVE_INFINITY,
) {
  let count = 0;
  let bytes = 0;
  let structs = 0;
  for (const row of rows) {
    if (count >= maxRows) break;
    if (count > 0 && (bytes + row.size > budget.bytes || structs + row.structs > budget.structs)) break;
    bytes += row.size;
    structs += row.structs;
    count += 1;
  }
  return { count, hasMore: count < rows.length };
}

/**
 * The rows one compaction step merges, given every row of an Artifact
 * (ascending seq, with the struct count each row stored): null at
 * `DOC_COMPACT_ROWS` rows or fewer. Otherwise the longest run of neighbours
 * from the oldest that fits `DOC_COMPACT_WINDOW_BYTES` and
 * `DOC_COMPACT_WINDOW_STRUCTS`; a first row too large to pair (a seed, an
 * earlier merge) is skipped. Any run of neighbours may merge into its highest
 * seq: a client past part of the run gets the merged row, and Yjs applies the
 * part it knows as a no-op.
 */
export function compactionWindow(rows: ReadonlyArray<{ seq: number; size: number; structs: number }>) {
  if (rows.length <= DOC_COMPACT_ROWS) return null;
  for (let start = 0; start < rows.length - 1; start++) {
    let bytes = 0;
    let structs = 0;
    let end = start;
    while (
      end < rows.length
      && bytes + rows[end]!.size <= DOC_COMPACT_WINDOW_BYTES
      && structs + rows[end]!.structs <= DOC_COMPACT_WINDOW_STRUCTS
    ) {
      bytes += rows[end]!.size;
      structs += rows[end]!.structs;
      end += 1;
    }
    if (end - start >= 2) return { fromSeq: rows[start]!.seq, toSeq: rows[end - 1]!.seq, rows: end - start };
  }
  return null;
}

/**
 * Pushed bytes per person, in this process: a bucket of `burstBytes` that
 * refills at `bytesPerSecond`. A refused take spends nothing. The clock is
 * passed in, so a test needs no timer.
 */
export class DocByteBudget {
  // replica-local: every API process keeps its own buckets, so the fleet allows
  // the rate × replicas. It stops a flood, it meters no quota.
  private readonly buckets = new Map<string, { bytes: number; at: number }>();

  constructor(private readonly rate: { bytesPerSecond: number; burstBytes: number } = DOC_BYTE_RATE, private readonly maxKeys = 50_000) {}

  take(key: string, bytes: number, nowMs: number): { allowed: true } | { allowed: false; retryAfterMs: number } {
    const { bytesPerSecond, burstBytes } = this.rate;
    if (bytes > burstBytes) return { allowed: false, retryAfterMs: Math.ceil((burstBytes / bytesPerSecond) * 1000) };
    const prior = this.buckets.get(key);
    const available = prior ? Math.min(burstBytes, prior.bytes + ((nowMs - prior.at) / 1000) * bytesPerSecond) : burstBytes;
    if (available < bytes) {
      return { allowed: false, retryAfterMs: Math.ceil(((bytes - available) / bytesPerSecond) * 1000) };
    }
    if (!prior && this.buckets.size >= this.maxKeys) {
      // The oldest-inserted tenth goes: a flood of new keys cannot grow the map without bound.
      let drop = Math.ceil(this.maxKeys / 10);
      for (const old of this.buckets.keys()) {
        this.buckets.delete(old);
        if (--drop <= 0) break;
      }
    }
    this.buckets.set(key, { bytes: available - bytes, at: nowMs });
    return { allowed: true };
  }
}

/**
 * `GET …/doc` past seq 0 without `base`: a tab catching up on updates it was
 * pinged about, up to ~10 a second per tab. It returns no whole document: it
 * writes one audit row per person and Artifact per 10 min
 * (`DocReadAuditThrottle`), the rest are heartbeats. A read from seq 0, or
 * one with the file text (`base`), returns the document: it always keeps its
 * row, as a file read does.
 */
export function isIncrementalDocPull(query: { after: number; base: boolean }): boolean {
  return query.after > 0 && !query.base;
}

/** A person's catch-up pulls of one Artifact write one audit row per this window. */
export const DOC_CATCH_UP_AUDIT_MS = 10 * 60_000;

/**
 * Which catch-up pull writes its audit row: the first per key (person and
 * Artifact) in each `windowMs`. Per process: with N API replicas a person
 * may get up to N rows per window. The map is bounded; a key it forgot is
 * recorded again, so it can only write more rows, never fewer.
 */
export class DocReadAuditThrottle {
  // replica-local: each API process remembers its own last rows; at most `maxKeys` entries.
  private readonly last = new Map<string, number>();

  constructor(private readonly windowMs = DOC_CATCH_UP_AUDIT_MS, private readonly maxKeys = 50_000) {}

  get size(): number {
    return this.last.size;
  }

  shouldRecord(key: string, nowMs: number): boolean {
    const at = this.last.get(key);
    if (at !== undefined && nowMs - at < this.windowMs) return false;
    if (at === undefined && this.last.size >= this.maxKeys) {
      // The oldest-inserted tenth goes.
      let drop = Math.ceil(this.maxKeys / 10);
      for (const old of this.last.keys()) {
        this.last.delete(old);
        if (--drop <= 0) break;
      }
    }
    // Re-inserted, so the map stays in order of the last recorded row.
    this.last.delete(key);
    this.last.set(key, nowMs);
    return true;
  }
}

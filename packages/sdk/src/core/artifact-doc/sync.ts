/**
 * The sync engine of one co-edited Artifact doc (KRTX-3670, contract v2).
 *
 * Framework-free and byte-based: the host owns the Yjs `Y.Doc` and hands the
 * engine two callbacks, `apply` (put a remote update into the doc) and `merge`
 * (`Y.mergeUpdates`). The SDK has no yjs dependency. The clock (`timers`) and
 * the REST calls (`client`) are injectable, so the same code runs in a
 * browser, React Native, Node and a test.
 *
 * Owns: the load or seed, the ordered push queue (50 ms batches, one push in
 * flight, retries that never drop an update), the serial pulls (on a
 * live-socket ping through `notify`, else a poll every 3 s), `covered`, the
 * lease of the tab that writes the Markdown file, the flush record, and the
 * reset: when the server's doc is no longer the one this tab loaded (deleted,
 * re-seeded under another epoch, or poisoned), the engine stops and the host
 * starts again on a fresh `Y.Doc`.
 */

import { ApiError } from '../http/api/errors';
import {
  getArtifactDoc,
  leaseArtifactDoc,
  markArtifactDocFlushed,
  pushArtifactDocUpdate,
  resetArtifactDoc,
  seedArtifactDoc,
  type ArtifactDocPage,
  type ArtifactDocSeed,
} from '../rest/projects-client/artifact-doc';
import type { EventStreamTimerHandle, EventStreamTimers } from '../stream/event-stream';

/**
 * - `connecting`: `start` is loading or seeding the doc.
 * - `synced`: loaded, and every local update is acknowledged.
 * - `syncing`: local updates wait for a push or its answer.
 * - `retrying`: a push, pull or load failed (network, `5xx`, `429`) and is
 *   retried with backoff, or a poisoned doc waits for its reset.
 * - `reset`: the doc this tab loaded is gone (`onReset`). The engine is idle
 *   until the host calls `start` again on a fresh `Y.Doc`.
 * - `failed`: a refusal the engine cannot retry (`400`, `403`, `404`,
 *   `413 update_too_large` on one update, `413 doc_too_large`, a throwing
 *   callback). `onError` got the error. Final: the host falls back to autosave.
 * - `closed`: the host called `close()`. Final.
 */
export type ArtifactDocSyncStatus = 'connecting' | 'synced' | 'syncing' | 'retrying' | 'reset' | 'failed' | 'closed';

/**
 * Why the doc was reset:
 * - `not_seeded`: the server has no doc state: a tab reset it, or the GC
 *   deleted an idle one;
 * - `epoch`: the doc was seeded again since this tab loaded it (another epoch);
 * - `poisoned`: a stored update made `apply` throw; the engine reset the doc
 *   on the server (or waited for the leader to).
 */
export type ArtifactDocResetReason = 'not_seeded' | 'epoch' | 'poisoned';

/** The REST calls the engine makes. The default is the SDK's doc functions; a test injects fakes. */
export interface ArtifactDocSyncClient {
  get: typeof getArtifactDoc;
  seed: typeof seedArtifactDoc;
  push: typeof pushArtifactDocUpdate;
  lease: typeof leaseArtifactDoc;
  flushed: typeof markArtifactDocFlushed;
  reset: typeof resetArtifactDoc;
}

/** The Markdown file text the doc state was last made equal to, its version, and the seq that flush covered. */
export interface ArtifactDocBase {
  markdown: string;
  version: string | null;
  seq: number;
}

export interface ArtifactDocSyncOptions {
  projectId: string;
  artifactId: string;
  /** This tab's lease id, unique per tab: 1–64 of `A–Z a–z 0–9 . _ : -` (a random UUID fits). */
  holder: string;
  /**
   * Put a remote update (or this tab's accepted seed) into the current doc,
   * e.g. `Y.applyUpdate(docRef.current, update, remoteOrigin)`. Do not push
   * updates with that origin back. Yjs applies a known update as a no-op,
   * and the engine relies on it. A throw on a stored update marks the doc
   * poisoned: the engine resets it (`onReset({ reason: 'poisoned' })`).
   */
  apply: (update: Uint8Array) => void;
  /** Merge updates into one, keeping all of them, e.g. `Y.mergeUpdates`. A throw is fatal. */
  merge: (updates: Uint8Array[]) => Uint8Array;
  /** This tab gained (`true`) or lost (`false`) the lease: it alone writes the Markdown file while it leads. */
  onLeader?: (leader: boolean) => void;
  /** The status changed. The initial `connecting` is not reported. */
  onStatus?: (status: ArtifactDocSyncStatus) => void;
  /** A refusal the engine cannot retry. The status is `failed` right after. */
  onError?: (error: unknown) => void;
  /**
   * The doc this tab loaded is gone; called once per reset, with the status
   * already `reset`. The engine stopped: unacknowledged pushes are dropped,
   * `flushed` and `base` callers got a rejection with code `doc_reset`, and
   * `onLeader(false)` ran. The host keeps its editor's Markdown, builds a
   * fresh `Y.Doc` (and `apply` targets it), calls `start(buildSeed)` again,
   * and then merges the person's unsynced text into the new doc.
   */
  onReset?: (event: { reason: ArtifactDocResetReason }) => void;
  /** Test-only clock/timer override. Defaults to the real `Date.now`/`setTimeout`. */
  timers?: EventStreamTimers;
  /** The REST calls. Default: the SDK's doc functions. */
  client?: ArtifactDocSyncClient;
}

/**
 * One co-edited doc. Methods never throw; `start`, `flushed` and `base`
 * reject once the engine is closed or failed, and with code `doc_reset` on a
 * reset.
 */
export interface ArtifactDocSync {
  readonly status: ArtifactDocSyncStatus;
  /** True while this tab holds the lease. */
  readonly leader: boolean;
  /**
   * The highest seq such that every update with a seq at or below it is in
   * the local doc (pulled, or pushed and acknowledged). A pull with no push of
   * this tab in flight covers every seq up to its last row (a gap is a
   * compacted range). A pull during a push covers only the rows it returned:
   * the push's own seq may be in a gap, so `covered` waits for its ack.
   * Capture it when serializing the Markdown for `flushed({ seq })`.
   */
  readonly covered: number;
  /**
   * Load the doc: read every stored update (`after=0&base=true`) and apply it.
   * An unseeded doc is seeded with `buildSeed()`. Always build the seed from
   * the current Markdown FILE, in a scratch `Y.Doc`, never from live state.
   * The engine applies the seed only when the server accepts it: on `409
   * doc_seeded` another tab won, and its doc is pulled and applied instead.
   *
   * Call it once, and again only after `onReset` (status `reset`), on a fresh
   * `Y.Doc`; `restart` is then true. It does not change what to seed.
   *
   * Resolves once the doc is loaded: `created` is true when this tab seeded
   * it, and `base` is the last flushed Markdown. The lease is taken right
   * after (`onLeader`). Transient failures retry; a refusal rejects (and
   * fails the engine); a reset during the load rejects with code `doc_reset`.
   */
  start(buildSeed: (context: { restart: boolean }) => ArtifactDocSeed | Promise<ArtifactDocSeed>): Promise<{ created: boolean; base: ArtifactDocBase | null }>;
  /**
   * Send one local Yjs update. Updates within 50 ms go out as one merged
   * push; one push is in flight at a time; order is kept; a failed push is
   * retried (1 s doubling to 30 s) with the later updates merged behind it.
   * Updates pushed before `start` resolves wait for the load. During a reset
   * they are dropped.
   */
  push(update: Uint8Array): void;
  /**
   * A live-socket `changed doc` ping with its seq: pull when that seq is not
   * here yet. `0` (the reset ping) and a seq below the highest here (seqs
   * restart at 1 after a re-seed) pull at once too, unless the seq is this
   * tab's own echo; the pull compares epochs.
   */
  notify(seq: number): void;
  /**
   * The leader wrote `markdown` to the file as `version`. Waits until every
   * update pushed before this call is acknowledged, then records the flush
   * with `seq`: the `covered` the host captured when it serialized
   * `markdown`, else `covered` now. A newer call replaces a waiting one; both
   * resolve with the newer's result. `flushed_seq` above `seq` means the
   * server kept a later flush. Rejects on `409 not_leader` (the lease is
   * lost: `onLeader(false)`), and with `RangeError` for a `seq` that is not
   * an integer ≥ 0.
   */
  flushed(input: { version: string; markdown: string; seq?: number }): Promise<{ seq: number; flushed_seq: number }>;
  /** Pull with `base=true` and return the last flushed Markdown, or null when the server sent none. */
  base(): Promise<ArtifactDocBase | null>;
  /**
   * Send the unacknowledged updates (keepalive when they fit in 32 KiB),
   * release the lease (keepalive), and stop every timer. No callback runs
   * after it. Idempotent; resolves when those requests settled, never rejects.
   */
  close(): Promise<void>;
}

const BATCH_MS = 50;
const POLL_MS = 3_000;
const LEASE_RENEW_MS = 5_000;
const LEASE_TTL_MS = 15_000;
/** A leader whose renewals fail steps down this long before the server's TTL lapses. */
const LEASE_MARGIN_MS = 2_000;
const BASE_RETRY_MS = 1_000;
const MAX_RETRY_MS = 30_000;
const RETRY_JITTER = 0.5;
/** The server refuses a decoded update over 512 KiB. */
const MAX_UPDATE_BYTES = 512 * 1024;
/** Browsers cap the keepalive bodies in flight at 64 KiB; base64 adds a third. */
const KEEPALIVE_MAX_BYTES = 32 * 1024;
/** Another tab seeding first more often than this in one load is a server fault. */
const MAX_SEED_CONFLICTS = 3;
const RETRY_STATUSES = new Set([401, 408, 425, 429]);

const realTimers: EventStreamTimers = {
  now: () => Date.now(),
  setTimeout: (handler, ms) => setTimeout(handler, ms),
  clearTimeout: (handle) => clearTimeout(handle),
  random: () => Math.random(),
};

const defaultClient: ArtifactDocSyncClient = {
  get: getArtifactDoc,
  seed: seedArtifactDoc,
  push: pushArtifactDocUpdate,
  lease: leaseArtifactDoc,
  flushed: markArtifactDocFlushed,
  reset: resetArtifactDoc,
};

/** Thrown inside the engine when a result belongs to a closed engine or an older generation. */
const STALE = { stale: true } as const;

interface Waiter<T> {
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
}

interface FlushJob {
  input: { version: string; markdown: string; seq?: number };
  /** The flush waits until this many updates are acknowledged. */
  target: number;
  waiters: Array<Waiter<{ seq: number; flushed_seq: number }>>;
}

const statusOf = (error: unknown) => {
  const status = (error as { status?: unknown } | null)?.status;
  return typeof status === 'number' ? status : undefined;
};
const codeOf = (error: unknown) => (error as { code?: unknown } | null)?.code;
const isRefusal = (error: unknown, status: number, code: string) => statusOf(error) === status && codeOf(error) === code;

/** Network, timeout, `401` (the token refreshes), `408`, `425`, `429` and `5xx` are retried. */
function transient(error: unknown): boolean {
  const status = statusOf(error);
  if (status !== undefined && status > 0) return status >= 500 || RETRY_STATUSES.has(status);
  return error instanceof ApiError;
}

/** The highest seq of a page. A loop, not a spread: a page can hold ~400k rows. */
function lastSeq(page: ArtifactDocPage): number {
  let last = 0;
  for (const row of page.updates) if (row.seq > last) last = row.seq;
  return last;
}

function baseOf(page: ArtifactDocPage): ArtifactDocBase | null {
  const flushed = page.flushed;
  return flushed && typeof flushed.markdown === 'string' ? { markdown: flushed.markdown, version: flushed.version, seq: flushed.seq } : null;
}

/** The rejection of `start`, `flushed` and `base` callers on a reset. */
function resetError(reason: ArtifactDocResetReason): Error {
  return Object.assign(new Error(`The co-edited doc was reset (${reason})`), { code: 'doc_reset', reason });
}

/** Start the sync of one co-edited doc. Nothing runs before `start()`. */
export function createArtifactDocSync(options: ArtifactDocSyncOptions): ArtifactDocSync {
  const t = options.timers ?? realTimers;
  const client = options.client ?? defaultClient;
  const { projectId, artifactId, holder } = options;

  let status: ArtifactDocSyncStatus = 'connecting';
  let ended = false;
  let ready = false;
  /** Bumps on every halt; an answer from an older generation is dropped. */
  let generation = 0;
  let buildSeed: ((context: { restart: boolean }) => ArtifactDocSeed | Promise<ArtifactDocSeed>) | null = null;
  let started = false;
  /** Stopped for a reset: pushes and pings are dropped until `start` runs again. */
  let halted = false;
  let starting: Waiter<{ created: boolean; base: ArtifactDocBase | null }> | null = null;
  let loadFailing = false;
  let closing: Promise<void> | null = null;

  // The doc this tab loaded: its epoch (null and unknown when the seed answer had none).
  let epoch: string | null = null;
  let epochKnown = false;

  // Coverage: `covered`, plus the seqs here above it.
  let covered = 0;
  const seen = new Set<number>();
  /** The highest seq here: a ping below it may come from a new epoch (seqs restart at 1). */
  let highest = 0;
  /** This tab's own recent seqs: their pings are echoes. */
  const ownSeqs = new Set<number>();
  /** The highest ping that arrived while loading. */
  let notified = 0;

  // Pushes: the head `inFlight` parts of `queue` are in the request in flight.
  const queue: Uint8Array[] = [];
  let inFlight = 0;
  let pushEpoch = 0;
  /** When the oldest part not in flight was queued; null: send it as soon as allowed. */
  let waitingSince: number | null = null;
  let partLimit = Number.POSITIVE_INFINITY;
  let pushFailures = 0;
  let pushFailing = false;
  let enqueued = 0;
  let acked = 0;

  // Pulls.
  let pulling = false;
  let pullAgain = false;
  let pullFailing = false;
  let baseWaiters: Array<Waiter<ArtifactDocBase | null>> = [];
  /** The `base()` callers the pull in flight answers. */
  let pullWaiters: Array<Waiter<ArtifactDocBase | null>> = [];

  // Lease.
  let leader = false;
  /** False after a `403`/`404` lease: a viewer without write access never leads. */
  let leasing = true;
  let leaseRequested = false;

  // Flush.
  let flushJob: FlushJob | null = null;
  let flushSending: FlushJob | null = null;
  let flushFailures = 0;

  let batchTimer: EventStreamTimerHandle | undefined;
  let retryTimer: EventStreamTimerHandle | undefined;
  let pollTimer: EventStreamTimerHandle | undefined;
  let leaseTimer: EventStreamTimerHandle | undefined;
  let leaderTimer: EventStreamTimerHandle | undefined;
  let flushTimer: EventStreamTimerHandle | undefined;
  let loadTimer: EventStreamTimerHandle | undefined;

  function clearTimers() {
    for (const timer of [batchTimer, retryTimer, pollTimer, leaseTimer, leaderTimer, flushTimer, loadTimer]) t.clearTimeout(timer);
    batchTimer = retryTimer = pollTimer = leaseTimer = leaderTimer = flushTimer = loadTimer = undefined;
  }

  function call<A extends unknown[]>(handler: ((...args: A) => void) | undefined, ...args: A) {
    try {
      handler?.(...args);
    } catch {
      // A host callback never breaks the engine.
    }
  }

  function setStatus(next: ArtifactDocSyncStatus) {
    if (status === next) return;
    status = next;
    call(options.onStatus, next);
  }

  function refresh() {
    if (ended || halted) return;
    if (!ready) setStatus(loadFailing ? 'retrying' : 'connecting');
    else if (pushFailing || pullFailing) setStatus('retrying');
    else setStatus(queue.length > 0 ? 'syncing' : 'synced');
  }

  function setLeader(next: boolean) {
    if (!next) {
      t.clearTimeout(leaderTimer);
      leaderTimer = undefined;
    }
    if (leader === next) return;
    leader = next;
    call(options.onLeader, next);
  }

  /** `{ epoch }` for every write once the epoch is known: the server answers `409 epoch_mismatch` for another. */
  const epochOption = (): { epoch?: string } => (epochKnown && epoch !== null ? { epoch } : {});

  /** A write was refused because the doc this tab loaded is gone. */
  function resetRefusal(error: unknown): boolean {
    if (isRefusal(error, 409, 'doc_not_seeded')) resetDetected('not_seeded');
    else if (isRefusal(error, 409, 'epoch_mismatch')) resetDetected('epoch');
    else return false;
    return true;
  }

  function backoff(failures: number): number {
    const base = Math.min(BASE_RETRY_MS * 2 ** Math.min(failures - 1, 5), MAX_RETRY_MS);
    return Math.min(Math.round(base * (1 + RETRY_JITTER * (t.random?.() ?? 0))), MAX_RETRY_MS);
  }

  function rejectWaiters(reason: unknown) {
    starting?.reject(reason);
    starting = null;
    for (const waiter of [...pullWaiters.splice(0), ...baseWaiters.splice(0)]) waiter.reject(reason);
    for (const job of [flushJob, flushSending]) for (const waiter of job?.waiters ?? []) waiter.reject(reason);
    flushJob = flushSending = null;
  }

  // ── Ending ────────────────────────────────────────────────────────────────

  function end(final: 'closed' | 'failed', reason: unknown) {
    ended = true;
    ready = false;
    clearTimers();
    rejectWaiters(reason);
    setStatus(final);
  }

  function release(): Promise<unknown> | null {
    if (!leaseRequested || !leasing) return null;
    return client.lease(projectId, artifactId, { holder, release: true, ...epochOption() }, { keepalive: true }).catch(() => undefined);
  }

  function fail(error: unknown) {
    if (ended) return;
    call(options.onError, error);
    setLeader(false);
    void release();
    end('failed', error);
  }

  // ── Reset ─────────────────────────────────────────────────────────────────

  /**
   * Stop everything this doc runs: no push, pull, lease or flush. The
   * unacknowledged pushes are dropped: they belong to a doc that is gone.
   */
  function halt(reason: ArtifactDocResetReason) {
    generation++;
    halted = true;
    ready = false;
    clearTimers();
    queue.length = 0;
    inFlight = 0;
    acked = enqueued;
    waitingSince = null;
    partLimit = Number.POSITIVE_INFINITY;
    pushFailures = 0;
    pushFailing = false;
    pulling = pullAgain = pullFailing = loadFailing = false;
    flushFailures = 0;
    notified = 0;
    rejectWaiters(resetError(reason));
    resetCoverage();
    epoch = null;
    epochKnown = false;
    leasing = true;
    setLeader(false);
  }

  function announceReset(reason: ArtifactDocResetReason) {
    setStatus('reset');
    call(options.onReset, { reason });
  }

  /** The server's doc is not the one this tab loaded. */
  function resetDetected(reason: 'not_seeded' | 'epoch') {
    if (ended || halted) return;
    halt(reason);
    announceReset(reason);
  }

  /**
   * A stored update made `apply` throw. Reset the doc on the server; when
   * another tab holds the lease (or this tab may not write), wait for that
   * reset, checking every 3 s. Then report it like any reset.
   */
  function poisoned() {
    if (ended || halted) return;
    const poisonedEpoch = epoch;
    halt('poisoned');
    setStatus('retrying');
    const gen = generation;
    const stale = () => ended || gen !== generation;
    void (async () => {
      for (;;) {
        try {
          await client.reset(projectId, artifactId, { holder });
          if (stale()) return;
          break;
        } catch (error) {
          if (stale()) return;
          if (isRefusal(error, 409, 'not_leader') || statusOf(error) === 403) {
            try {
              const page = await client.get(projectId, artifactId, { after: Number.MAX_SAFE_INTEGER, base: false });
              if (stale()) return;
              if (!page.seeded || page.epoch !== poisonedEpoch) break;
            } catch (readError) {
              if (stale()) return;
              if (!transient(readError)) return fail(readError);
            }
          } else if (!transient(error)) {
            return fail(error);
          }
        }
        await sleep(POLL_MS);
        if (stale()) return;
      }
      announceReset('poisoned');
    })();
  }

  // ── Coverage ──────────────────────────────────────────────────────────────

  function advance() {
    while (seen.delete(covered + 1)) covered++;
    for (const seq of seen) if (seq <= covered) seen.delete(seq);
  }

  /** This tab's own update was stored as `seq`. */
  function own(seq: number) {
    if (seq > covered) seen.add(seq);
    if (seq > highest) highest = seq;
    advance();
  }

  /** A pushed update's seq: its ping is an echo, never a sign of a new epoch. */
  function echo(seq: number) {
    ownSeqs.add(seq);
    if (ownSeqs.size > 1_024) ownSeqs.delete(ownSeqs.values().next().value as number);
  }

  /**
   * Apply a page of `seq > after` and account for it. Every row is applied,
   * this tab's own included: a compacted row under an own seq can hold other
   * tabs' updates. A row `apply` cannot take poisons the doc: nothing after
   * it is applied, and `STALE` is thrown. With `vouch`, every seq from
   * `after` to the last row counts as here: the server stores updates in seq
   * order (one transaction per append), returns every row above `after`, and
   * a compacted row holds every seq since the row before it. Without `vouch`
   * (a push of this tab was in flight, so its seq may be in a gap), only the
   * returned rows count.
   */
  function absorb(page: ArtifactDocPage, after: number, vouch: boolean) {
    for (const row of page.updates) {
      try {
        options.apply(row.update);
      } catch {
        poisoned();
        throw STALE;
      }
    }
    if (page.updates.length === 0) return;
    const last = lastSeq(page);
    if (last > highest) highest = last;
    if (vouch && after <= covered) covered = Math.max(covered, last);
    else for (const row of page.updates) if (row.seq > covered) seen.add(row.seq);
    advance();
  }

  function resetCoverage() {
    covered = 0;
    highest = 0;
    seen.clear();
    ownSeqs.clear();
  }

  /** Check a page against the loaded doc. False: it was reset, and the reset is reported. */
  function sameDoc(page: ArtifactDocPage): boolean {
    if (!page.seeded) {
      resetDetected('not_seeded');
      return false;
    }
    if (epochKnown && page.epoch !== epoch) {
      resetDetected('epoch');
      return false;
    }
    if (!epochKnown && page.epoch !== null) {
      epoch = page.epoch;
      epochKnown = true;
    }
    return true;
  }

  // ── Load ──────────────────────────────────────────────────────────────────

  function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
      loadTimer = t.setTimeout(() => {
        loadTimer = undefined;
        resolve();
      }, ms);
    });
  }

  /** Run one load request; retry it while it fails transiently. */
  async function retrying<T>(gen: number, request: () => Promise<T>): Promise<T> {
    for (let failures = 1; ; failures++) {
      try {
        const value = await request();
        if (ended || gen !== generation) throw STALE;
        return value;
      } catch (error) {
        if (error === STALE || ended || gen !== generation) throw STALE;
        if (!transient(error)) throw error;
        loadFailing = true;
        refresh();
        await sleep(backoff(failures));
        if (ended || gen !== generation) throw STALE;
      }
    }
  }

  async function load(gen: number, restart: boolean): Promise<{ created: boolean; base: ArtifactDocBase | null }> {
    for (let conflicts = 0; ; ) {
      const first = await retrying(gen, () => client.get(projectId, artifactId, { after: 0, base: true }));
      if (first.seeded) {
        epoch = first.epoch;
        epochKnown = first.epoch !== null;
        absorb(first, 0, true);
        let page = first;
        while (page.has_more && page.updates.length > 0) {
          const after = Math.max(covered, lastSeq(page));
          page = await retrying(gen, () => client.get(projectId, artifactId, { after, base: false }));
          if (!sameDoc(page)) throw STALE;
          absorb(page, after, true);
        }
        return { created: false, base: baseOf(first) };
      }
      const seed = await buildSeed!({ restart });
      if (ended || gen !== generation) throw STALE;
      try {
        const result = await retrying(gen, () => client.seed(projectId, artifactId, seed));
        epoch = result.epoch;
        epochKnown = result.epoch !== null;
        options.apply(seed.update);
        own(result.seq);
        return { created: true, base: { markdown: seed.markdown, version: seed.version, seq: result.seq } };
      } catch (error) {
        if (error !== STALE && isRefusal(error, 409, 'doc_seeded') && ++conflicts <= MAX_SEED_CONFLICTS) continue;
        throw error;
      }
    }
  }

  function becomeReady() {
    ready = true;
    loadFailing = false;
    refresh();
    armPoll();
    schedulePush();
    runFlush();
    if (baseWaiters.length > 0 || (notified > covered && !seen.has(notified))) requestPull();
    notified = 0;
  }

  // ── Pulls ─────────────────────────────────────────────────────────────────

  function armPoll() {
    t.clearTimeout(pollTimer);
    pollTimer = undefined;
    if (ended || halted) return;
    pollTimer = t.setTimeout(() => {
      pollTimer = undefined;
      requestPull();
      armPoll();
    }, POLL_MS);
  }

  function requestPull() {
    if (ended || !ready) return;
    if (pulling) {
      pullAgain = true;
      return;
    }
    void runPulls();
  }

  /** Pull until nothing is left: more pages, a ping that came meanwhile, or a `base()` waiting. */
  async function runPulls(): Promise<void> {
    pulling = true;
    const gen = generation;
    let continueAfter: number | null = null;
    try {
      for (;;) {
        const waiters = baseWaiters.splice(0);
        pullWaiters = waiters;
        const after = continueAfter ?? covered;
        continueAfter = null;
        const epochBefore = pushEpoch;
        const pushing = inFlight > 0;
        let page: ArtifactDocPage;
        try {
          page = await client.get(projectId, artifactId, { after, base: waiters.length > 0 });
        } catch (error) {
          if (ended || gen !== generation) return;
          pullWaiters = [];
          baseWaiters.unshift(...waiters);
          if (!transient(error)) return fail(error);
          pullFailing = true;
          refresh();
          return; // The poll retries in at most 3 s.
        }
        if (ended || gen !== generation) return;
        // A reset or a poisoned row rejects `waiters` (still `pullWaiters`) through `halt`.
        if (!sameDoc(page)) return;
        try {
          absorb(page, after, !pushing && epochBefore === pushEpoch);
        } catch (error) {
          if (error === STALE) return;
          return fail(error);
        }
        pullWaiters = [];
        pullFailing = false;
        refresh();
        for (const waiter of waiters) waiter.resolve(baseOf(page));
        if (page.has_more && page.updates.length > 0) {
          continueAfter = Math.max(covered, lastSeq(page));
          continue;
        }
        if (pullAgain || baseWaiters.length > 0) {
          pullAgain = false;
          continue;
        }
        return;
      }
    } finally {
      if (gen === generation) pulling = false;
    }
  }

  // ── Pushes ────────────────────────────────────────────────────────────────

  function schedulePush() {
    if (ended || !ready || inFlight > 0 || queue.length === 0 || batchTimer !== undefined || retryTimer !== undefined) return;
    const wait = waitingSince === null ? 0 : waitingSince + BATCH_MS - t.now();
    if (wait <= 0) return sendPush();
    batchTimer = t.setTimeout(() => {
      batchTimer = undefined;
      sendPush();
    }, wait);
  }

  function sendPush() {
    if (ended || !ready || inFlight > 0 || queue.length === 0) return;
    const count = Math.min(queue.length, partLimit);
    let update: Uint8Array;
    try {
      update = count === 1 ? queue[0]! : options.merge(queue.slice(0, count));
    } catch (error) {
      return fail(error);
    }
    if (update.byteLength > MAX_UPDATE_BYTES) {
      if (count > 1) {
        partLimit = Math.ceil(count / 2);
        return sendPush();
      }
      return fail(new ApiError(`An update of ${update.byteLength} bytes is over the 512 KiB limit`, { status: 413, code: 'update_too_large' }));
    }
    inFlight = count;
    pushEpoch++;
    if (count === queue.length) waitingSince = null;
    const gen = generation;
    client.push(projectId, artifactId, update, epochOption()).then(
      (result) => {
        if (ended || gen !== generation) return;
        queue.splice(0, count);
        inFlight = 0;
        acked += count;
        pushFailures = 0;
        pushFailing = false;
        if (queue.length === 0) partLimit = Number.POSITIVE_INFINITY;
        echo(result.seq);
        own(result.seq);
        refresh();
        runFlush();
        schedulePush();
        // A gap left by a pull during this push: pull again, now with no push of ours in doubt.
        if (seen.size > 0) requestPull();
      },
      (error: unknown) => {
        if (ended || gen !== generation) return;
        inFlight = 0;
        if (resetRefusal(error)) return;
        // The doc's stored updates passed their limit: co-editing ends here.
        if (isRefusal(error, 413, 'doc_too_large')) return fail(error);
        if (statusOf(error) === 413 && count > 1) {
          partLimit = Math.ceil(count / 2);
          return sendPush();
        }
        if (!transient(error)) return fail(error);
        pushFailures++;
        pushFailing = true;
        refresh();
        retryTimer = t.setTimeout(() => {
          retryTimer = undefined;
          sendPush();
        }, backoff(pushFailures));
      },
    );
  }

  // ── Lease ─────────────────────────────────────────────────────────────────

  async function leaseTick(): Promise<void> {
    t.clearTimeout(leaseTimer);
    leaseTimer = undefined;
    if (ended || !ready || !leasing) return;
    const gen = generation;
    const sentAt = t.now();
    leaseRequested = true;
    try {
      const result = await client.lease(projectId, artifactId, { holder, ...epochOption() });
      if (ended || gen !== generation) return;
      if (result.leader) {
        t.clearTimeout(leaderTimer);
        // The server's 15 s run from when it received this request, which is after sentAt.
        leaderTimer = t.setTimeout(() => {
          leaderTimer = undefined;
          setLeader(false);
        }, Math.max(0, sentAt + LEASE_TTL_MS - LEASE_MARGIN_MS - t.now()));
      }
      setLeader(result.leader);
    } catch (error) {
      if (ended || gen !== generation) return;
      if (resetRefusal(error)) return;
      const httpStatus = statusOf(error);
      if (httpStatus === 403 || httpStatus === 404 || !transient(error)) {
        // A viewer without write access never leads. Anything else past 4xx is reported.
        leasing = false;
        setLeader(false);
        if (httpStatus !== 403 && httpStatus !== 404) call(options.onError, error);
      }
      // A transient failure keeps the lease until its deadline above.
    } finally {
      if (!ended && gen === generation && leasing) leaseTimer = t.setTimeout(() => void leaseTick(), LEASE_RENEW_MS);
    }
  }

  // ── Flush ─────────────────────────────────────────────────────────────────

  function runFlush() {
    if (ended || !ready || flushSending || flushTimer !== undefined || !flushJob || acked < flushJob.target) return;
    const job = flushJob;
    flushJob = null;
    flushSending = job;
    const seq = job.input.seq ?? covered;
    const gen = generation;
    client.flushed(projectId, artifactId, { holder, seq, version: job.input.version, markdown: job.input.markdown, ...epochOption() }).then(
      (result) => {
        if (ended || gen !== generation) return;
        flushSending = null;
        flushFailures = 0;
        for (const waiter of job.waiters) waiter.resolve({ seq, flushed_seq: result.flushed_seq });
        runFlush();
      },
      (error: unknown) => {
        if (ended || gen !== generation) return;
        flushSending = null;
        if (transient(error)) {
          // The newest flush wins: a newer waiting one carries these waiters too.
          if (flushJob) flushJob.waiters.unshift(...job.waiters);
          else flushJob = job;
          flushFailures++;
          flushTimer = t.setTimeout(() => {
            flushTimer = undefined;
            runFlush();
          }, backoff(flushFailures));
          return;
        }
        // A reset rejects the job's waiters with `doc_reset` through `halt`.
        flushSending = job;
        if (resetRefusal(error)) return;
        flushSending = null;
        if (isRefusal(error, 409, 'not_leader')) setLeader(false);
        for (const waiter of job.waiters) waiter.reject(error);
        runFlush();
      },
    );
  }

  const endedError = () => new Error(`Artifact doc sync is ${status}`);

  return {
    get status() {
      return status;
    },
    get leader() {
      return leader;
    },
    get covered() {
      return covered;
    },
    start(seedBuilder) {
      if (ended) return Promise.reject(endedError());
      if (started && status !== 'reset') {
        return Promise.reject(new Error('Artifact doc sync: start() runs once, and again only after onReset'));
      }
      const restart = started;
      started = true;
      halted = false;
      buildSeed = seedBuilder;
      setStatus('connecting');
      const gen = generation;
      return new Promise((resolve, reject) => {
        starting = { resolve, reject };
        load(gen, restart).then(
          (result) => {
            if (ended || gen !== generation) return;
            starting = null;
            becomeReady();
            void leaseTick();
            resolve(result);
          },
          (error: unknown) => {
            if (error !== STALE) fail(error);
          },
        );
      });
    },
    push(update) {
      if (ended || halted || !update || update.byteLength === 0) return;
      if (queue.length === inFlight) waitingSince = t.now();
      queue.push(update);
      enqueued++;
      refresh();
      schedulePush();
    },
    notify(seq) {
      if (ended || halted || !Number.isSafeInteger(seq) || seq < 0) return;
      armPoll();
      if (!ready) {
        notified = Math.max(notified, seq);
        return;
      }
      // 0 is the reset ping. A seq below the highest here that is not this tab's
      // own echo may come from a re-seeded doc, whose seqs restart at 1.
      if (seq === 0 || (seq > covered && !seen.has(seq)) || (seq < highest && !ownSeqs.has(seq))) requestPull();
    },
    flushed(input) {
      if (ended) return Promise.reject(endedError());
      if (input.seq !== undefined && (!Number.isSafeInteger(input.seq) || input.seq < 0)) {
        return Promise.reject(new RangeError('flushed: seq must be an integer ≥ 0'));
      }
      return new Promise((resolve, reject) => {
        const waiter = { resolve, reject };
        if (flushJob) {
          flushJob.input = input;
          flushJob.target = enqueued;
          flushJob.waiters.push(waiter);
        } else {
          flushJob = { input, target: enqueued, waiters: [waiter] };
        }
        runFlush();
      });
    },
    base() {
      if (ended) return Promise.reject(endedError());
      return new Promise((resolve, reject) => {
        baseWaiters.push({ resolve, reject });
        requestPull();
      });
    },
    close() {
      if (closing) return closing;
      if (ended) return (closing = Promise.resolve());
      // Every unacknowledged update, the one in flight included: a duplicate is a no-op in Yjs.
      const unsent = ready ? queue.slice() : [];
      const work: Array<Promise<unknown>> = [];
      let update: Uint8Array | null = null;
      try {
        update = unsent.length === 0 ? null : unsent.length === 1 ? unsent[0]! : options.merge(unsent);
      } catch {
        update = null;
      }
      if (update && update.byteLength <= MAX_UPDATE_BYTES) {
        work.push(client.push(projectId, artifactId, update, { keepalive: update.byteLength <= KEEPALIVE_MAX_BYTES, ...epochOption() }).catch(() => undefined));
      }
      const released = release();
      if (released) work.push(released);
      leader = false;
      end('closed', new Error('Artifact doc sync is closed'));
      closing = Promise.all(work).then(() => undefined);
      return closing;
    },
  };
}

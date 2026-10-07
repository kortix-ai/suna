/**
 * The control channel's PRODUCER.
 *
 * ─── WHY A RECONCILER AND NOT PUBLISH CALLS SCATTERED THROUGH THE WRITERS ──
 * The obvious design is to call `publishControlEvent` from every place that
 * changes a queue row, stamps a turn, or advances a wake. It is also the wrong
 * one here, for one reason that no amount of care at the call sites fixes:
 * **the API runs many instances.** A publish reaches only the streams served by
 * the same process, so a client attached to instance B would silently never
 * learn about a queue row admitted on instance A — and "silently never" is
 * strictly worse than the polling it replaces.
 *
 * So the contract is convergence, not notification. One reconciler per session
 * per instance re-reads the control plane on a cadence and emits a frame ONLY
 * when the answer changed. Correctness never depends on a writer remembering to
 * announce itself, and it never depends on which instance served the write.
 * `publishControlEvent` stays available as a same-instance latency
 * optimisation, and nothing is built on top of it.
 *
 * ─── THE COST, STATED ──────────────────────────────────────────────────────
 * Two kinds of holder. A FULL holder (the multiplexed stream) gets every
 * subsystem: five reads (9 queries on an idle session) per
 * {@link CONTROL_RECONCILE_MS}. A QUEUE holder (`?channels=control`, the SDK's
 * prompt queue) gets the queue only: one query per {@link CONTROL_REFRESH_MS},
 * because the NOTIFY below drives every queue change and the cadence is only a
 * backstop. A session with at least one full holder pays the full price; a
 * session nobody is watching pays ZERO. Each prompt-inbox write adds one pass.
 * The client keeps one owner polling `GET .../turn` as a recovery path because
 * transport presence does not prove that control frames are arriving.
 *
 * ─── A PROMPT WRITE IS A FRAME NOW, ON EVERY REPLICA ───────────────────────
 * A database trigger NOTIFYs `kortix_session_prompts_changed` with the session
 * id for every write of a `continue_session` row (migration
 * 20261006151556632). Each replica that watches the session runs a pass at
 * once ({@link pokeControlReconciler}), so a queue change reaches every client
 * in one round trip, whichever replica served the write. Without the LISTEN
 * the cadence above is the ceiling, as before.
 *
 * The same holds for the box row and the title: a trigger NOTIFYs
 * `kortix_session_changed` on every client-visible write (status, live turns,
 * wake fields, title; migration 20261006182246238), so turn, runtime and
 * session frames follow the write on every replica too.
 *
 * ─── EVERY EMISSION IS A FULL SNAPSHOT ─────────────────────────────────────
 * See `session-control-events.ts`. A frame carries its subsystem's whole state,
 * so a client that missed one is corrected by the next rather than corrupted by
 * it, and a reconnect needs no replay to be correct.
 */

import { listInboxPrompts } from '../session-lifecycle/inbox-rows';
import { serializePrompt } from './session-prompt-view';
import { readSessionTurnState } from './session-turn-read';
import {
  readRuntimeControlState,
  readMirrorWatermark,
  readSessionAuditWatermark,
  readSessionControlState,
} from './session-control-readers';
import { deriveSessionWorking } from './session-working';
import type { SessionTurnStatus } from '@kortix/api-contract';
import type { RuntimeControlState } from './session-control-readers';
import {
  WAKE_MAX_RESTARTS,
  claimWakeLadderStep,
  nextWakeLadderStep,
  resetWakeLadder,
} from '../session-lifecycle/attended-wake-ladder';
import type { StartSessionCommand } from '../session-lifecycle/types';
import { logger } from '../../lib/logger';

/**
 * A watcher the ladder may act as. `authorize` re-runs the `/start` and
 * `/restart` gates from fresh reads right before each step and answers null
 * once the watcher may not (`wake-ladder-authorization.ts`).
 */
export interface WakeLadderActor {
  authorize: () => Promise<Pick<StartSessionCommand, 'loaded' | 'visible'> | null>;
}

/** The wake ladder as a client draws it (`kortix.control.runtime` `wake_ladder`). */
export interface WakeLadderView {
  /** `idle`: no wake, or the runtime answered. `exhausted`: every step was spent. */
  status: 'idle' | 'waking' | 'escalating' | 'exhausted';
  retried: boolean;
  restarts: number;
  max_restarts: number;
  /** When the server last saw the wake change (ISO), while one runs. */
  silent_since: string | null;
}

interface LadderState {
  actors: Set<WakeLadderActor>;
  /** What the server last observed of the wake, and since when. */
  fingerprint: string | null;
  sinceMs: number;
  /** The harness answered `ready` on this replica's stream. */
  reachable: boolean;
  /** It answered in this episode: a later drop is not a wake. */
  latched: boolean;
  /** `wake_started_at` of the episode the latch belongs to. */
  episodeWake: string | null;
  downReason: string | null;
  acting: boolean;
}
import { onSessionChanged, onSessionPromptsChanged } from '../../shared/pg-broadcast';
import {
  publishControlEvent,
  type ControlEvent,
  type ControlEventType,
} from './session-control-events';

/**
 * How often a watched session's control plane is re-read.
 *
 * 5 s matches the cadence the web client already polls `/turn` at, so this is a
 * like-for-like replacement rather than a new load profile. It is the ceiling
 * on how late a control fact can be, not the typical latency: a same-instance
 * `publishControlEvent` still lands immediately.
 */
export const CONTROL_RECONCILE_MS = 5_000;

/** Same ceiling `GET .../prompts` and the bundle use. The inbox is a queue. */
const PROMPT_LIST_LIMIT = 200;

/**
 * How long a released reconciler keeps its change-detection state.
 *
 * Matches `CONTROL_RING_IDLE_MS`: past this, the ring that would have
 * de-duplicated the frames is gone too, so keeping the fingerprints buys
 * nothing.
 */
export const RECONCILER_IDLE_TTL_MS = 5 * 60_000;

/**
 * How long a retained control frame may go un-restamped.
 *
 * The client ages every snapshot it holds. A producer that suppresses
 * redundant content also suppresses freshness. Refreshing retained snapshots
 * keeps stream consumers current and prevents a new subscriber from receiving
 * an already-expired replay.
 *
 * A frame is a snapshot, not an event, so re-sending an identical one is
 * idempotent. Must stay comfortably under half the client's 45s bound.
 */
export const CONTROL_REFRESH_MS = 20_000;

/** `full`: every subsystem. `queue`: the prompt queue only, at the slow cadence. */
export type ControlReconcilerMode = 'full' | 'queue';

interface Reconciler {
  refs: number;
  /** Holders that need every subsystem. Zero means a queue-only pass. */
  fullRefs: number;
  timer: ReturnType<typeof setInterval> | null;
  timerMs: number | null;
  /** The last frame published for each subsystem — what a new stream replays. */
  latest: Map<ControlEventType, ControlEvent>;
  /** Serialized form of each subsystem's last state, for change detection. */
  fingerprints: Map<ControlEventType, string>;
  /** Resolves after the first tick, so a stream never opens on an empty cache. */
  ready: Promise<void>;
  resolveReady: (() => void) | null;
  ticking: boolean;
  /** A pass was asked for while one ran. The running pass started its reads
   *  before that write, so one more pass runs when it ends. */
  tickAgain: boolean;
  /** When the last handle was released, or null while one is held. */
  idleSince: number | null;
  /**
   * The session's project. Every audit read filters on it, so the
   * `(project_id, session_id, created_at)` index serves the read instead of
   * a scan of all tenants' `connector_calls`.
   */
  projectId: string | null;
  /** The last turn read, so a runtime turn end can re-decide `working` without a read. */
  lastTurn: SessionTurnStatus | null;
  /** The last queue read, for the same reason. */
  lastPrompts: Array<{ state: string; reason: string | null; client_sent_at_ms?: number | null }>;
  /** Newest `kortix.turn` end per runtime session id, seen on this replica's streams. */
  runtimeTurnEnds: Map<string, number>;
  lastRuntime: RuntimeControlState | null;
  ladder: LadderState;
}

// replica-local: one reconciler per watched session per process; every replica converges from the DB.
const reconcilers = new Map<string, Reconciler>();

export interface ControlReconcilerHandle {
  /** Resolves once every subsystem has been read at least once. */
  ready(): Promise<void>;
  /** The current snapshot frames, newest per subsystem, in cseq order. */
  snapshot(): ControlEvent[];
  /** Force a read now — used right after an action the caller knows changed things. */
  poke(): void;
  /**
   * The daemon reported a turn of `runtimeSessionId` ended at `atMs`
   * (`kortix.turn` on the runtime channel). Re-decides `working` at once from
   * the last turn read; the ledger close that follows is the next read's job.
   */
  noteRuntimeTurnEnd(runtimeSessionId: string, atMs: number): void;
  /** This replica's stream saw the harness answer (`reachable`) or the box go away. */
  noteRuntimeReachability(reachable: boolean, reason?: string | null): void;
  release(): void;
}

/**
 * Attach to (or start) the reconciler for a session. Reference counted: the
 * timer runs while at least one stream holds a handle and stops the moment the
 * last one releases.
 */
export function acquireControlReconciler(
  sessionId: string,
  projectId: string | null = null,
  mode: ControlReconcilerMode = 'full',
  /** Set when the holder may start and restart the session (wake ladder). */
  actor: WakeLadderActor | null = null,
): ControlReconcilerHandle {
  sweepIdleReconcilers();
  let reconciler = reconcilers.get(sessionId);
  if (!reconciler) {
    let resolveReady: (() => void) | null = null;
    const ready = new Promise<void>((resolve) => {
      resolveReady = resolve;
    });
    reconciler = {
      refs: 0,
      fullRefs: 0,
      timer: null,
      timerMs: null,
      latest: new Map(),
      fingerprints: new Map(),
      ready,
      resolveReady,
      ticking: false,
      tickAgain: false,
      idleSince: null,
      projectId,
      lastTurn: null,
      lastPrompts: [],
      runtimeTurnEnds: new Map(),
      lastRuntime: null,
      ladder: {
        actors: new Set(),
        fingerprint: null,
        sinceMs: Date.now(),
        reachable: false,
        latched: false,
        episodeWake: null,
        downReason: null,
        acting: false,
      },
    };
    reconcilers.set(sessionId, reconciler);
  }
  const target = reconciler;
  target.projectId ??= projectId;
  const full = mode === 'full';
  // A first holder, or the first FULL holder of a queue-only reconciler, needs
  // a pass now: the subsystems it asks for have not been read at this cadence.
  const needsPass = !target.timer || (full && target.fullRefs === 0);
  target.refs += 1;
  if (full) target.fullRefs += 1;
  if (actor) target.ladder.actors.add(actor);
  target.idleSince = null;
  schedule(sessionId, target);
  if (needsPass) void tick(sessionId, target);

  let released = false;
  return {
    ready: () => target.ready,
    snapshot: () =>
      [...target.latest.values()].sort((a, b) => a.cseq - b.cseq),
    poke: () => void tick(sessionId, target),
    noteRuntimeTurnEnd: (runtimeSessionId, atMs) => {
      const previous = target.runtimeTurnEnds.get(runtimeSessionId);
      if (previous !== undefined && previous >= atMs) return;
      target.runtimeTurnEnds.set(runtimeSessionId, atMs);
      emitTurn(sessionId, target);
    },
    noteRuntimeReachability: (reachable, reason = null) => {
      const ladder = target.ladder;
      ladder.reachable = reachable;
      ladder.downReason = reachable ? null : reason;
      if (reachable) ladder.latched = true;
      emitRuntime(sessionId, target);
      void driveWakeLadder(sessionId, target);
    },
    release: () => {
      if (released) return;
      released = true;
      if (actor) target.ladder.actors.delete(actor);
      target.refs -= 1;
      if (full) target.fullRefs -= 1;
      if (target.refs > 0) schedule(sessionId, target);
      if (target.refs <= 0) {
        // Stop the timer immediately — a session nobody is watching must cost
        // nothing. But KEEP the fingerprints and the latest frames for a grace
        // period, because deleting them makes the next connect re-publish four
        // snapshots that say exactly what the last four said. Measured on the
        // live stack before this: a third reconnect replayed cseq 3..12, ten
        // frames of which six were byte-identical repeats. Idempotent, so never
        // a correctness bug — but it burns the replay ring and hands every
        // reconnecting client work it does not need.
        if (target.timer) clearInterval(target.timer);
        target.timer = null;
        target.timerMs = null;
        target.idleSince = Date.now();
      }
    },
  };
}

/**
 * Run a pass now for a session this replica watches. A no-op for any other
 * session. Wired to the prompts-changed NOTIFY below.
 */
export function pokeControlReconciler(sessionId: string): void {
  const reconciler = reconcilers.get(sessionId);
  if (reconciler && reconciler.refs > 0) void tick(sessionId, reconciler);
}

onSessionPromptsChanged(pokeControlReconciler);
// A box, live-turn, wake or title write (migration 20261006182246238).
onSessionChanged(pokeControlReconciler);

/** Run the timer at the cadence the holders need. A no-op when it already does. */
function schedule(sessionId: string, reconciler: Reconciler): void {
  const ms = reconciler.fullRefs > 0 ? CONTROL_RECONCILE_MS : CONTROL_REFRESH_MS;
  if (reconciler.timer && reconciler.timerMs === ms) return;
  if (reconciler.timer) clearInterval(reconciler.timer);
  reconciler.timer = setInterval(() => void tick(sessionId, reconciler), ms);
  reconciler.timerMs = ms;
  // Never hold the process open for a poll. Bun/Node both honour unref here.
  (reconciler.timer as unknown as { unref?: () => void }).unref?.();
}

/** Forget reconcilers nobody has watched for a while. Lazy, so this module
 *  never holds a timer of its own. */
function sweepIdleReconcilers(): void {
  const cutoff = Date.now() - RECONCILER_IDLE_TTL_MS;
  for (const [sessionId, reconciler] of reconcilers) {
    if (reconciler.refs <= 0 && reconciler.idleSince !== null && reconciler.idleSince < cutoff) {
      if (reconciler.timer) clearInterval(reconciler.timer);
      reconcilers.delete(sessionId);
    }
  }
}

/**
 * One pass over the control plane.
 *
 * Never throws and never lets one failing subsystem suppress the others: a
 * `/turn` read that fails must not also stop the queue from being reported.
 * Overlapping ticks fold into ONE follow-up pass — a slow DB must not build a
 * backlog of reads that all describe the same instant, but a write that landed
 * after the running pass began its reads must still be reported.
 */
async function tick(sessionId: string, reconciler: Reconciler): Promise<void> {
  if (reconciler.ticking) {
    reconciler.tickAgain = true;
    return;
  }
  reconciler.ticking = true;
  try {
    // Captured BEFORE the reads: the queue frame ranks against GET/POST/bundle
    // snapshots on the server clock, and a snapshot is no fresher than the
    // moment it was asked for. Stamped at publish time, a slow read published
    // an OLD empty queue under a NEW instant and erased a newer confirmed row
    // (JAY-728).
    const observedAt = new Date().toISOString();
    // No full holder: the queue is the only subsystem anyone reads.
    const full = reconciler.fullRefs > 0;
    const [turn, queue, runtime, mirror, audit, session] = await Promise.allSettled([
      full ? readSessionTurnState(sessionId) : null,
      listInboxPrompts(sessionId, PROMPT_LIST_LIMIT),
      full ? readRuntimeControlState(sessionId) : null,
      full ? readMirrorWatermark(sessionId) : null,
      full ? readSessionAuditWatermark(sessionId, reconciler) : null,
      full ? readSessionControlState(sessionId) : null,
    ]);

    if (queue.status === 'fulfilled') reconciler.lastPrompts = queue.value.map(serializePrompt);
    if (full && turn.status === 'fulfilled' && turn.value) {
      reconciler.lastTurn = turn.value;
      emitTurn(sessionId, reconciler);
    }
    if (queue.status === 'fulfilled') {
      const prompts = reconciler.lastPrompts as ReturnType<typeof serializePrompt>[];
      emit(
        sessionId,
        reconciler,
        'kortix.control.queue',
        {
          known: true,
          prompts,
          held: prompts.some(
            (prompt) => prompt.state === 'waiting' && prompt.reason === 'held',
          ),
        },
        // Outside the fingerprint: a fresh stamp on unchanged content must not
        // defeat the change detection and re-publish every tick.
        { observed_at: observedAt },
      );
    }
    if (full && runtime.status === 'fulfilled' && runtime.value) {
      reconciler.lastRuntime = runtime.value;
      observeWake(reconciler);
      emitRuntime(sessionId, reconciler);
      void driveWakeLadder(sessionId, reconciler);
    }
    if (full && mirror.status === 'fulfilled') {
      emit(sessionId, reconciler, 'kortix.control.mirror', mirror.value);
    }
    if (full && audit.status === 'fulfilled') {
      emit(sessionId, reconciler, 'kortix.control.audit', audit.value);
    }
    if (full && session.status === 'fulfilled') {
      emit(sessionId, reconciler, 'kortix.control.session', session.value);
    }
  } catch {
    // `allSettled` above means this is unreachable in practice; the guard is
    // here because a throw from a poll timer is an unhandled rejection.
  } finally {
    reconciler.ticking = false;
    reconciler.resolveReady?.();
    reconciler.resolveReady = null;
    if (reconciler.tickAgain) {
      reconciler.tickAgain = false;
      if (reconciler.refs > 0) void tick(sessionId, reconciler);
    }
  }
}

const WAKE_GAVE_UP_REASONS = new Set(['runtime_wake_failed', 'runtime_boot_failed']);

/** Does the ladder watch this box now? Only a wake that has not answered yet. */
function ladderApplies(runtime: RuntimeControlState, ladder: LadderState): boolean {
  if (!runtime.external_id || ladder.reachable || ladder.latched) return false;
  return (
    runtime.waking ||
    WAKE_GAVE_UP_REASONS.has(runtime.stop_reason ?? '') ||
    runtime.sandbox_status === 'active' ||
    runtime.sandbox_status === 'provisioning'
  );
}

/** Restart the silence clock on any change the server can observe. */
function observeWake(reconciler: Reconciler): void {
  const runtime = reconciler.lastRuntime;
  if (!runtime) return;
  const ladder = reconciler.ladder;
  // A NEW wake (the box was stopped and is woken again) starts a new episode.
  if (runtime.wake_started_at && runtime.wake_started_at !== ladder.episodeWake) {
    ladder.episodeWake = runtime.wake_started_at;
    if (!ladder.reachable) ladder.latched = false;
  }
  const fingerprint = JSON.stringify([
    runtime.sandbox_status,
    runtime.waking,
    runtime.wake_provider_status,
    runtime.wake_started_at,
    runtime.wake_progress_at,
    runtime.stop_reason,
    ladder.downReason,
  ]);
  if (fingerprint !== ladder.fingerprint) {
    ladder.fingerprint = fingerprint;
    ladder.sinceMs = Date.now();
  }
}

function wakeLadderView(reconciler: Reconciler): WakeLadderView {
  const runtime = reconciler.lastRuntime!;
  const budget = runtime.wake_ladder_budget;
  const applies = ladderApplies(runtime, reconciler.ladder);
  const exhausted = budget.retried && budget.restarts >= WAKE_MAX_RESTARTS;
  return {
    status: !applies ? 'idle' : exhausted ? 'exhausted' : budget.retried ? 'escalating' : 'waking',
    retried: budget.retried,
    restarts: budget.restarts,
    max_restarts: WAKE_MAX_RESTARTS,
    silent_since: applies ? new Date(reconciler.ladder.sinceMs).toISOString() : null,
  };
}

/** The runtime frame: the box row plus the server wake ladder. */
function emitRuntime(sessionId: string, reconciler: Reconciler): void {
  if (!reconciler.lastRuntime) return;
  emit(sessionId, reconciler, 'kortix.control.runtime', {
    ...reconciler.lastRuntime,
    wake_ladder: wakeLadderView(reconciler),
  });
}

/**
 * Take the ladder's next step for this session, if one is due. At most one
 * step runs per replica at a time, and the row claim makes it one per box.
 */
async function driveWakeLadder(sessionId: string, reconciler: Reconciler): Promise<void> {
  const ladder = reconciler.ladder;
  const runtime = reconciler.lastRuntime;
  if (ladder.acting || !runtime) return;
  if (!ladderApplies(runtime, ladder)) {
    const spent = runtime.wake_ladder_budget.retried || runtime.wake_ladder_budget.restarts > 0;
    if (ladder.latched && spent) await resetWakeLadder(sessionId).catch(() => {});
    return;
  }
  const actor = ladder.actors.values().next().value as WakeLadderActor | undefined;
  if (!actor) return;
  const nowMs = Date.now();
  const observation = {
    silentMs: nowMs - ladder.sinceMs,
    serverGaveUp: WAKE_GAVE_UP_REASONS.has(runtime.stop_reason ?? ''),
    nowMs,
  };
  const budget = runtime.wake_ladder_budget;
  // Cheap pre-check on the last read, so an ordinary tick opens no transaction.
  const due = nextWakeLadderStep(observation, {
    retried: budget.retried,
    restarts: budget.restarts,
    lastActionMs: budget.last_action_ms,
  });
  if (due !== 'retry-start' && due !== 'restart') return;
  ladder.acting = true;
  let acted = false;
  try {
    // Authorization is asked NOW, not when the stream opened: access revoked
    // since then ends this watcher's part in the ladder.
    const authorized = await actor.authorize();
    if (!authorized) {
      ladder.actors.delete(actor);
      return;
    }
    // Same gate as `/start`: a step resumes or provisions compute.
    const { checkBillingAdmission } = await import('../../billing/services/billing-gate');
    if (!(await checkBillingAdmission(authorized.loaded.row.accountId)).ok) return;
    const { step } = await claimWakeLadderStep(sessionId, observation);
    if (step !== 'retry-start' && step !== 'restart') return;
    const projectId = authorized.loaded.row.projectId;
    logger.info('[wake-ladder] escalating a quiet wake', {
      sessionId,
      step,
      silentMs: observation.silentMs,
    });
    if (step === 'retry-start') {
      const { startSession } = await import('../session-lifecycle/start-session');
      await startSession({ source: 'ui', ...authorized, projectId, sessionId });
    } else {
      const { restartSession } = await import('../session-lifecycle/actions');
      await restartSession({ loaded: authorized.loaded, session: authorized.visible.row, projectId, sessionId });
    }
    // A step is progress: the next one waits a full silence window again.
    ladder.sinceMs = Date.now();
    acted = true;
  } catch (error) {
    logger.warn('[wake-ladder] step failed', {
      sessionId,
      error: error instanceof Error ? error.message : String(error),
    });
  } finally {
    ladder.acting = false;
    // Re-read only after a step ran. A refused step (billing, another replica's
    // claim) waits for the next ordinary pass, or it would retry in a loop.
    if (acted && reconciler.refs > 0) void tick(sessionId, reconciler);
  }
}

/** The turn frame: the last turn read plus the server's `working` verdict. */
function emitTurn(sessionId: string, reconciler: Reconciler): void {
  if (!reconciler.lastTurn) return;
  emit(sessionId, reconciler, 'kortix.control.turn', {
    known: true,
    ...reconciler.lastTurn,
    working: deriveSessionWorking(
      reconciler.lastTurn,
      reconciler.lastPrompts,
      reconciler.runtimeTurnEnds,
    ),
  });
}

/**
 * Publish when the subsystem's serialized state moved, OR when the frame we are
 * holding has gone stale.
 *
 * The staleness half is not an optimisation. The client ages what it holds, so
 * suppressing an unchanged frame suppresses freshness for stream consumers.
 *
 * Re-stamping also fixes what a NEW stream is handed: `snapshot()` replays the
 * retained frame verbatim, so without this a client attaching mid-turn received
 * a frame already older than its own expiry window.
 */
function emit(
  sessionId: string,
  reconciler: Reconciler,
  type: ControlEventType,
  payload: unknown,
  /** Merged into the published frame AFTER change detection — a freshness
   *  stamp that must never count as a content change (`observed_at`). */
  stamp?: Record<string, unknown>,
): void {
  const fingerprint = JSON.stringify(payload) ?? 'null';
  const held = reconciler.latest.get(type);
  const stale = !held || Date.now() - held.at >= CONTROL_REFRESH_MS;
  if (reconciler.fingerprints.get(type) === fingerprint && !stale) return;
  reconciler.fingerprints.set(type, fingerprint);
  const published = stamp ? Object.assign({}, payload as object, stamp) : payload;
  reconciler.latest.set(type, publishControlEvent(sessionId, type, published));
}

/**
 * Publish a runtime-state projection frame for a session.
 *
 * Called by the stream when it has just read `/kortix/opencode/state` — the
 * frame goes through the same channel and the same cseq space as every other
 * control snapshot, so a client applies it with the same reducer and dedupes it
 * with the same cursor.
 */
export function publishRuntimeStateFrame(sessionId: string, payload: unknown): ControlEvent | null {
  const reconciler = reconcilers.get(sessionId);
  const type: ControlEventType = 'kortix.control.runtime_state';
  if (!reconciler) return publishControlEvent(sessionId, type, payload);
  const fingerprint = JSON.stringify(payload) ?? 'null';
  if (reconciler.fingerprints.get(type) === fingerprint) {
    return reconciler.latest.get(type) ?? null;
  }
  reconciler.fingerprints.set(type, fingerprint);
  const event = publishControlEvent(sessionId, type, payload);
  reconciler.latest.set(type, event);
  return event;
}

/** Test-only: stop and forget every reconciler. */
export function __resetControlReconcilersForTests(): void {
  for (const reconciler of reconcilers.values()) {
    if (reconciler.timer) clearInterval(reconciler.timer);
  }
  reconcilers.clear();
}

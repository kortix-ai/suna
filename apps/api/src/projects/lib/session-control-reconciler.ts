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
 * Three indexed reads per {@link CONTROL_RECONCILE_MS} per session that has at
 * least one stream open — and ZERO for a session nobody is watching. What it
 * replaces per client: `GET .../turn` and `GET .../prompts` on their own
 * timers, each a full HTTP round trip through the edge, per TAB. One
 * reconciler serves every tab on the instance, so the DB load falls as the
 * client count rises, which is the opposite of the polling it retires.
 *
 * ─── EVERY EMISSION IS A FULL SNAPSHOT ─────────────────────────────────────
 * See `session-control-events.ts`. A frame carries its subsystem's whole state,
 * so a client that missed one is corrected by the next rather than corrupted by
 * it, and a reconnect needs no replay to be correct.
 */

import { eq } from 'drizzle-orm';
import { sessionSandboxes, sessionTranscriptMirrors, sessionTranscriptMessages } from '@kortix/db';
import { count, max } from 'drizzle-orm';
import { db } from '../../shared/db';
import { listInboxPrompts } from '../session-lifecycle/inbox-rows';
import { runtimeWakeInProgress } from '../session-lifecycle/runtime-wake-fence';
import { serializePrompt } from './session-prompt-view';
import { readSessionTurnState } from './session-turn-read';
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

interface Reconciler {
  refs: number;
  timer: ReturnType<typeof setInterval> | null;
  /** The last frame published for each subsystem — what a new stream replays. */
  latest: Map<ControlEventType, ControlEvent>;
  /** Serialized form of each subsystem's last state, for change detection. */
  fingerprints: Map<ControlEventType, string>;
  /** Resolves after the first tick, so a stream never opens on an empty cache. */
  ready: Promise<void>;
  resolveReady: (() => void) | null;
  ticking: boolean;
  /** When the last handle was released, or null while one is held. */
  idleSince: number | null;
}

const reconcilers = new Map<string, Reconciler>();

export interface ControlReconcilerHandle {
  /** Resolves once every subsystem has been read at least once. */
  ready(): Promise<void>;
  /** The current snapshot frames, newest per subsystem, in cseq order. */
  snapshot(): ControlEvent[];
  /** Force a read now — used right after an action the caller knows changed things. */
  poke(): void;
  release(): void;
}

/**
 * Attach to (or start) the reconciler for a session. Reference counted: the
 * timer runs while at least one stream holds a handle and stops the moment the
 * last one releases.
 */
export function acquireControlReconciler(sessionId: string): ControlReconcilerHandle {
  sweepIdleReconcilers();
  let reconciler = reconcilers.get(sessionId);
  if (!reconciler) {
    let resolveReady: (() => void) | null = null;
    const ready = new Promise<void>((resolve) => {
      resolveReady = resolve;
    });
    reconciler = {
      refs: 0,
      timer: null,
      latest: new Map(),
      fingerprints: new Map(),
      ready,
      resolveReady,
      ticking: false,
      idleSince: null,
    };
    reconcilers.set(sessionId, reconciler);
  }
  const target = reconciler;
  target.refs += 1;
  target.idleSince = null;

  if (!target.timer) {
    target.timer = setInterval(() => void tick(sessionId, target), CONTROL_RECONCILE_MS);
    // Never hold the process open for a poll. Bun/Node both honour unref here.
    (target.timer as unknown as { unref?: () => void }).unref?.();
    void tick(sessionId, target);
  }

  let released = false;
  return {
    ready: () => target.ready,
    snapshot: () =>
      [...target.latest.values()].sort((a, b) => a.cseq - b.cseq),
    poke: () => void tick(sessionId, target),
    release: () => {
      if (released) return;
      released = true;
      target.refs -= 1;
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
        target.idleSince = Date.now();
      }
    },
  };
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
 * Overlapping ticks are dropped rather than queued — a slow DB must not build
 * a backlog of reads that all describe the same instant.
 */
async function tick(sessionId: string, reconciler: Reconciler): Promise<void> {
  if (reconciler.ticking) return;
  reconciler.ticking = true;
  try {
    const [turn, queue, runtime, mirror] = await Promise.allSettled([
      readSessionTurnState(sessionId),
      listInboxPrompts(sessionId, PROMPT_LIST_LIMIT),
      readRuntimeControlState(sessionId),
      readMirrorWatermark(sessionId),
    ]);

    if (turn.status === 'fulfilled') {
      emit(sessionId, reconciler, 'kortix.control.turn', { known: true, ...turn.value });
    }
    if (queue.status === 'fulfilled') {
      const prompts = queue.value.map(serializePrompt);
      emit(sessionId, reconciler, 'kortix.control.queue', {
        known: true,
        prompts,
        held: prompts.some(
          (prompt) => prompt.state === 'waiting' && prompt.reason === 'held',
        ),
      });
    }
    if (runtime.status === 'fulfilled') {
      emit(sessionId, reconciler, 'kortix.control.runtime', runtime.value);
    }
    if (mirror.status === 'fulfilled') {
      emit(sessionId, reconciler, 'kortix.control.mirror', mirror.value);
    }
  } catch {
    // `allSettled` above means this is unreachable in practice; the guard is
    // here because a throw from a poll timer is an unhandled rejection.
  } finally {
    reconciler.ticking = false;
    reconciler.resolveReady?.();
    reconciler.resolveReady = null;
  }
}

/** Publish only when the subsystem's serialized state actually moved. */
function emit(
  sessionId: string,
  reconciler: Reconciler,
  type: ControlEventType,
  payload: unknown,
): void {
  const fingerprint = JSON.stringify(payload) ?? 'null';
  if (reconciler.fingerprints.get(type) === fingerprint) return;
  reconciler.fingerprints.set(type, fingerprint);
  reconciler.latest.set(type, publishControlEvent(sessionId, type, payload));
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

export interface RuntimeControlState {
  known: true;
  /** The sandbox row's status, or null when the session has no sandbox row. */
  sandbox_status: string | null;
  external_id: string | null;
  provider: string | null;
  /** A wake is DRIVING this box right now (the fence's own verdict). */
  waking: boolean;
  /** Provider status observed by the wake loop, when it recorded one. */
  wake_provider_status: string | null;
  deadline_at: string | null;
}

/** One indexed read: the sandbox row plus the wake fence's verdict on it. */
async function readRuntimeControlState(sessionId: string): Promise<RuntimeControlState> {
  const [row] = await db
    .select({
      status: sessionSandboxes.status,
      externalId: sessionSandboxes.externalId,
      provider: sessionSandboxes.provider,
      metadata: sessionSandboxes.metadata,
      deadlineAt: sessionSandboxes.deadlineAt,
    })
    .from(sessionSandboxes)
    .where(eq(sessionSandboxes.sessionId, sessionId))
    .limit(1);

  if (!row) {
    return {
      known: true,
      sandbox_status: null,
      external_id: null,
      provider: null,
      waking: false,
      wake_provider_status: null,
      deadline_at: null,
    };
  }
  const metadata = (row.metadata ?? {}) as Record<string, unknown>;
  return {
    known: true,
    sandbox_status: row.status,
    external_id: row.externalId ?? null,
    provider: row.provider,
    waking: runtimeWakeInProgress(metadata),
    wake_provider_status:
      typeof metadata.runtimeWakeProviderStatus === 'string'
        ? metadata.runtimeWakeProviderStatus
        : null,
    deadline_at: row.deadlineAt ? row.deadlineAt.toISOString() : null,
  };
}

export interface MirrorWatermark {
  known: true;
  /** `false` when nothing has ever been mirrored for this session. */
  present: boolean;
  captured_at: string | null;
  /** TRUE only when a capture PROVED it saw the session's first message. */
  head_complete: boolean;
  opencode_session_id: string | null;
  message_count: number;
  newest_message_at: string | null;
}

/**
 * How far the durable transcript copy has caught up.
 *
 * Two aggregate reads on the mirror's own index — never the message BODIES.
 * The watermark is what a client needs to decide whether to ask for an older
 * page; shipping the rows here would re-create the 7-19 MB transcript payloads
 * the mirror exists to prevent.
 */
async function readMirrorWatermark(sessionId: string): Promise<MirrorWatermark> {
  const [mirror] = await db
    .select({
      capturedAt: sessionTranscriptMirrors.capturedAt,
      headComplete: sessionTranscriptMirrors.headComplete,
      opencodeSessionId: sessionTranscriptMirrors.opencodeSessionId,
    })
    .from(sessionTranscriptMirrors)
    .where(eq(sessionTranscriptMirrors.sessionId, sessionId))
    .limit(1);

  if (!mirror) {
    return {
      known: true,
      present: false,
      captured_at: null,
      head_complete: false,
      opencode_session_id: null,
      message_count: 0,
      newest_message_at: null,
    };
  }

  const [stats] = await db
    .select({
      messages: count(),
      newest: max(sessionTranscriptMessages.messageCreatedAt),
    })
    .from(sessionTranscriptMessages)
    .where(eq(sessionTranscriptMessages.sessionId, sessionId));

  return {
    known: true,
    present: true,
    captured_at: mirror.capturedAt ? mirror.capturedAt.toISOString() : null,
    head_complete: mirror.headComplete,
    opencode_session_id: mirror.opencodeSessionId ?? null,
    message_count: stats?.messages ?? 0,
    newest_message_at: stats?.newest ? new Date(stats.newest).toISOString() : null,
  };
}

/** Test-only: stop and forget every reconciler. */
export function __resetControlReconcilersForTests(): void {
  for (const reconciler of reconcilers.values()) {
    if (reconciler.timer) clearInterval(reconciler.timer);
  }
  reconcilers.clear();
}

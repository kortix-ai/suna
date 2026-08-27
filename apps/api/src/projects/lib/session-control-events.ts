/**
 * The CONTROL-PLANE half of the session stream.
 *
 * `GET .../sessions/:sid/stream` multiplexes two sources onto one client
 * connection: the sandbox daemon's sequenced runtime events, and the facts only
 * the API knows — the prompt queue, the turn verdict, the wake/boot envelope,
 * the transcript mirror's watermark. This module owns the second half.
 *
 * ─── TWO CURSORS, NEVER ONE ────────────────────────────────────────────────
 * WS-Z1's rule, verbatim: *"Do not renumber: `seq` is the daemon's, and a
 * control-plane event buffer that multiplexes its own events must carry them in
 * a separate field or the client cannot tell which cursor to resume with."*
 * So a control frame carries `cseq` (this module's counter) and `cepoch` (this
 * API PROCESS's id) and never a `seq`. A runtime frame carries `seq` and
 * `epoch` and never a `cseq`. The two id-spaces never touch.
 *
 * ─── EVERY CONTROL FRAME IS A SNAPSHOT, NOT A DELTA ─────────────────────────
 * This is the design decision that makes the channel safe to lose. A control
 * frame carries the WHOLE current state of its subsystem (the whole queue, the
 * whole turn verdict), so a later frame SUPERSEDES an earlier one and a gap
 * costs a client nothing but latency. Compare the runtime channel, where a
 * dropped `message.part.delta` is unrecoverable and the ring exists precisely
 * to replay it.
 *
 * Two consequences worth stating plainly, because they are what make the
 * honest failure story short:
 *   1. An API restart resets `cepoch` and `cseq`. A client resuming with a
 *      stale pair is answered with `kortix.control.resync` — never silence —
 *      and then with a fresh snapshot of every subsystem. Nothing is lost
 *      because nothing was a delta.
 *   2. The API runs many instances. A `publish()` here reaches only the
 *      streams served by THIS process. That is why publishing is an
 *      OPTIMISATION and never the contract: the stream's reconciler
 *      (`session-control-reconciler.ts`) re-reads the control plane on a
 *      cadence and emits on change, so a client attached to any instance
 *      converges whether or not the writer shared its memory.
 *
 * ─── WHY IN-MEMORY IS ENOUGH FOR V1 ────────────────────────────────────────
 * The ring is a de-duplication and gap-DETECTION aid, not a durability
 * promise. It holds {@link CONTROL_RING_CAPACITY} frames per session on the
 * instance serving them. Losing it degrades a client from "skip the snapshot I
 * already have" to "apply the snapshot again", which is idempotent.
 */

/**
 * This API process's id. `cseq` is meaningless outside it — exactly as the
 * daemon's `seq` is meaningless outside its boot `epoch`.
 */
export const CONTROL_EPOCH = `capi_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;

/** Frames retained per session for replay. Snapshots supersede, so this is small. */
export const CONTROL_RING_CAPACITY = 64;

/** A session's ring is dropped this long after its last subscriber leaves. */
export const CONTROL_RING_IDLE_MS = 5 * 60_000;

/**
 * The control subsystems. One frame type per subsystem, each carrying that
 * subsystem's COMPLETE state.
 *
 * `kortix.control.*` rather than a bare name so a client's reducer can route on
 * the prefix and can never confuse one of these with an OpenCode event type
 * (which arrives verbatim on the runtime channel).
 */
export type ControlEventType =
  /** The whole turn verdict — the same object `GET .../turn` serves. */
  | 'kortix.control.turn'
  /** The whole prompt queue — the same rows `GET .../prompts` serves. */
  | 'kortix.control.queue'
  /** Runtime reachability + wake/boot progress, as the CONTROL plane sees it. */
  | 'kortix.control.runtime'
  /** The transcript mirror's watermark (how far the durable copy has caught up). */
  | 'kortix.control.mirror'
  /** The daemon's `/kortix/opencode/state` projection, when the stream has one. */
  | 'kortix.control.runtime_state';

export interface ControlEvent {
  /** Which id-space this frame belongs to. Present on EVERY frame the stream writes. */
  channel: 'control';
  cepoch: string;
  cseq: number;
  type: ControlEventType;
  /** Server clock, ms. */
  at: number;
  payload: unknown;
}

export type ControlResyncReason = 'gap-too-old' | 'epoch-changed' | 'ahead-of-head';

export interface ControlResync {
  channel: 'control';
  type: 'kortix.control.resync';
  reason: ControlResyncReason;
  cepoch: string;
  first_cseq: number;
  head_cseq: number;
  requested_since: number | null;
  /** What the client gets INSTEAD of the missing frames. Always a full snapshot. */
  recover: string[];
}

interface SessionChannel {
  cseq: number;
  ring: ControlEvent[];
  listeners: Set<(event: ControlEvent) => void>;
  /** Last time this channel had a subscriber or a publish. Drives the sweep. */
  touchedAt: number;
}

const channels = new Map<string, SessionChannel>();

function now(): number {
  return Date.now();
}

/**
 * Drop rings nobody is reading and nobody has written to.
 *
 * Lazy — run from publish/subscribe rather than from an interval, so this
 * module never holds a timer. A timer here would keep a test process alive and
 * would be one more thing to unref correctly in every consumer.
 */
function sweep(): void {
  const cutoff = now() - CONTROL_RING_IDLE_MS;
  for (const [sessionId, channel] of channels) {
    if (channel.listeners.size === 0 && channel.touchedAt < cutoff) {
      channels.delete(sessionId);
    }
  }
}

function channelFor(sessionId: string): SessionChannel {
  let channel = channels.get(sessionId);
  if (!channel) {
    channel = { cseq: 0, ring: [], listeners: new Set(), touchedAt: now() };
    channels.set(sessionId, channel);
  }
  return channel;
}

/**
 * Publish one control snapshot for a session.
 *
 * Returns the frame so a caller that is ALSO writing it to its own stream (the
 * reconciler does exactly that) does not have to receive its own broadcast.
 *
 * Never throws: a listener that fails must not fail the write that published.
 */
export function publishControlEvent(
  sessionId: string,
  type: ControlEventType,
  payload: unknown,
): ControlEvent {
  sweep();
  const channel = channelFor(sessionId);
  channel.cseq += 1;
  channel.touchedAt = now();
  const event: ControlEvent = {
    channel: 'control',
    cepoch: CONTROL_EPOCH,
    cseq: channel.cseq,
    type,
    at: channel.touchedAt,
    payload,
  };
  channel.ring.push(event);
  if (channel.ring.length > CONTROL_RING_CAPACITY) {
    channel.ring.splice(0, channel.ring.length - CONTROL_RING_CAPACITY);
  }
  for (const listener of channel.listeners) {
    try {
      listener(event);
    } catch {
      // A broken subscriber is the subscriber's problem. Publishing is not
      // allowed to fail because one of them threw.
    }
  }
  return event;
}

export interface ControlSubscribeOptions {
  /** The `cseq` the client last applied, or null for "I hold nothing". */
  sinceCseq?: number | null;
  /** The `cepoch` that `sinceCseq` belongs to. A mismatch invalidates it. */
  cepoch?: string | null;
}

export interface ControlSubscription {
  /** Frames the client missed, oldest first. Empty when it missed nothing. */
  replay: ControlEvent[];
  /** Present when the gap could not be replayed exactly. Never silent. */
  resync: ControlResync | null;
  headCseq: number;
  unsubscribe: () => void;
}

/**
 * Attach to a session's control channel.
 *
 * The replay snapshot and the live listener are taken in the SAME synchronous
 * tick — the handoff property WS-Z1's bus documents — so nothing can be
 * published between reading the ring and registering.
 */
export function subscribeControlEvents(
  sessionId: string,
  options: ControlSubscribeOptions,
  listener: (event: ControlEvent) => void,
): ControlSubscription {
  sweep();
  const channel = channelFor(sessionId);
  channel.touchedAt = now();
  channel.listeners.add(listener);

  const head = channel.cseq;
  const first = channel.ring.length > 0 ? channel.ring[0]!.cseq : head + 1;
  const since = typeof options.sinceCseq === 'number' ? options.sinceCseq : null;
  const clientEpoch = options.cepoch ?? null;

  let replay: ControlEvent[] = [];
  let resync: ControlResync | null = null;

  const makeResync = (reason: ControlResyncReason): ControlResync => ({
    channel: 'control',
    type: 'kortix.control.resync',
    reason,
    cepoch: CONTROL_EPOCH,
    first_cseq: first,
    head_cseq: head,
    requested_since: since,
    // Deliberately concrete: the client does not have to know how to recover,
    // and it does not have to call anything. The stream re-emits every
    // subsystem snapshot right after this frame.
    recover: ['kortix.control.turn', 'kortix.control.queue', 'kortix.control.runtime'],
  });

  if (since === null) {
    // A client holding nothing is not a gap. It gets the fresh snapshots the
    // stream emits on open, not a replay of superseded ones.
    replay = [];
  } else if (clientEpoch !== null && clientEpoch !== CONTROL_EPOCH) {
    resync = makeResync('epoch-changed');
  } else if (clientEpoch === null) {
    // A `since` with no epoch cannot be trusted: the number could belong to any
    // process. Treat it as an epoch change rather than guessing.
    resync = makeResync('epoch-changed');
  } else if (since > head) {
    resync = makeResync('ahead-of-head');
  } else if (since < first - 1) {
    resync = makeResync('gap-too-old');
  } else {
    replay = channel.ring.filter((event) => event.cseq > since);
  }

  return {
    replay,
    resync,
    headCseq: head,
    unsubscribe: () => {
      channel.listeners.delete(listener);
      channel.touchedAt = now();
    },
  };
}

/** Current cursor for a session's control channel, without subscribing. */
export function controlChannelState(sessionId: string): {
  cepoch: string;
  head_cseq: number;
  first_cseq: number;
  subscribers: number;
} {
  const channel = channels.get(sessionId);
  const head = channel?.cseq ?? 0;
  return {
    cepoch: CONTROL_EPOCH,
    head_cseq: head,
    first_cseq: channel && channel.ring.length > 0 ? channel.ring[0]!.cseq : head + 1,
    subscribers: channel?.listeners.size ?? 0,
  };
}

/** Test-only: forget every channel. */
export function __resetControlEventsForTests(): void {
  channels.clear();
}

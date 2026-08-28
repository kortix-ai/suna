/**
 * The Kortix event sequencer — ONE ordered stream out of the box.
 *
 * WHAT IT REPLACES. Today every consumer of a session runs `GET /global/event`
 * (raw OpenCode frames, no sequence) plus a ring of self-heal polls that exist
 * only because a dropped frame is undetectable: `GET /permission` every 2 s,
 * `GET /question` every 2 s, a 10 s transcript liveness read and a 30 s
 * tail-verify. Each of those pays the ~1.4 s proxied-read floor
 * (WS-V §1.2). A monotonic sequence makes a gap DETECTABLE, and a detectable
 * gap needs no poll: reconnect, ask for the missed range, done.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * SEQ SEMANTICS — read this before changing anything here
 * ────────────────────────────────────────────────────────────────────────────
 *
 * `seq` is **daemon-assigned, box-global, dense, and monotonic within one
 * `epoch`.** It is NOT OpenCode's `event_sequence.seq`. Three measured reasons:
 *
 *  1. OpenCode's seq is **per aggregate**, and an aggregate is one OpenCode
 *     session. A Task/subagent child session is its own aggregate with its own
 *     counter, so `event_sequence` offers no single ordering for a box.
 *  2. OpenCode's log is a **subset of the wire**. On a real box it held four
 *     types — `message.part.updated.1`, `message.updated.1`, `session.updated.1`,
 *     `session.created.1` (2,016 rows for one session, WS-V §2.3). The frames
 *     that make the self-heal polls deletable — `permission.asked`,
 *     `question.asked`, `session.status`, `session.idle` — are never persisted.
 *     A replay driven by that table alone would silently drop exactly the
 *     events this design exists to deliver.
 *  3. Daemon-origin events (turn verdicts, boot phases) have no OpenCode
 *     counterpart at all, and they must interleave with OpenCode's in true
 *     arrival order or a client cannot tell "the turn ended" from "a later part
 *     arrived".
 *
 * Because the daemon owns the counter, interleaving daemon events is SAFE and
 * needs no parallel `dseq`: one space, one order, one cursor.
 *
 * `epoch` is stamped at construction. Seq numbers are comparable ONLY within
 * one epoch — a daemon restart resets the counter, and a client that resumed
 * with `?since=` from the previous epoch would silently skip everything. A
 * mismatched epoch is answered with `kortix.resync`, never with data.
 *
 * REPLAY. The bus keeps the last {@link DEFAULT_RING_CAPACITY} envelopes. A
 * `?since=N` inside the ring is replayed exactly: `N+1 … head`, no gap, no dup.
 * A `?since=N` older than the ring cannot be replayed from memory, and the
 * daemon says so — `kortix.resync` with `first_seq`, `head_seq` and the
 * recovery recipe — instead of pretending. That is deliberate: past a few
 * thousand deltas, refetching one gzipped `/state` (complete live state) plus
 * one projected `/messages` page is cheaper AND more correct than replaying
 * the deltas that produced them.
 *
 * HANDOFF. `subscribe()` snapshots the ring and registers the live listener in
 * the SAME synchronous tick. JavaScript is single-threaded, so nothing can be
 * published between the two — the handoff is atomic by construction, not by
 * locking. Live envelopes that arrive while the replay is still being written
 * are queued behind it, and any whose seq the replay already covered are
 * dropped by the `<= lastReplayed` guard. Loss and duplication are both
 * impossible; `kortix-event-bus.test.ts` asserts it under concurrent publish.
 */

export const DEFAULT_RING_CAPACITY = 2_000

/** One envelope on the wire. */
export interface KortixEvent {
  /** Dense, monotonic, box-global, valid only within `epoch`. */
  seq: number
  /** OpenCode's event type verbatim, or `kortix.*` for daemon-origin events. */
  type: string
  /** Milliseconds since the epoch, when the daemon sequenced it. */
  at: number
  /**
   * OpenCode's `properties` verbatim, or the daemon event body. Never
   * reshaped: the SDK reducer is written against OpenCode's own frames and a
   * rename here would be a silent contract break.
   */
  payload: unknown
  /** Which OpenCode session this is about, when the frame names one. */
  session?: string
}

export type KortixEventListener = (event: KortixEvent) => void

export interface SubscribeResult {
  /** Envelopes the caller missed, oldest first. Empty for a fresh stream. */
  replay: KortixEvent[]
  /**
   * Set when the requested `since` could not be replayed exactly. The caller
   * MUST emit this to the client before any live event.
   */
  resync: KortixResync | null
  /** Highest seq the caller has been given by this call. */
  cursor: number
  unsubscribe(): void
}

export interface KortixResync {
  reason: 'epoch-changed' | 'gap-too-old' | 'ahead-of-head'
  epoch: string
  /** Oldest seq still replayable from memory. */
  first_seq: number
  /** Newest seq the daemon has assigned. */
  head_seq: number
  /** What the client asked for. */
  requested_since: number | null
  /**
   * The recovery recipe, spelled out on the wire so a client never has to
   * infer it: re-read state, then the newest transcript page.
   */
  recover: string[]
}

/** Frames whose payload names a session, and where. */
function sessionOf(payload: unknown): string | undefined {
  if (!payload || typeof payload !== 'object') return undefined
  const p = payload as Record<string, unknown>
  if (typeof p.sessionID === 'string') return p.sessionID
  const info = p.info as { sessionID?: unknown; id?: unknown } | undefined
  if (info && typeof info.sessionID === 'string') return info.sessionID
  const part = p.part as { sessionID?: unknown } | undefined
  if (part && typeof part.sessionID === 'string') return part.sessionID
  return undefined
}

export class KortixEventBus {
  private seq = 0
  private ring: KortixEvent[] = []
  private readonly listeners = new Set<KortixEventListener>()

  constructor(
    readonly epoch: string = `b${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`,
    private readonly capacity: number = DEFAULT_RING_CAPACITY,
    private readonly now: () => number = () => Date.now(),
  ) {}

  get headSeq(): number {
    return this.seq
  }

  /** Oldest seq still replayable. `headSeq` when the ring is empty. */
  get firstSeq(): number {
    return this.ring.length > 0 ? this.ring[0]!.seq : this.seq
  }

  get subscriberCount(): number {
    return this.listeners.size
  }

  /** Sequence and fan out one envelope. Never throws into the caller. */
  publish(type: string, payload: unknown, session?: string): KortixEvent {
    const event: KortixEvent = {
      seq: ++this.seq,
      type,
      at: this.now(),
      payload,
      ...(session ? { session } : {}),
    }
    this.ring.push(event)
    if (this.ring.length > this.capacity) this.ring.splice(0, this.ring.length - this.capacity)
    for (const listener of this.listeners) {
      try {
        listener(event)
      } catch {
        // A broken consumer must never stop the stream for the others, and
        // must never propagate into OpenCode's SSE reader.
      }
    }
    return event
  }

  /** An OpenCode SSE frame, verbatim. */
  publishOpencode(event: { type?: string; properties?: unknown }): KortixEvent | null {
    if (!event || typeof event.type !== 'string' || event.type.length === 0) return null
    return this.publish(event.type, event.properties ?? {}, sessionOf(event.properties))
  }

  /** A daemon-origin event. Types are `kortix.*` by convention and by test. */
  publishDaemon(type: `kortix.${string}`, payload: unknown, session?: string): KortixEvent {
    return this.publish(type, payload, session)
  }

  /**
   * Atomically take the replay for `since` and attach a live listener.
   *
   * `since === null` means "live only" — a fresh stream that wants no history.
   * `epoch` is the client's remembered epoch; a mismatch forces a resync.
   */
  subscribe(
    listener: KortixEventListener,
    options: { since?: number | null; epoch?: string | null } = {},
  ): SubscribeResult {
    const since = options.since ?? null
    const clientEpoch = options.epoch ?? null
    let replay: KortixEvent[] = []
    let resync: KortixResync | null = null

    const makeResync = (reason: KortixResync['reason']): KortixResync => ({
      reason,
      epoch: this.epoch,
      first_seq: this.firstSeq,
      head_seq: this.seq,
      requested_since: since,
      recover: [
        'GET /kortix/opencode/state',
        'GET /kortix/opencode/messages/:sessionId?limit=20',
      ],
    })

    if (since !== null) {
      if (clientEpoch !== null && clientEpoch !== this.epoch) {
        resync = makeResync('epoch-changed')
      } else if (since > this.seq) {
        // The client claims a seq this daemon never issued: a stale cursor from
        // a previous boot whose epoch it did not send. Not recoverable by
        // replay, and serving live events after it would leave a hole.
        resync = makeResync('ahead-of-head')
      } else if (since < this.firstSeq - 1) {
        resync = makeResync('gap-too-old')
      } else {
        replay = this.ring.filter((event) => event.seq > since)
      }
    }

    this.listeners.add(listener)
    const cursor = replay.length > 0 ? replay[replay.length - 1]!.seq : (resync ? this.seq : since ?? this.seq)
    return {
      replay,
      resync,
      cursor,
      unsubscribe: () => {
        this.listeners.delete(listener)
      },
    }
  }

  /** Tests only. */
  __resetForTests(): void {
    this.seq = 0
    this.ring = []
    this.listeners.clear()
  }
}

// ---------------------------------------------------------------------------
// Process singleton
// ---------------------------------------------------------------------------
//
// One bus per daemon, reached from anywhere without threading it through six
// constructors — the same shape `runtime-assets.ts` uses for the convergence
// report and `proxy.ts` for the resource monitor. `main.ts` feeds it OpenCode's
// SSE; the turn observer and boot marks publish into it directly.

let bus: KortixEventBus | null = null

export function kortixEventBus(): KortixEventBus {
  if (!bus) bus = new KortixEventBus()
  return bus
}

export function resetKortixEventBusForTests(): void {
  bus = null
}

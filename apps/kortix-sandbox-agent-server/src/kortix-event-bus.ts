/**
 * Daemon-owned event sequencer. One dense, box-global sequence per epoch.
 * Subscriptions atomically snapshot replay and register the live listener.
 * Adapter code owns event interpretation and supplies resync recovery routes.
 * Payloads pass through unchanged; the ring is bounded and is not durable.
 */
export const DEFAULT_RING_CAPACITY = 2_000

/** One envelope on the wire. */
export interface KortixEvent {
  /** Dense, monotonic, box-global, valid only within `epoch`. */
  seq: number
  /** The harness's event type verbatim, or `kortix.*` for daemon-origin events. */
  type: string
  /** Milliseconds since the epoch, when the daemon sequenced it. */
  at: number
  /**
   * The harness's `properties` verbatim, or the daemon event body. Never
   * reshaped: the SDK reducer is written against The harness's own frames and a
   * rename here would be a silent contract break.
   */
  payload: unknown
  /** Which the harness session this is about, when the frame names one. */
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
        // must never propagate into The harness's SSE reader.
      }
    }
    return event
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
    options: { since?: number | null; epoch?: string | null; recover?: readonly string[] } = {},
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
      recover: [...(options.recover ?? [])],
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
// report and `proxy.ts` for the resource monitor. `main.ts` feeds it The harness's
// SSE; the turn observer and boot marks publish into it directly.

let bus: KortixEventBus | null = null

export function kortixEventBus(): KortixEventBus {
  if (!bus) bus = new KortixEventBus()
  return bus
}

export function resetKortixEventBusForTests(): void {
  bus = null
}

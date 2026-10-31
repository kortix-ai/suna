/** One scheduled job: a loop that runs only on the process holding the leader lease. */
export interface Job {
  /**
   * The `runWorkerTick` names its ticks run under → how long after its last
   * successful tick the heartbeat reports it stale. Set it above the longest
   * wait between two ticks plus the longest legitimate tick; never below
   * `MIN_STALE_AFTER_MS`. `null`: a one-shot the heartbeat never judges.
   */
  readonly ticks: Readonly<Record<string, number | null>>;
  /** Starts the loop. Idempotent. */
  start(): void | Promise<void>;
  /**
   * Stops the loop. Clears its timer before its first await; a returned
   * promise resolves when the tick in flight has finished.
   */
  stop(): void | Promise<void>;
  /** A stall the tick timing cannot see, such as work a tick started but does not await. */
  stalled?(): boolean;
}

/** No job reports stale sooner than this after its last successful tick. */
export const MIN_STALE_AFTER_MS = 10 * 60_000;

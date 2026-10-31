/** One scheduled job: a loop that runs only on the process holding the leader lease. */
export interface Job {
  /** The `runWorkerTick` names its ticks run under. The heartbeat watches these. */
  readonly ticks: readonly string[];
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

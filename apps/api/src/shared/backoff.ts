/** `min(capMs, baseMs * 2 ** max(0, attempt - 1))`: `attempt` 1 waits `baseMs`. */
export function exponentialBackoffMs(opts: { attempt: number; baseMs: number; capMs: number }): number {
  return Math.min(opts.capMs, opts.baseMs * 2 ** Math.max(0, opts.attempt - 1));
}

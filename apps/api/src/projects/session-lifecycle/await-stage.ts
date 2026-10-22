import type { SessionStartResult } from '../session-open';

// startSession long-poll: bounded server-side wait so the client learns `ready`
// the instant it flips instead of on its ~800ms poll tick. The cap is the
// 15 s the SDK asks for (`useSession`'s `waitMs`): at 8 s every poll of a boot
// ended early and paid the route's auth and load prologue again. It stays well
// under the web client's 30s request timeout; the poll cadence is tight because
// each tick is one cheap re-resolve (openSession re-reads live sandbox state).
// Pure (type-only import) so it's unit-testable without the server env.
export const START_AWAIT_MAX_MS = 15_000;
export const START_AWAIT_POLL_MS = 200;

export const isTerminalStage = (stage: string): boolean =>
  stage === 'ready' || stage === 'failed' || stage === 'stopped';

/**
 * Bounded long-poll loop. Given an initial readiness result and a `resolve` that
 * re-checks it, keep polling until a terminal stage (ready/failed/stopped) or the
 * deadline, then return the latest. Returns the initial immediately when already
 * terminal or waitMs<=0 (the immediate-ready fast path). `now`/`sleepFn` are
 * injectable so tests run without wall-clock.
 */
export async function awaitTerminalStage(
  initial: SessionStartResult,
  resolve: () => Promise<SessionStartResult | null>,
  opts: {
    waitMs: number;
    pollMs?: number;
    now?: () => number;
    sleepFn?: (ms: number) => Promise<void>;
    /** The request's abort signal: a closed tab stops the loop's DB and provider reads. */
    signal?: AbortSignal;
  },
): Promise<SessionStartResult> {
  if (opts.waitMs <= 0 || isTerminalStage(initial.stage) || initial.retriable === false)
    return initial;
  const now = opts.now ?? Date.now;
  const sleepFn = opts.sleepFn ?? Bun.sleep;
  const pollMs = opts.pollMs ?? START_AWAIT_POLL_MS;
  const deadline = now() + Math.min(opts.waitMs, START_AWAIT_MAX_MS);
  let current = initial;
  while (now() < deadline && !opts.signal?.aborted) {
    await sleepFn(pollMs);
    if (opts.signal?.aborted) break;
    const next = await resolve();
    if (!next) break;
    current = next;
    if (isTerminalStage(current.stage) || current.retriable === false) break;
  }
  return current;
}

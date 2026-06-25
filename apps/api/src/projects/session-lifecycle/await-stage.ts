import type { SessionStartResult } from '../routes/shared';

// startSession long-poll: bounded server-side wait so the client learns `ready`
// the instant it flips instead of on its ~800ms poll tick. The cap stays well
// under the web client's 30s request timeout; the poll cadence is tight because
// each tick is one cheap re-resolve (openSession re-reads live sandbox state).
// Pure (type-only import) so it's unit-testable without the server env.
export const START_AWAIT_MAX_MS = 8_000;
export const START_AWAIT_POLL_MS = 200;

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export const isTerminalStage = (stage: string): boolean =>
  stage === 'ready' || stage === 'failed' || stage === 'stopped';

/**
 * Bounded long-poll loop. Given an initial readiness result and a `resolve` that
 * re-checks it, keep polling until a terminal stage (ready/failed/stopped) or the
 * deadline, then return the latest. Returns the initial immediately when already
 * terminal or waitMs<=0 (the warm-claim fast path). `now`/`sleepFn` are
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
  },
): Promise<SessionStartResult> {
  if (opts.waitMs <= 0 || isTerminalStage(initial.stage)) return initial;
  const now = opts.now ?? Date.now;
  const sleepFn = opts.sleepFn ?? defaultSleep;
  const pollMs = opts.pollMs ?? START_AWAIT_POLL_MS;
  const deadline = now() + Math.min(opts.waitMs, START_AWAIT_MAX_MS);
  let current = initial;
  while (now() < deadline) {
    await sleepFn(pollMs);
    const next = await resolve();
    if (!next) break;
    current = next;
    if (isTerminalStage(current.stage)) break;
  }
  return current;
}

/**
 * Bring a PARKED event stream back.
 *
 * `openEventStream` parks after a run of hard failures and documents itself as
 * terminal for that handle — correct, and the point: a dead or archived sandbox
 * should not be hammered forever. But nothing in this package supplied
 * `onParked`, so "terminal for this handle" silently became "terminal for this
 * page". The session view went on rendering a transcript nobody was updating,
 * with no error and no retry, until the user reloaded. That is the "it just
 * loses connection" report.
 *
 * Parking is not a verdict about the sandbox, only about the last few attempts.
 * So revive on the cheapest evidence that something may have changed —
 *
 *   - the tab came back (it was throttled; the world moved without us)
 *   - the network came back
 *   - nothing happened for `reviveAfterMs`, so try once anyway
 *
 * — and revive exactly ONCE per park, so a genuinely dead box costs one connect
 * attempt per interval instead of a retry storm.
 */
export interface StreamRevivalOptions {
  /** Self-heal delay when no external signal arrives. Default 30s. */
  reviveAfterMs?: number;
  setTimeout?: (handler: () => void, ms: number) => unknown;
  clearTimeout?: (handle: unknown) => void;
  /** Subscribe to a global event; returns its unsubscribe. Injected for tests. */
  listen?: (event: string, handler: () => void) => () => void;
}

export interface StreamRevival {
  /** The stream parked. Arm the triggers. */
  park: () => void;
  /** Tear down, whether or not a revival is armed. */
  stop: () => void;
}

const DEFAULT_REVIVE_AFTER_MS = 30_000;

function defaultListen(event: string, handler: () => void): () => void {
  if (typeof globalThis.addEventListener !== 'function') return () => {};
  const target = event === 'visibilitychange' && typeof document !== 'undefined' ? document : globalThis;
  const wrapped = () => {
    // A hidden tab is not evidence of anything; only the return is.
    if (event === 'visibilitychange' && typeof document !== 'undefined') {
      if (document.visibilityState !== 'visible') return;
    }
    handler();
  };
  target.addEventListener(event, wrapped);
  return () => target.removeEventListener(event, wrapped);
}

export function createStreamRevival(
  revive: () => void,
  options: StreamRevivalOptions = {},
): StreamRevival {
  const reviveAfterMs = options.reviveAfterMs ?? DEFAULT_REVIVE_AFTER_MS;
  const setTimer = options.setTimeout ?? ((handler, ms) => setTimeout(handler, ms));
  const clearTimer = options.clearTimeout ?? ((handle) => clearTimeout(handle as never));
  const listen = options.listen ?? defaultListen;

  let armed = false;
  let timer: unknown;
  let unsubscribers: Array<() => void> = [];

  const disarm = () => {
    if (!armed) return;
    armed = false;
    if (timer !== undefined) clearTimer(timer);
    timer = undefined;
    for (const unsubscribe of unsubscribers) unsubscribe();
    unsubscribers = [];
  };

  const fire = () => {
    if (!armed) return;
    disarm();
    revive();
  };

  return {
    park: () => {
      if (armed) return;
      armed = true;
      timer = setTimer(fire, reviveAfterMs);
      unsubscribers = [listen('visibilitychange', fire), listen('online', fire)];
    },
    stop: disarm,
  };
}

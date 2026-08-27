/**
 * WHO is on the session stream right now — a tiny framework-free registry.
 *
 * The control channel of `GET .../sessions/:sid/stream` carries the same
 * projections the `/turn` and `/prompts` polls used to fetch, from the same
 * server functions. While a stream is delivering for a session, those polls
 * are pure duplication — but a client that cannot reach the stream (or a
 * surface mounted with no stream at all) still needs them. This registry is
 * the switch: the stream hook marks its scope connected, and the poll owners
 * read it to hand their cadence over.
 *
 * Refcounted, because StrictMode double-mounts and a reconnect overlap can
 * briefly hold two live connections for one scope. The subscription notifies
 * only when the BOOLEAN answer flips — presence is the only fact consumers
 * read.
 */

interface PresenceScope {
  connected: number;
  /** The RUNTIME channel is delivering daemon frames — a stricter fact than
   *  `connected`: the stream can be up (control snapshots flowing) while the
   *  box is stopped, waking, or running a daemon too old to serve
   *  `/kortix/opencode/events`. The transcript fallback poll keys on THIS. */
  runtimeLive: boolean;
  listeners: Set<() => void>;
}

const scopes = new Map<string, PresenceScope>();

function stateFor(scope: string): PresenceScope {
  let state = scopes.get(scope);
  if (!state) {
    state = { connected: 0, runtimeLive: false, listeners: new Set() };
    scopes.set(scope, state);
  }
  return state;
}

function forget(scope: string, state: PresenceScope): void {
  if (state.connected === 0 && !state.runtimeLive && state.listeners.size === 0) {
    scopes.delete(scope);
  }
}

/** Record one connection's connected/disconnected transition for `scope`. */
export function markSessionStreamConnected(scope: string, connected: boolean): void {
  if (!scope) return;
  const state = stateFor(scope);
  const was = state.connected > 0;
  state.connected = Math.max(0, state.connected + (connected ? 1 : -1));
  const is = state.connected > 0;
  if (was !== is) for (const listener of state.listeners) listener();
  forget(scope, state);
}

/** Is at least one stream delivering for `scope` right now? */
export function isSessionStreamConnected(scope: string): boolean {
  return (scopes.get(scope)?.connected ?? 0) > 0;
}

/** Record whether the RUNTIME channel is live for `scope` — daemon frames are
 *  actually flowing (attach up), not merely the stream being connected. */
export function markSessionRuntimeChannelLive(scope: string, live: boolean): void {
  if (!scope) return;
  const state = stateFor(scope);
  if (state.runtimeLive === live) {
    forget(scope, state);
    return;
  }
  state.runtimeLive = live;
  for (const listener of state.listeners) listener();
  forget(scope, state);
}

/** Are daemon frames flowing for `scope` right now? */
export function isSessionRuntimeChannelLive(scope: string): boolean {
  return scopes.get(scope)?.runtimeLive ?? false;
}

/** Re-run me when `scope`'s presence flips. Returns the unsubscribe. */
export function subscribeSessionStreamPresence(scope: string, listener: () => void): () => void {
  const state = stateFor(scope);
  state.listeners.add(listener);
  return () => {
    state.listeners.delete(listener);
    forget(scope, state);
  };
}

/** Drop everything. Tests only. */
export function resetSessionStreamPresence(): void {
  scopes.clear();
}

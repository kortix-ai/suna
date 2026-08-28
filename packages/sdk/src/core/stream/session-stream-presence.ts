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
  /** The last `kortix.control.audit` watermark fingerprint seen for this scope,
   *  and a monotonic tick bumped whenever it changes. The audit surface reads
   *  the tick to invalidate its query on a real change instead of polling. */
  auditFingerprint: string | null;
  auditTick: number;
  /**
   * Has a `kortix.control.turn` frame arrived since the CURRENT attach?
   *
   * `connected` is a promise that the control channel will answer; this is the
   * answer having arrived. The reconciler pushes turn frames ON CHANGE, so a
   * session resumed with a turn row already open produces no change and no
   * frame — the poll that would have converged it had already stood down on
   * `connected`, and the stale row then read as `working` until the whole
   * observation aged out (`SERVER_OBSERVATION_MAX_MS`, 45s). Resuming showed
   * "Gathering thoughts..." over a finished transcript for that long.
   */
  turnCorroborated: boolean;
  listeners: Set<() => void>;
  /** Separate listeners so an audit change does not re-render presence
   *  consumers (turn/prompt poll owners), which read `connected`/`runtimeLive`
   *  and do not care about the audit watermark. */
  auditListeners: Set<() => void>;
}

const scopes = new Map<string, PresenceScope>();

function stateFor(scope: string): PresenceScope {
  let state = scopes.get(scope);
  if (!state) {
    state = {
      connected: 0,
      runtimeLive: false,
      auditFingerprint: null,
      auditTick: 0,
      turnCorroborated: false,
      listeners: new Set(),
      auditListeners: new Set(),
    };
    scopes.set(scope, state);
  }
  return state;
}

function forget(scope: string, state: PresenceScope): void {
  if (
    state.connected === 0 &&
    !state.runtimeLive &&
    state.listeners.size === 0 &&
    state.auditListeners.size === 0
  ) {
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
  // A new attach starts UNCORROBORATED: whatever the last connection was told
  // says nothing about this one, and a reconnect is exactly when a stale open
  // row is most likely to be sitting in the cache.
  if (was !== is) {
    state.turnCorroborated = false;
    for (const listener of state.listeners) listener();
  }
  forget(scope, state);
}

/**
 * Record that a `kortix.control.turn` frame has arrived for `scope`.
 *
 * This is what makes standing the `/turn` poll down on `connected` safe: until
 * it fires, a connected stream has promised an answer and not yet given one.
 */
export function markSessionControlTurn(scope: string): void {
  if (!scope) return;
  const state = stateFor(scope);
  if (state.turnCorroborated) {
    forget(scope, state);
    return;
  }
  state.turnCorroborated = true;
  for (const listener of state.listeners) listener();
  forget(scope, state);
}

/** Has the control channel answered about turns since the current attach? */
export function isSessionTurnCorroborated(scope: string): boolean {
  return scopes.get(scope)?.turnCorroborated ?? false;
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

/**
 * Record the newest `kortix.control.audit` watermark for `scope`.
 *
 * The audit surface polls no more: this is the push that tells it a
 * connector-gated approval appeared or was resolved. Bumps a monotonic tick
 * ONLY when the fingerprint actually changes, so re-emitting the same snapshot
 * (a reconnect replay) does not invalidate the audit query for nothing.
 */
export function markSessionAuditWatermark(scope: string, fingerprint: string): void {
  if (!scope) return;
  const state = stateFor(scope);
  if (state.auditFingerprint === fingerprint) {
    forget(scope, state);
    return;
  }
  state.auditFingerprint = fingerprint;
  state.auditTick += 1;
  for (const listener of state.auditListeners) listener();
  forget(scope, state);
}

/** The current audit watermark tick for `scope` — changes when the audit
 *  surface has something new to read. */
export function getSessionAuditTick(scope: string): number {
  return scopes.get(scope)?.auditTick ?? 0;
}

/** Re-run me when `scope`'s audit watermark changes. Returns the unsubscribe. */
export function subscribeSessionAudit(scope: string, listener: () => void): () => void {
  const state = stateFor(scope);
  state.auditListeners.add(listener);
  return () => {
    state.auditListeners.delete(listener);
    forget(scope, state);
  };
}

/** Drop everything. Tests only. */
export function resetSessionStreamPresence(): void {
  scopes.clear();
}

/**
 * ONE cadence per session fact, however many components read it.
 *
 * THE PROBLEM. TanStack schedules `refetchInterval` PER OBSERVER, not per
 * query. Three hooks mount the `/turn` query on a session route (`useSession`,
 * the composer, the session panel) and two mount `/prompts`, so one key ran
 * three timers and the session was polled at three times its declared cadence.
 * Measured on a real deployment: 6 `GET .../turn` inside a single 25 s session
 * open, against a 5 s working / 15 s idle contract.
 *
 * THE RULE. Exactly one observer per scope owns the interval; the rest pass
 * `refetchInterval: false` and read the same cache entry the owner refreshes.
 * They share a query key, so an answer reaches every observer either way —
 * only the SCHEDULING is exclusive.
 *
 * OWNERSHIP MUST SURVIVE THE OWNER. A session whose only poller unmounted would
 * stop learning that a turn started somewhere else (a trigger, a second device,
 * the inbox delivering a queued prompt), so releasing hands the cadence to the
 * next claimant and notifies it.
 *
 * Framework-free on purpose: `react/use-poll-owner.ts` is a thin
 * `useSyncExternalStore` over this, and the rules live where they can be tested
 * without rendering anything.
 */

interface ScopeState {
  /** Claim order. The head owns the cadence; insertion order is what makes
   *  "the first one that mounted" a decision rather than a race. */
  claimants: string[];
  listeners: Set<() => void>;
}

const scopes = new Map<string, ScopeState>();

function stateFor(scope: string): ScopeState {
  let state = scopes.get(scope);
  if (!state) {
    state = { claimants: [], listeners: new Set() };
    scopes.set(scope, state);
  }
  return state;
}

function notify(state: ScopeState): void {
  for (const listener of state.listeners) listener();
}

function forget(scope: string, state: ScopeState): void {
  // Leak hygiene: a per-session registry that never shrinks is a per-session
  // leak. A scope with no claimants and no listeners has nothing to remember.
  if (state.claimants.length === 0 && state.listeners.size === 0) scopes.delete(scope);
}

/** Register `id` as a candidate poller for `scope`. Idempotent. */
export function claimPoller(scope: string, id: string): void {
  if (!scope || !id) return;
  const state = stateFor(scope);
  if (state.claimants.includes(id)) return;
  const wasOwner = state.claimants[0];
  state.claimants.push(id);
  if (state.claimants[0] !== wasOwner) notify(state);
}

/** Give up `id`'s claim. If it held the cadence, the next claimant takes it. */
export function releasePoller(scope: string, id: string): void {
  const state = scopes.get(scope);
  if (!state) return;
  const index = state.claimants.indexOf(id);
  if (index === -1) return;
  const wasOwner = state.claimants[0];
  state.claimants.splice(index, 1);
  if (state.claimants[0] !== wasOwner) notify(state);
  forget(scope, state);
}

/** Does `id` own `scope`'s cadence right now? */
export function isPollOwner(scope: string, id: string): boolean {
  const state = scopes.get(scope);
  if (!state) return false;
  return state.claimants[0] === id;
}

/** Re-render me when this scope's owner changes. Returns the unsubscribe. */
export function subscribePollOwner(scope: string, listener: () => void): () => void {
  const state = stateFor(scope);
  state.listeners.add(listener);
  return () => {
    state.listeners.delete(listener);
    forget(scope, state);
  };
}

/** Drop everything. Tests only. */
export function resetPollOwners(): void {
  scopes.clear();
}

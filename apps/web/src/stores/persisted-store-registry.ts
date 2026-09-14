/**
 * Lets a persisted zustand store register its OWN sign-out reset, so
 * `reset-client-state.ts` — imported by `AuthProvider`, which mounts on
 * EVERY route — never has to statically `import` the store module itself.
 *
 * That indirection exists because of a real, measured regression: a store's
 * own file often imports feature code far heavier than its persisted state
 * needs (`session-browser-store.ts` → `kortix-computer-store.ts` →
 * `features/files` → … → the shiki-backed markdown code renderer, ~3.8MB).
 * `connectors-page.chunk.test.ts` walks the connectors route's real static
 * import graph and asserts that renderer is NOT in its initial chunk — a
 * static `import { useSessionBrowserStore } from '@/stores/session-browser-store'`
 * inside `reset-client-state.ts` put it there, because an ES module is
 * all-or-nothing to the bundler and `reset-client-state.ts` sits on every
 * route's critical path through `AuthProvider`.
 *
 * This module has NO imports of its own and MUST stay that way — the whole
 * point is a leaf `reset-client-state.ts` can depend on regardless of which
 * heavy stores exist.
 *
 * A store that registers itself only when its own module is evaluated has a
 * useful property for free: a route that never loads a given store's module
 * never has it in this registry at sign-out — but it also never accumulated
 * any in-memory state on that store to leak, since the module never ran.
 * "Not registered" and "nothing to reset" are the same fact.
 */

const registry = new Map<string, () => void>();

/**
 * A persisted zustand store's public surface, generic over its state shape.
 * `getInitialState()` returns the exact object the store's creator function
 * produced, BEFORE `persist` hydrated it from disk — see zustand's own
 * `persistImpl` (`api.getInitialState = () => configResult`) — so it is
 * always the pristine, identity-neutral default. Resetting to it can never
 * drift from the real shape the way a hand-copied `initialState` duplicate
 * could, because it comes from the store itself.
 */
interface ResettablePersistedStore<T> {
  getInitialState: () => T;
  setState: (state: T, replace: true) => void;
}

export function resetPersistedStore<T>(store: ResettablePersistedStore<T>): void {
  store.setState(store.getInitialState(), true);
}

/**
 * Call once per persisted store, at the store's own module scope, right
 * after `create()` — e.g. in `stores/browser-recents-store.ts`:
 *
 *   registerPersistedStore('kortix-browser-recents', () =>
 *     resetPersistedStore(useBrowserRecentsStore),
 *   );
 *
 * `name` must be the store's OWN `persist` `name:` — it is checked against
 * that value by `persisted-store-coverage.test.ts`, which also fails closed
 * if a persisted store under `src/stores/` has no matching registration at
 * all.
 */
export function registerPersistedStore(name: string, reset: () => void): void {
  registry.set(name, reset);
}

/** Reset every registered store's in-memory state, synchronously. */
export function resetAllRegisteredPersistedStores(): void {
  for (const [name, reset] of registry) {
    try {
      reset();
    } catch (error) {
      console.error(`Failed to reset persisted store '${name}':`, error);
    }
  }
}

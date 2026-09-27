/**
 * Module-scoped state that belongs to the signed-in user registers its reset
 * here, at its own module scope, without adding a public export for it.
 * `resetIdentityState()` runs every registered reset.
 *
 * Internal: not exported from a public entry point.
 */
const resets = new Set<() => void>();

export function registerIdentityReset(reset: () => void): void {
  resets.add(reset);
}

export function runIdentityResets(): void {
  for (const reset of resets) {
    try {
      reset();
    } catch (error) {
      console.warn('[resetIdentityState] a reset threw; continuing', error);
    }
  }
}

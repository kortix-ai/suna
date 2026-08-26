/**
 * The instant the start give-up verdict can change with no new input, or null
 * when nothing is pending.
 *
 * Internal. Not re-exported from `packages/sdk/src/react/index.ts`, so it stays
 * off the public surface.
 */
export function startGiveUpExpiryAtMs(input: {
  inconclusiveSinceMs: number | null;
  budgetMs: number;
}): number | null {
  if (input.inconclusiveSinceMs === null) return null;
  return input.inconclusiveSinceMs + input.budgetMs;
}

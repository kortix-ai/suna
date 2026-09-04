import type { FlatModel } from '@kortix/sdk/react';

/**
 * Which models the picker shows when the search box is EMPTY — the default
 * view. Pure, so the rule is testable without mounting the popover.
 *
 * Gateway (`kortix`-provider) models are already server-curated: the
 * `/model-picker` catalog stamps `enabled` from the shared newest-per-family
 * rule, and the `enabled !== false` filter upstream of this function applies
 * it. NATIVE provider models had no equivalent — the runtime list (opencode's
 * own catalog) and the pre-runtime list (models.dev via the API) are both
 * unstamped, so a connected OpenRouter key rendered ALL ~355 models as a
 * wall. This applies the client twin of the same rule: the model store's
 * `isVisible` (newest per family within the window, flagships, plus the
 * user's explicit show/hide pins).
 *
 * Two deliberate carve-outs:
 *  • a SEARCH query reveals everything — typing is intent, and hiding search
 *    hits behind a second toggle is how models become unfindable;
 *  • the currently-selected model always renders, or the check mark would
 *    point at a row that does not exist.
 */
export function modelInDefaultView(
  model: FlatModel,
  input: {
    search: string;
    isStoreVisible: (model: { providerID: string; modelID: string }) => boolean;
    selected: { providerID: string; modelID: string } | null;
  },
): boolean {
  if (input.search.trim().length > 0) return true;
  if (model.providerID === 'kortix') return true;
  if (
    input.selected &&
    input.selected.providerID === model.providerID &&
    input.selected.modelID === model.modelID
  ) {
    return true;
  }
  return input.isStoreVisible({ providerID: model.providerID, modelID: model.modelID });
}

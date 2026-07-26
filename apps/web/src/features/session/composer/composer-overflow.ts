/**
 * Pure show/hide logic for the composer's overflow ("⋯") control — the single
 * low-emphasis affordance the simple toolbar hides everything behind (agent,
 * model, variant, reasoning effort). Mirrors the exact per-control conditions
 * the dense/advanced toolbar has always used, so a control that wouldn't have
 * rendered in advanced mode doesn't get a phantom row in the overflow menu
 * either — and if NONE of them would render, the overflow trigger itself
 * disappears rather than opening onto an empty popover.
 */

export interface ComposerOverflowVisibility {
  showAgent: boolean;
  showModel: boolean;
  showVariant: boolean;
  showReasoningEffort: boolean;
}

export function hasComposerOverflowContent(visibility: ComposerOverflowVisibility): boolean {
  return (
    visibility.showAgent ||
    visibility.showModel ||
    visibility.showVariant ||
    visibility.showReasoningEffort
  );
}

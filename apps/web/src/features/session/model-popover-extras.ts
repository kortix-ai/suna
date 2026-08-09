/**
 * Show/hide source of truth for the "extras" section inside the model
 * popover — the variant (thinking mode) and reasoning-effort rows that Task
 * 10 folded in below the model list. Pure so it's testable without mounting
 * React or a query client, matching how `model-availability.ts` /
 * `model-grouping.ts` split logic from `model-selector.tsx`'s rendering.
 *
 * Reasoning-effort's OWN capability gate (does this model expose an effort
 * knob at all) still lives solely in `reasoningEffortValuesFor`
 * (reasoning-effort-selector.ts) — this function only combines that result
 * with the project-scoping requirement to decide whether the row (and the
 * wrapping section) should render. It never re-derives which values a model
 * offers.
 */
export interface ModelExtrasRowsInput {
  /** Named variants the current model/agent offers (opencode's legacy
   *  per-model `variant` map). */
  variants: string[];
  /** Whether the caller wired a variant-change handler at all — a picker
   *  with no handler (e.g. read-only pickers) never shows the row even if
   *  variants exist. */
  hasVariantHandler: boolean;
  /** `reasoningEffortValuesFor(wireModel)` for the currently selected model —
   *  empty when the model has no reasoning-effort knob. */
  reasoningEffortValues: string[];
  /** Reasoning effort is a per-project setting; with no project to scope it
   *  to, there is nothing to show or write. */
  hasProjectId: boolean;
}

export interface ModelExtrasRows {
  showVariantRow: boolean;
  showReasoningEffortRow: boolean;
  /** Whether the wrapping `border-t` section should render at all. False
   *  keeps every non-composer `ModelSelector` call site (which never passes
   *  variants/projectId) byte-identical to before Task 10. */
  showSection: boolean;
}

export function computeModelExtrasRows({
  variants,
  hasVariantHandler,
  reasoningEffortValues,
  hasProjectId,
}: ModelExtrasRowsInput): ModelExtrasRows {
  const showVariantRow = variants.length > 0 && hasVariantHandler;
  const showReasoningEffortRow = hasProjectId && reasoningEffortValues.length > 0;
  return {
    showVariantRow,
    showReasoningEffortRow,
    showSection: showVariantRow || showReasoningEffortRow,
  };
}

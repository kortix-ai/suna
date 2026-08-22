/**
 * Show/hide source of truth for the "extras" section inside the model
 * popover. Pure so it's testable without mounting React or a query client,
 * matching how `model-availability.ts` / `model-grouping.ts` split logic from
 * `model-selector.tsx`'s rendering.
 *
 * This used to decide TWO rows — variant and reasoning effort. Reasoning
 * effort moved out to its own composer-toolbar control
 * (`reasoning-effort-selector.tsx`), so the reasoning inputs
 * (`reasoningEffortValues`, `hasProjectId`) are gone with it: a predicate that
 * still accepted them would imply the popover can show a row it no longer
 * has. What remains is one condition, kept as a named function rather than
 * inlined so the popover's footer keeps a single documented gate and every
 * non-composer `ModelSelector` call site (which passes no variants) stays
 * byte-identical.
 */
export interface ModelExtrasRowsInput {
  /** Named variants the current model/agent offers (opencode's legacy
   *  per-model `variant` map). */
  variants: string[];
  /** Whether the caller wired a variant-change handler at all — a picker
   *  with no handler (e.g. read-only pickers) never shows the row even if
   *  variants exist. */
  hasVariantHandler: boolean;
}

export interface ModelExtrasRows {
  showVariantRow: boolean;
  /** Whether the wrapping `border-t` section should render at all. */
  showSection: boolean;
}

export function computeModelExtrasRows({
  variants,
  hasVariantHandler,
}: ModelExtrasRowsInput): ModelExtrasRows {
  const showVariantRow = variants.length > 0 && hasVariantHandler;
  return { showVariantRow, showSection: showVariantRow };
}

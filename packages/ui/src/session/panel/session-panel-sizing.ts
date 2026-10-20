/** Viewer padding + scrollbar allowance around a fitted preview, px — added
 *  to the ideal pixel width inside {@link fitSplitPercent}. */
const PREVIEW_GUTTER_PX = 48;

/** `PreviewShell`'s toolbar bar height, px (`px-3 py-2.5` around a `size-7`
 *  control) — subtracted from the panel box to get `panelContentHeight`
 *  before calling {@link fitSplitPercent}. */
const PREVIEW_TOOLBAR_PX = 48;

/** Floor for a fitted split, percent — matches the `ResizablePanel`'s own
 *  `minSize` (`session-layout.tsx`) so a fit can never ask for a column the
 *  layout would refuse to give it. */
const FIT_MIN_PERCENT = 35;

/** Ceiling for a fitted split, percent — matches the `ResizablePanel`'s own
 *  `maxSize`, same reasoning as {@link FIT_MIN_PERCENT}. */
const FIT_MAX_PERCENT = 70;

/**
 * The split percentage that shows a document at its own aspect ratio,
 * instead of the fixed 35/70 splits `isWideDeliverable` picks from — a
 * portrait PDF wants a narrower column than a landscape one, and neither is
 * well served by a single constant.
 *
 * Derived from the box the preview actually has to fill: the ideal pixel
 * width is the content height scaled by the document's aspect plus a fixed
 * gutter for padding/scrollbar, then expressed as a percentage of the whole
 * panel group and clamped to the same 35/70 bounds the layout already
 * enforces elsewhere.
 *
 * Returns `null` — never `NaN` — for any input that can't produce a sane
 * percentage (Global Constraint 6: a `NaN` handed to `panel.resize` collapses
 * the layout). `null` means "no opinion"; the caller falls back to
 * `panelSplit`.
 */
export function fitSplitPercent(input: {
  /** Intrinsic width / height of the document. */
  aspect: number;
  /** Width of the whole ResizablePanelGroup, px. */
  layoutWidth: number;
  /** Panel box height minus its toolbar, px. */
  panelContentHeight: number;
}): number | null {
  const { aspect, layoutWidth, panelContentHeight } = input;

  if (!Number.isFinite(aspect) || aspect <= 0) return null;
  if (!Number.isFinite(layoutWidth) || layoutWidth <= 0) return null;
  if (!Number.isFinite(panelContentHeight) || panelContentHeight <= 0) return null;

  const idealPx = aspect * panelContentHeight + PREVIEW_GUTTER_PX;
  const percent = (idealPx / layoutWidth) * 100;
  return Math.min(FIT_MAX_PERCENT, Math.max(FIT_MIN_PERCENT, percent));
}

/**
 * The side panel's share of the split, in percent — the single place the
 * precedence between fullscreen, panel mode, a measured document and a
 * layer's requested split is decided.
 *
 * Highest wins:
 * 1. `isExpanded` — fullscreen owns the whole layout; nothing outranks it.
 * 2. Advanced mode — its even 50/50 predates ratio fit and stays untouched.
 * 3. The document's own shape, via {@link fitSplitPercent} — a measured
 *    portrait PDF beats the fixed guess a file extension made about it.
 * 4. `panelSplit` — the layer's explicit request (70 for a deck, 50 for the
 *    terminal), still the answer for everything that reports no size.
 * 5. 35 — the default card column.
 *
 * Pure and exported because this precedence IS the user-visible behavior of
 * ratio fit, and `SessionLayout` cannot be rendered without a DOM.
 */
export function resolveSideSize(input: {
  isExpanded: boolean;
  isEasy: boolean;
  /** The open document's width / height, once a renderer has reported it. */
  panelAspect: number | null;
  /** The open layer's requested split — see {@link isWideDeliverable}. */
  panelSplit: number | null;
  /** The whole `ResizablePanelGroup`'s box, px; `null` before it is measured. */
  panelBox: { width: number; height: number } | null;
}): number {
  if (input.isExpanded) return 100;
  if (!input.isEasy) return 50;

  const fitted =
    input.panelAspect != null && input.panelBox
      ? fitSplitPercent({
          aspect: input.panelAspect,
          layoutWidth: input.panelBox.width,
          panelContentHeight: input.panelBox.height - PREVIEW_TOOLBAR_PX,
        })
      : null;

  // 35 as a literal, not FIT_MIN_PERCENT: this is the card column's width,
  // which happens to equal the fit's floor but does not mean the same thing.
  return fitted ?? input.panelSplit ?? 35;
}

/** How far apart two split percentages must be before the layout treats them
 *  as different widths — the tolerance for {@link aspectChangedWidth}. Half a
 *  percent of a 1400px layout is 7px: below that there is nothing to see, and
 *  a drag lands on fractional percentages that must not read as a change. */
const PANEL_SIZE_EPSILON_PERCENT = 0.5;

/**
 * Whether a new `panelAspect` actually asks the panel to move.
 *
 * Two failures this exists to prevent, both invisible in a type checker:
 *
 * - A measurement that computes to the width the panel already has must not
 *   start a transition. Nothing would move, but the layout would still swing
 *   its panels' `minSize`/`maxSize`/`collapsible` for 320ms.
 * - A measurement that DOES ask for a different width must always be treated
 *   as a change, or the unconditional `resize()` that follows commits the new
 *   width with no transition attached — a jump cut. This is why `currentSize`
 *   must be the panel's REAL size (`ImperativePanelHandle.getSize()`) and not
 *   the width the layout last commanded: a user dragging the divider moves the
 *   panel without telling `SessionLayout` anything, so the two diverge exactly
 *   when a hand-placed width is at stake.
 */
export function aspectChangedWidth(input: {
  /** The ratio the layout last acted on. */
  prevAspect: number | null;
  /** The ratio it is acting on now. */
  nextAspect: number | null;
  /** The panel's real current width, percent — read from the panel handle. */
  currentSize: number;
  /** The width {@link resolveSideSize} now wants, percent. */
  nextSize: number;
  epsilon?: number;
}): boolean {
  if (input.prevAspect === input.nextAspect) return false;

  // A width we cannot compare is a width we must not silently jump to: treat
  // an unreadable size as a real change so the move keeps its transition.
  if (!Number.isFinite(input.currentSize) || !Number.isFinite(input.nextSize)) return true;

  const epsilon = Number.isFinite(input.epsilon)
    ? (input.epsilon as number)
    : PANEL_SIZE_EPSILON_PERCENT;
  return Math.abs(input.currentSize - input.nextSize) > epsilon;
}

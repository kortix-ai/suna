/**
 * Pure logic for `EasyPanel`, split out from the client component purely so
 * it is unit-testable without a DOM.
 */

import { parseLocalhostUrl } from '@/lib/utils/sandbox-url';
import type { BrowserRecent } from '@/stores/browser-recents-store';
import type { OutputItem } from '../shared/derive-panels';
import type { Step } from '../shared/group-steps';
import type { RunOutcome } from '../shared/run-outcome';

/**
 * The step that owns a given tool call — what the chat→panel focus effect
 * needs to turn "user clicked this call in the chat" into "open this step's
 * detail". Pulled out of the effect body so it's testable without mounting
 * `EasyPanel` (see `mode-gate.test.tsx`).
 */
export function stepForCallId(steps: Step[], callId: string): Step | undefined {
  return steps.find((s) => s.parts.some((p) => p.callID === callId));
}

/**
 * Where inside a step's parts the clicked call lives.
 *
 * A step is a GROUP — "Ran 13 commands" holds 13 parts behind one scrubber.
 * Opening it without this always landed on `parts.length - 1` in live mode, so
 * clicking the 4th command showed the 13th and every later click appeared to
 * do nothing. Returns -1 when the call isn't in this step, which the caller
 * reads as "no focus, follow live".
 */
export function focusIndexForCall(
  parts: ReadonlyArray<{ callID?: string }>,
  callId: string | null | undefined,
): number {
  if (!callId) return -1;
  return parts.findIndex((p) => p.callID === callId);
}

/**
 * The synthetic app `OutputItem` behind the header/palette "Open Browser"
 * quick-view — the first running app's url when the session has one, else an
 * EMPTY url: `AppPreview` renders its "no app yet" landing (helper copy +
 * focused address bar) for that, teaching ports without iframing a guessed,
 * usually-dead `localhost:3000`. `callID: 'quick-browser'` never collides
 * with a real tool call's.
 */
export function quickBrowserOutput(
  apps: OutputItem[],
  /**
   * A caller that knows the exact page it wants (a `show` preview button, a
   * localhost link clicked in chat) names it here. Without this the browser
   * always opened on the first running app — the right surface showing the
   * wrong page.
   */
  target?: { url?: string; title?: string },
): OutputItem {
  return {
    callID: 'quick-browser',
    name: target?.title || 'Browser',
    kind: 'app',
    url: target?.url || apps[0]?.url || '',
  };
}

/**
 * A synthetic `OutputItem` for a bare sandbox path — what a file-path click in
 * the chat produces, where there is no Outputs row to open.
 *
 * Same trick as `quickBrowserOutput`: routing through `handleOpenOutput`
 * instead of a second open funnel means a clicked path inherits the detail
 * layer's ask-for-changes, panel-split default and tracking for free, and
 * cannot drift from how an Outputs row opens the same file.
 *
 * `callID` is the path itself so `outputKey` stays unique per file — two
 * different files clicked in a row must produce two different keys, or the
 * detail layer treats the second as the same detail and skips its animation.
 * `fresh` is deliberately unset: freshness means "this run produced it", and a
 * click says nothing about which run the file came from.
 */
export function pathOutput(path: string): OutputItem {
  return {
    callID: `path:${path}`,
    name: path.split('/').filter(Boolean).pop() ?? path,
    kind: 'file',
    path,
  };
}

/**
 * The recents `AppPreview`'s no-app landing can actually navigate to. The
 * shared recents store also holds external browsing history (BrowserPanel's
 * web mode), but the in-panel browser is sandbox-ports-only — offering a
 * github.com row it would refuse to open is a dead affordance. Pure for the
 * same testability reason as the rest of this file.
 */
export function sandboxRecents(recents: BrowserRecent[]): BrowserRecent[] {
  return recents.filter((r) => !!parseLocalhostUrl(r.url));
}

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

/**
 * Whether an output deliverable should grow the Easy-mode panel to its
 * widest split (70/30) instead of the default 35/65 — landscape-shaped
 * content needs real width to read, unlike a text file or a screenshot.
 * True for:
 * - decks (`kind === 'presentation'` from `derive-panels.ts`, plus
 *   `.pptx/.ppt/.key` filenames whose output kept `kind: 'file'` —
 *   write/edit/apply_patch outputs hardcode `'file'` regardless of extension);
 * - running apps (`kind === 'app'` — the in-panel browser is a website, and
 *   websites assume a desktop viewport);
 * - spreadsheets and grids (`.xlsx/.xls/.csv/.tsv` — columns clip at 35%);
 * - web pages (`.html/.htm` — same viewport assumption as apps).
 */
export function isWideDeliverable(output: Pick<OutputItem, 'kind' | 'name'>): boolean {
  if (output.kind === 'presentation' || output.kind === 'app') return true;
  return /\.(pptx?|key|xlsx?|csv|tsv|html?)$/i.test(output.name);
}

/**
 * React key for one Outputs row.
 *
 * `OutputItem.callID` is NOT unique on its own: a single `apply_patch` call
 * produces one `OutputItem` per file it actually changed, and every one of
 * those items shares that call's `callID` (see `applyPatchOutputs` in
 * `derive-panels.ts`). Keying a list on `callID` alone collides and either
 * drops rows or scrambles React's reconciliation across re-renders. The path
 * (falling back to the display name when a call has none) is what actually
 * distinguishes those rows, so the key combines both: the callID keeps
 * unrelated calls that happen to touch the same path apart, and the
 * path/name keeps multiple files from one call apart.
 */
export function outputKey(output: Pick<OutputItem, 'callID' | 'path' | 'name'>): string {
  return `${output.callID}:${output.path ?? output.name}`;
}

/** The row before and after the currently open output, in the list's own
 * order — what makes "next" mean the same thing the card's rows mean (W10). */
export function neighborOutputs(
  items: OutputItem[],
  currentKey: string,
): { prev: OutputItem | null; next: OutputItem | null; position: string } {
  const index = items.findIndex((item) => outputKey(item) === currentKey);
  if (index < 0) return { prev: null, next: null, position: '' };
  return {
    prev: index > 0 ? items[index - 1] : null,
    next: index < items.length - 1 ? items[index + 1] : null,
    position: `${index + 1} of ${items.length}`,
  };
}

/**
 * Whether the Outputs card should flip open on this render — the "payoff"
 * moment: a run just finished (`wasRunning` true, `isRunning` now false) and
 * left something behind. Must be false on every other render, including:
 *   - every render while still running (no transition yet)
 *   - every render once idle and already settled (no transition this tick)
 *   - a run finishing with nothing to show (nothing to pay off)
 * so the card only auto-opens exactly once, at the transition, never on
 * every subsequent re-render of an already-finished run.
 */
export function shouldAutoExpandOutputs(
  wasRunning: boolean,
  isRunning: boolean,
  outputCount: number,
): boolean {
  return wasRunning && !isRunning && outputCount > 0;
}

/**
 * Whether the run should read as "still going", combining two signals:
 *
 * - `stepsRunning` — derived from the tool parts themselves
 *   (`steps.some(s => s.status === 'running')`). This alone flickers: between
 *   one tool call completing and the next being emitted, the model streams
 *   assistant text and no part is running/pending, so this goes false for a
 *   beat on every tool boundary of an otherwise-uninterrupted run.
 * - `sessionBusy` — the session's own status (the same signal the chat
 *   transcript already uses to show its working indicator), which stays busy
 *   for the whole turn regardless of gaps between tool calls.
 *
 * ORing them closes the gap: the run reads as running for its entire actual
 * duration, so `shouldAutoExpandOutputs` only fires at the real finish (not
 * at the first inter-tool pause), and the Progress card's shimmer/subtitle
 * stop flickering at every tool boundary.
 */
export function deriveIsRunning(stepsRunning: boolean, sessionBusy: boolean): boolean {
  return stepsRunning || sessionBusy;
}

/**
 * Whether the panel should present the primary deliverable on this render —
 * the payoff screen (W2). Same transition discipline as
 * `shouldAutoExpandOutputs`, with four extra refusals: a failed or stopped
 * run presents its outcome, not a payoff; an open detail is never replaced;
 * a user who opened any detail during the run has shown they're driving —
 * auto-opening would fight them; and the panel must actually be open — desktop
 * keeps `EasyPanel` mounted behind a closed panel, so without this refusal the
 * payoff would silently open a detail the user can't see. The closed-panel
 * case belongs to the ready chip (W1), not the payoff.
 */
export function shouldAutoOpenPayoff(args: {
  wasRunning: boolean;
  isRunning: boolean;
  outcome: RunOutcome;
  hasPrimary: boolean;
  detailOpen: boolean;
  interactedThisRun: boolean;
  panelOpen: boolean;
}): boolean {
  return (
    args.wasRunning &&
    !args.isRunning &&
    args.outcome === 'succeeded' &&
    args.hasPrimary &&
    !args.detailOpen &&
    !args.interactedThisRun &&
    args.panelOpen
  );
}

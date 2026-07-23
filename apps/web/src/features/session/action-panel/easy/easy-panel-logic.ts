/**
 * Pure logic for `EasyPanel`, split out from the client component purely so
 * it is unit-testable without a DOM (same reasoning as `progress-summary.ts`).
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
 * The synthetic app `OutputItem` behind the header/palette "Open Browser"
 * quick-view — the first running app's url when the session has one, else an
 * EMPTY url: `AppPreview` renders its "no app yet" landing (helper copy +
 * focused address bar) for that, teaching ports without iframing a guessed,
 * usually-dead `localhost:3000`. `callID: 'quick-browser'` never collides
 * with a real tool call's.
 */
export function quickBrowserOutput(apps: OutputItem[]): OutputItem {
  return {
    callID: 'quick-browser',
    name: 'Browser',
    kind: 'app',
    url: apps[0]?.url ?? '',
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

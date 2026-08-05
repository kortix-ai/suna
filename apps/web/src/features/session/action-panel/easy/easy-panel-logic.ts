/**
 * Pure logic for `EasyPanel`, split out from the client component purely so
 * it is unit-testable without a DOM.
 */

import { parseLocalhostUrl } from '@/lib/utils/sandbox-url';
import type { BrowserRecent } from '@/stores/browser-recents-store';
import type { PreviewPortProbe } from '@kortix/sdk';
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
 * Whether `AppPreview`'s port watch should be armed — the fix for the false
 * positive where a healthy app got declared dead. The iframe has no `src` (and
 * therefore no way to ever fire `onLoad`/`onError`) until the auth-token fetch
 * resolves; arming the clock before then just counts down the fetch itself, so
 * a slow token (not a slow app) trips the error. Requiring `hasPreview` —
 * `previewUrl` gone non-null — means the watch starts only once the iframe
 * actually has something to load.
 */
export function shouldArmLoadTimeout(input: {
  isLoading: boolean;
  noApp: boolean;
  hasPreview: boolean;
}): boolean {
  return input.isLoading && !input.noApp && input.hasPreview;
}

/**
 * `AppPreview`'s load/error state after an iframe `onLoad` fires — the fix
 * for a late success leaving the "Couldn't load" card over a working app.
 *
 * The `shouldArmLoadTimeout` deadline reaches its "couldn't load" verdict on
 * SILENCE: no `onLoad`/`onError` within 5s. That verdict is a guess, not
 * proof, and the error card it sets is `absolute inset-0 z-10` — sitting on
 * top of the iframe. An `onLoad` that fires after the guess was made is
 * positive evidence the guess was wrong, so it must retract `hasError` too,
 * not just clear the spinner — otherwise the card keeps covering a loaded,
 * working app until a manual Retry. `onError` is untouched by this: a real
 * error event is its own positive evidence of failure, so it still sets
 * `hasError` on its own.
 */
export function previewLoadSuccessState(): { isLoading: boolean; hasError: boolean } {
  return { isLoading: false, hasError: false };
}

/**
 * What the runtime poll currently knows about the session's sandbox — three
 * values, because "not alive" and "dead" are different states and only one of
 * them is evidence.
 *
 * `useRuntimeConnectionStore` starts every session at
 * `status: 'connecting', healthy: null`, so a boolean "alive" is FALSE for the
 * entire boot. `AppPreview` already computes that boolean and uses it to pick
 * the error wording; using the same boolean to decide whether an error
 * happened would fail every preview at mount.
 *
 * `unreachable` is the only value that means dead, and it is not a single
 * missed probe: `useRuntimeReconnect` only writes it after its own failure
 * threshold (`FAIL_THRESHOLD_RECONNECT` / `FAIL_THRESHOLD_FIRST`), or on an
 * HTTP status that says outright that nothing is home. By the time the store
 * says `unreachable`, the sandbox has already been probed and re-probed.
 *
 * `initialCheckDone` gates `dead` for a reason that is easy to miss: the store
 * is a process-wide singleton with no per-session key, so opening a preview
 * carries whatever verdict the PREVIOUSLY viewed session left behind until the
 * poll's first check lands. Without this gate a stale `unreachable` flashes the
 * error card at mount on a perfectly healthy sandbox. `alive` needs no such
 * gate: it can only be reached by a check that has already resolved.
 */
export type SandboxHealth = 'alive' | 'dead' | 'unknown';

export function runtimeSandboxHealth(runtime: {
  status: 'connecting' | 'connected' | 'unreachable';
  healthy: boolean | null;
  /** Whether the runtime poll has completed a check for THIS mount. */
  initialCheckDone: boolean;
}): SandboxHealth {
  if (runtime.status === 'unreachable') return runtime.initialCheckDone ? 'dead' : 'unknown';
  if (runtime.status === 'connected' && runtime.healthy === true) return 'alive';
  return 'unknown';
}

/** How often `AppPreview` re-probes the port while it waits, ms.
 *
 *  Sized against the port-BIND race, which is the only thing a faster or slower
 *  cadence changes: the agent starts a dev server and the preview opens before
 *  the process has bound its socket. Two seconds means the continuity window
 *  below rests on five samples rather than one, and the loop that spends them
 *  is short-lived — see {@link shouldKeepProbingPort}. */
export const PREVIEW_PROBE_INTERVAL_MS = 2_000;

/** How long the port must be CONTINUOUSLY unreachable before that counts as a
 *  failure, ms.
 *
 *  A single 502 is the proxy saying "nothing answered right now", which is the
 *  normal state of a port for the first moments after the agent starts a
 *  server. Ten seconds is five consecutive misses at
 *  {@link PREVIEW_PROBE_INTERVAL_MS} — the same count `useRuntimeReconnect`
 *  requires (`FAIL_THRESHOLD_FIRST = 5`) before it will call a never-yet-seen
 *  endpoint unreachable, so the product has one answer to "how many misses
 *  mean it is really not there". Any answering probe resets it. */
export const PREVIEW_UNREACHABLE_WINDOW_MS = 10_000;

/** The hard ceiling on waiting, ms — reached only when NO probe ever produced
 *  a verdict (blocked by CORS, an expired preview cookie, an offline browser)
 *  and the frame never fired `onLoad`.
 *
 *  It has to clear the slowest legitimate cold start or it re-creates the exact
 *  bug this replaced, just at a bigger number: `CLAUDE.md` records 30-60s for a
 *  first hit on a cold Next.js route. 90s is that documented worst case plus a
 *  50% margin. It is a last resort, not the normal path — with a working probe
 *  a dead port resolves in ~{@link PREVIEW_UNREACHABLE_WINDOW_MS}. */
export const PREVIEW_MAX_WAIT_MS = 90_000;

/** One probe's verdict about the port. Aliased from the SDK's own type rather
 *  than restated, so the two can never drift apart. */
export type PreviewProbe = PreviewPortProbe;

/**
 * Whether `AppPreview` should keep waiting or show "Couldn't load".
 *
 * The bug this replaces: the verdict came from a stopwatch. Five seconds of
 * iframe silence WAS the failure, and iframe silence is not evidence of
 * anything — a cold dev-server compile is routinely 30-60s (`CLAUDE.md`), so
 * healthy apps were being declared dead mid-build. `sandboxAlive` was computed
 * right next to it and used only to pick the error's wording, never to decide
 * whether there was an error at all.
 *
 * Now the verdict needs evidence, in this order:
 *
 * 1. **The sandbox is known dead.** The runtime poll has already probed,
 *    re-probed and given up. Nothing behind this port can be reachable, and
 *    `AppPreview`'s copy has the stopped-workspace wording for exactly this.
 * 2. **The port has been continuously unreachable for the whole window.** The
 *    proxy answers `502/503/504` itself when it cannot open a connection, so
 *    this is the port saying nothing is listening — repeatedly, over
 *    {@link PREVIEW_UNREACHABLE_WINDOW_MS}, with any single answer resetting it.
 * 3. **The bound.** Everything else keeps waiting until
 *    {@link PREVIEW_MAX_WAIT_MS}, then fails anyway. "Wait forever when unsure"
 *    would trade a false error for a permanent spinner, and a permanent spinner
 *    has no Retry and no "Send to agent".
 *
 * Anything short of that waits. `unknown` — a CORS refusal, an expired preview
 * cookie, a probe that outran its own timeout — is explicitly not evidence and
 * can never, on its own, fail a preview. That is `browser-panel.tsx`'s
 * precedent: when readiness is unknown it keeps waiting rather than asserting
 * a failure it cannot support.
 */
export function previewLoadVerdict(input: {
  /** What the runtime poll knows about the sandbox — see {@link runtimeSandboxHealth}. */
  sandbox: SandboxHealth;
  /** The most recent probe's verdict. */
  probe: PreviewProbe;
  /** How long the port has been CONTINUOUSLY unreachable, ms. Zero whenever the
   *  last probe was anything other than `unreachable`. */
  unreachableForMs: number;
  /** How long the iframe has had a `src` without firing `onLoad`/`onError`, ms. */
  waitedMs: number;
}): 'wait' | 'failed' {
  if (input.sandbox === 'dead') return 'failed';
  if (input.probe === 'unreachable' && input.unreachableForMs >= PREVIEW_UNREACHABLE_WINDOW_MS) {
    return 'failed';
  }
  if (input.waitedMs >= PREVIEW_MAX_WAIT_MS) return 'failed';
  return 'wait';
}

/**
 * The one sentence under "Couldn't load <app>".
 *
 * Reads the SAME three-state health {@link previewLoadVerdict} weighs, and for
 * the same reason: `unknown` is not evidence. Two of the three failure paths —
 * the continuously-unreachable streak and the {@link PREVIEW_MAX_WAIT_MS}
 * ceiling — fire while health is perfectly well `unknown` (the runtime store
 * still `connecting`, or `connected` with `healthy === null`). Deciding this
 * copy on `health !== 'alive'` therefore told those users their workspace had
 * stopped when nothing had established that. Only `dead` — a settled
 * `unreachable` verdict from the runtime poll — earns the stopped wording.
 */
export function previewErrorReason(input: { sandbox: SandboxHealth; port: number }): string {
  if (input.sandbox === 'dead') {
    return 'This workspace has stopped, so the app isn’t reachable anymore.';
  }
  if (input.port > 0) return `The app on port ${input.port} may not be running yet.`;
  return 'The app may not be running yet.';
}

/**
 * Whether the watch should probe the port again.
 *
 * Probing is not free: every probe is a real request against the user's own
 * app, and a cold dev server answers a request by COMPILING. Polling one for
 * the whole {@link PREVIEW_MAX_WAIT_MS} would queue dozens of compiles behind
 * the page the user is actually waiting for — this feature would become a
 * cause of the slowness it exists to tolerate.
 *
 * It also buys nothing. The probe's whole job is the fast negative: the proxy
 * answers `502/503/504` itself, without an upstream connection, when nothing is
 * listening. That answer arrives immediately or not at all. So:
 *
 * - a port that ANSWERED has settled the only question a probe can settle;
 * - a MISS must always be probed on from — the streak either reaches
 *   {@link PREVIEW_UNREACHABLE_WINDOW_MS} (a failure verdict) or is broken by
 *   an answer, and neither can happen without another sample. This outranks
 *   the elapsed check, which is why the loop is bounded at roughly twice the
 *   window rather than exactly once;
 * - past the window with nothing missing, the probe has had every chance to
 *   see a dead port and did not. It will not start now. The remaining wait
 *   belongs to the iframe and to {@link PREVIEW_MAX_WAIT_MS}.
 *
 * The miss test is the probe VERDICT, not `unreachableForMs`. Elapsed streak
 * time cannot stand in for it: the caller starts a streak and reads its
 * elapsed time in the same tick, so the sample that BEGINS a streak always
 * carries `unreachableForMs: 0`. Keying on time therefore failed to protect
 * the one sample the rule exists for — a first miss landing at or after the
 * window stopped the loop after a single sample, and the failure verdict it
 * was heading for was never reached. `unreachableForMs` stays in the signature
 * because it is what {@link previewLoadVerdict} weighs; it just is not what
 * decides whether to look again.
 */
export function shouldKeepProbingPort(input: {
  probe: PreviewProbe;
  /** How long the port has been continuously unreachable, ms. */
  unreachableForMs: number;
  /** How long the watch has been probing, ms. */
  watchedMs: number;
}): boolean {
  if (input.probe === 'reachable') return false;
  if (input.probe === 'unreachable') return true;
  return input.watchedMs < PREVIEW_UNREACHABLE_WINDOW_MS;
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
}): boolean {
  return (
    args.wasRunning &&
    !args.isRunning &&
    args.outcome === 'succeeded' &&
    args.hasPrimary &&
    !args.detailOpen &&
    !args.interactedThisRun
  );
}

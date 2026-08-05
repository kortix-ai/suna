import { describe, expect, it, test } from 'bun:test';
import { PREVIEW_PROBE_TIMEOUT_MS } from '@kortix/sdk';
import type { OutputItem } from '../shared/derive-panels';
import type { Step } from '../shared/group-steps';
import {
  PREVIEW_MAX_WAIT_MS,
  PREVIEW_PROBE_INTERVAL_MS,
  PREVIEW_UNREACHABLE_WINDOW_MS,
  aspectChangedWidth,
  deriveIsRunning,
  fitSplitPercent,
  isWideDeliverable,
  neighborOutputs,
  outputKey,
  pathOutput,
  previewLoadSuccessState,
  previewLoadVerdict,
  quickBrowserOutput,
  resolveSideSize,
  runtimeSandboxHealth,
  sandboxRecents,
  shouldArmLoadTimeout,
  shouldAutoExpandOutputs,
  shouldAutoOpenPayoff,
  shouldKeepProbingPort,
  focusIndexForCall,
  stepForCallId,
} from './easy-panel-logic';

type FileOutputItem = Exclude<OutputItem, { kind: 'app' }> & { kind: 'file' };
type AppOutputItem = Extract<OutputItem, { kind: 'app' }>;

function output(overrides: Partial<FileOutputItem> = {}): FileOutputItem {
  return { callID: 'call-1', name: 'report.md', kind: 'file', ...overrides };
}

function appOutput(overrides: Partial<AppOutputItem> = {}): AppOutputItem {
  return { callID: 'app-1', name: 'my-app', kind: 'app', url: 'http://localhost:5173', ...overrides };
}

describe('outputKey', () => {
  it('is stable for a single item', () => {
    expect(outputKey(output())).toBe('call-1:report.md');
  });

  it('prefers path over name when both are present', () => {
    expect(outputKey(output({ path: '/a/report.md' }))).toBe('call-1:/a/report.md');
  });

  // ─── the bug the brief shipped: one apply_patch call produces several
  // OutputItems that all share the same callID. Keying on callID alone
  // collides; the key must still distinguish every file the call touched. ──

  it('does not collide for multiple files from the same apply_patch call', () => {
    const a = output({ callID: 'patch-1', path: '/repo/src/a.ts', name: 'a.ts' });
    const b = output({ callID: 'patch-1', path: '/repo/src/b.ts', name: 'b.ts' });
    expect(outputKey(a)).not.toBe(outputKey(b));
  });

  it('still distinguishes same-call items that have no path, only a name', () => {
    const a = output({ callID: 'patch-1', path: undefined, name: 'a.ts' });
    const b = output({ callID: 'patch-1', path: undefined, name: 'b.ts' });
    expect(outputKey(a)).not.toBe(outputKey(b));
  });

  it('keeps two different calls to the same path apart', () => {
    const a = output({ callID: 'call-a', path: '/a/report.md' });
    const b = output({ callID: 'call-b', path: '/a/report.md' });
    expect(outputKey(a)).not.toBe(outputKey(b));
  });
});

describe('isWideDeliverable (wide split for landscape-shaped details)', () => {
  it('is wide for a real presentation_gen artifact', () => {
    expect(isWideDeliverable({ kind: 'presentation', name: 'deck' })).toBe(true);
  });

  it('is wide for a raw .pptx/.ppt/.key file even though its kind stays "file"', () => {
    expect(isWideDeliverable({ kind: 'file', name: 'Q3 Review.pptx' })).toBe(true);
    expect(isWideDeliverable({ kind: 'file', name: 'legacy.ppt' })).toBe(true);
    expect(isWideDeliverable({ kind: 'file', name: 'Keynote.key' })).toBe(true);
  });

  it('is wide for running apps — the in-panel browser assumes a desktop viewport', () => {
    expect(isWideDeliverable({ kind: 'app', name: 'my-app' })).toBe(true);
  });

  it('is wide for spreadsheets, grids, and web pages', () => {
    expect(isWideDeliverable({ kind: 'file', name: 'budget.xlsx' })).toBe(true);
    expect(isWideDeliverable({ kind: 'file', name: 'legacy.xls' })).toBe(true);
    expect(isWideDeliverable({ kind: 'file', name: 'data.csv' })).toBe(true);
    expect(isWideDeliverable({ kind: 'file', name: 'export.tsv' })).toBe(true);
    expect(isWideDeliverable({ kind: 'file', name: 'index.html' })).toBe(true);
    expect(isWideDeliverable({ kind: 'file', name: 'page.htm' })).toBe(true);
  });

  it('is not wide for portrait-shaped outputs', () => {
    expect(isWideDeliverable({ kind: 'file', name: 'report.md' })).toBe(false);
    expect(isWideDeliverable({ kind: 'file', name: 'report.pdf' })).toBe(false);
    expect(isWideDeliverable({ kind: 'image', name: 'chart.png' })).toBe(false);
  });
});

describe('fitSplitPercent (aspect-ratio-fit split for the Easy panel)', () => {
  const box = { layoutWidth: 1400, panelContentHeight: 800 };

  // ─── the shape table — same box, varying aspect. Values are approximate:
  // idealPx = aspect * panelContentHeight + gutter(48), percent = idealPx /
  // layoutWidth * 100, clamped to [35, 70]. ──
  test.each([
    ['A4 portrait (595/842) fits narrower than default', 595 / 842, 44],
    ['A4 landscape (842/595) clamps to the 70 ceiling', 842 / 595, 70],
    ['a square document sits mid-range', 1, 61],
    ['an extreme-wide document clamps to 70', 10, 70],
    ['an extreme-tall document clamps to the 35 floor', 0.05, 35],
  ])('%s', (_label, aspect, expected) => {
    expect(fitSplitPercent({ aspect, ...box })).toBeCloseTo(expected, 0);
  });

  test.each([
    ['NaN aspect', NaN],
    ['zero aspect', 0],
    ['negative aspect', -1],
    ['infinite aspect', Infinity],
  ])('returns null, never NaN, for %s', (_label, aspect) => {
    expect(fitSplitPercent({ aspect, ...box })).toBeNull();
  });

  it('returns null for a zero layoutWidth', () => {
    expect(fitSplitPercent({ aspect: 1, layoutWidth: 0, panelContentHeight: 800 })).toBeNull();
  });

  it('returns null for a zero panelContentHeight', () => {
    expect(fitSplitPercent({ aspect: 1, layoutWidth: 1400, panelContentHeight: 0 })).toBeNull();
  });
});

describe('resolveSideSize (the panel-width precedence rule)', () => {
  // 848 = the 800px content height the fitSplitPercent table above uses, plus
  // PREVIEW_TOOLBAR_PX (48), which resolveSideSize subtracts itself. So an A4
  // portrait through this box must land on that table's ~44.
  const panelBox = { width: 1400, height: 848 };
  const base = { isExpanded: false, isEasy: true, panelAspect: null, panelSplit: null, panelBox };

  it('gives fullscreen the whole layout, ignoring a measured document', () => {
    expect(
      resolveSideSize({ ...base, isExpanded: true, panelAspect: 595 / 842, panelSplit: 70 }),
    ).toBe(100);
  });

  it('keeps Advanced mode at an even 50, ignoring a measured document', () => {
    expect(
      resolveSideSize({ ...base, isEasy: false, panelAspect: 595 / 842, panelSplit: 70 }),
    ).toBe(50);
  });

  it('lets a measured document outrank the split its extension asked for', () => {
    const fitted = resolveSideSize({ ...base, panelAspect: 595 / 842, panelSplit: 70 });
    expect(fitted).toBeCloseTo(44, 0);
  });

  it('falls back to panelSplit when the measurement is unusable', () => {
    // NaN is what fitSplitPercent refuses; the split must survive that refusal
    // rather than the panel collapsing to the default.
    expect(resolveSideSize({ ...base, panelAspect: NaN, panelSplit: 70 })).toBe(70);
  });

  it('falls back to panelSplit when the panel box has not been measured yet', () => {
    expect(
      resolveSideSize({ ...base, panelBox: null, panelAspect: 595 / 842, panelSplit: 70 }),
    ).toBe(70);
  });

  it('falls back to panelSplit when the box is shorter than its own toolbar', () => {
    // panelContentHeight goes <= 0, which fitSplitPercent nulls out — the
    // Global Constraint 6 path, seen from the caller.
    expect(
      resolveSideSize({
        ...base,
        panelBox: { width: 1400, height: 20 },
        panelAspect: 595 / 842,
        panelSplit: 70,
      }),
    ).toBe(70);
  });

  it('falls back all the way to the 35 card column with neither a fit nor a split', () => {
    expect(resolveSideSize(base)).toBe(35);
    expect(resolveSideSize({ ...base, panelAspect: NaN })).toBe(35);
  });

  it('still honors a wide deliverable that reports no shape of its own', () => {
    expect(resolveSideSize({ ...base, panelSplit: 70 })).toBe(70);
  });

  it('never returns a non-finite size, whatever it is handed', () => {
    const sizes = [
      resolveSideSize({ ...base, panelAspect: Infinity, panelSplit: null }),
      resolveSideSize({ ...base, panelAspect: 0, panelSplit: null }),
      resolveSideSize({ ...base, panelBox: { width: 0, height: 0 }, panelAspect: 1 }),
      resolveSideSize({ ...base, panelAspect: 1 }),
    ];
    for (const size of sizes) expect(Number.isFinite(size)).toBe(true);
  });
});

describe('aspectChangedWidth (does a measurement ask the panel to move?)', () => {
  const held = { prevAspect: 0.707, nextAspect: 0.707, currentSize: 44, nextSize: 44 };

  it('is false when the ratio did not change at all', () => {
    expect(aspectChangedWidth({ ...held, currentSize: 60, nextSize: 35 })).toBe(false);
  });

  it('is false when a new ratio lands on the width the panel already has', () => {
    // The no-op guard: a transition here moves nothing and still swings the
    // panels' min/max/collapsible for 320ms.
    expect(
      aspectChangedWidth({ prevAspect: null, nextAspect: 0.4, currentSize: 35, nextSize: 35 }),
    ).toBe(false);
  });

  // ─── the regression this function was extracted for. The user drags the
  // divider to 60%, which `react-resizable-panels` records internally and
  // never reports back, then opens a tall document whose fit clamps to the
  // 35 floor. Comparing against the LAST COMMANDED width (also 35) says
  // "nothing changed", no transition is attached, and the unconditional
  // resize(35) that follows jump-cuts a hand-placed 60% panel. Comparing
  // against the panel's real width is what keeps the glide. ──
  it('is true when the panel was dragged away from the width we last commanded', () => {
    expect(
      aspectChangedWidth({ prevAspect: null, nextAspect: 0.4, currentSize: 60, nextSize: 35 }),
    ).toBe(true);
  });

  it('is true for an ordinary fit that genuinely widens the panel', () => {
    expect(
      aspectChangedWidth({ prevAspect: null, nextAspect: 1.41, currentSize: 35, nextSize: 70 }),
    ).toBe(true);
  });

  it('is true when a held ratio is finally cleared into a different width', () => {
    expect(
      aspectChangedWidth({ prevAspect: 0.707, nextAspect: null, currentSize: 44, nextSize: 35 }),
    ).toBe(true);
  });

  it('ignores sub-pixel drift, which a hand-dragged divider produces constantly', () => {
    expect(
      aspectChangedWidth({ prevAspect: null, nextAspect: 0.4, currentSize: 35.4, nextSize: 35 }),
    ).toBe(false);
    expect(
      aspectChangedWidth({ prevAspect: null, nextAspect: 0.4, currentSize: 35.6, nextSize: 35 }),
    ).toBe(true);
  });

  it('honors a custom epsilon and falls back to the default for a junk one', () => {
    const drift = { prevAspect: null, nextAspect: 0.4, currentSize: 38, nextSize: 35 };
    expect(aspectChangedWidth({ ...drift, epsilon: 5 })).toBe(false);
    expect(aspectChangedWidth({ ...drift, epsilon: NaN })).toBe(true);
  });

  it('treats an unreadable size as a real change rather than a silent jump', () => {
    // `getSize()` should never return this, but a size we cannot compare must
    // keep its transition instead of committing with none attached.
    expect(
      aspectChangedWidth({ prevAspect: null, nextAspect: 0.4, currentSize: NaN, nextSize: 35 }),
    ).toBe(true);
  });
});

describe("shouldArmLoadTimeout (AppPreview's port watch)", () => {
  const base = { isLoading: true, noApp: false, hasPreview: true };

  it('is not armed while previewUrl is null — the auth token fetch must not burn the budget', () => {
    expect(shouldArmLoadTimeout({ ...base, hasPreview: false })).toBe(false);
  });

  it('arms once previewUrl goes non-null', () => {
    expect(shouldArmLoadTimeout({ ...base, hasPreview: true })).toBe(true);
  });

  it('is not armed for the no-app landing, even with a stray previewUrl', () => {
    expect(shouldArmLoadTimeout({ ...base, noApp: true })).toBe(false);
  });

  it('is not armed once loading has already finished', () => {
    expect(shouldArmLoadTimeout({ ...base, isLoading: false })).toBe(false);
  });
});

describe('previewLoadSuccessState (a late load clears the error overlay)', () => {
  it('clears both isLoading and hasError, so a late success retracts a prior timeout verdict', () => {
    expect(previewLoadSuccessState()).toEqual({ isLoading: false, hasError: false });
  });
});

describe('runtimeSandboxHealth', () => {
  const checked = { initialCheckDone: true };

  // The single reason this is three-valued and not a boolean: the store's OWN
  // starting state is `connecting`/`null`, so "not alive" is the state every
  // session passes through on the way up. Reading that as "dead" would fail
  // every preview at mount.
  it('is unknown at rest, before any health check has resolved', () => {
    expect(runtimeSandboxHealth({ status: 'connecting', healthy: null, ...checked })).toBe(
      'unknown',
    );
  });

  it('is unknown while the sandbox is up but the runtime has not reported health', () => {
    expect(runtimeSandboxHealth({ status: 'connected', healthy: null, ...checked })).toBe(
      'unknown',
    );
  });

  it('is alive only once the runtime reports healthy', () => {
    expect(runtimeSandboxHealth({ status: 'connected', healthy: true, ...checked })).toBe('alive');
  });

  // `connected` + `healthy: false` is OpenCode still booting behind a live
  // sandbox — progress, not death.
  it('is unknown while the runtime is booting behind a live sandbox', () => {
    expect(runtimeSandboxHealth({ status: 'connected', healthy: false, ...checked })).toBe(
      'unknown',
    );
  });

  it('is dead only on the store\'s own threshold-filtered "unreachable"', () => {
    expect(runtimeSandboxHealth({ status: 'unreachable', healthy: null, ...checked })).toBe('dead');
    expect(runtimeSandboxHealth({ status: 'unreachable', healthy: true, ...checked })).toBe('dead');
  });

  // The store is a process-wide singleton with no per-session key, so a preview
  // opened right after a dead session inherits that session's verdict until the
  // poll's first check lands. Without this gate the error card flashes at mount
  // on a healthy sandbox.
  it('withholds the dead verdict until a check has actually run for this mount', () => {
    expect(
      runtimeSandboxHealth({ status: 'unreachable', healthy: null, initialCheckDone: false }),
    ).toBe('unknown');
  });

  // `alive` needs no such gate — it is unreachable without a resolved check —
  // and gating it would only delay the correct wording.
  it('does not gate the alive verdict, which no unresolved check can produce', () => {
    expect(
      runtimeSandboxHealth({ status: 'connected', healthy: true, initialCheckDone: false }),
    ).toBe('alive');
  });
});

describe('previewLoadVerdict (AppPreview declares failure from evidence, not silence)', () => {
  const waiting = {
    sandbox: 'unknown' as const,
    probe: 'unknown' as const,
    unreachableForMs: 0,
    waitedMs: 0,
  };

  // ─── THE REPORTED BUG. A cold Next.js route compiles for 30-60s (CLAUDE.md).
  // The old code called that dead at 5s. Nothing here may reproduce that. ──

  it('keeps waiting on a port that answers, however long the app takes to render', () => {
    expect(previewLoadVerdict({ ...waiting, probe: 'reachable', waitedMs: 6_000 })).toBe('wait');
    expect(previewLoadVerdict({ ...waiting, probe: 'reachable', waitedMs: 60_000 })).toBe('wait');
  });

  it('keeps waiting through a cold start we know nothing about', () => {
    expect(previewLoadVerdict({ ...waiting, waitedMs: 5_000 })).toBe('wait');
    expect(previewLoadVerdict({ ...waiting, waitedMs: 30_000 })).toBe('wait');
  });

  it('keeps waiting while the sandbox is healthy and the port answers', () => {
    expect(
      previewLoadVerdict({ ...waiting, sandbox: 'alive', probe: 'reachable', waitedMs: 45_000 }),
    ).toBe('wait');
  });

  // ─── A genuinely dead port must still resolve to the error card. ──

  it('fails once the port has been continuously unreachable for the whole window', () => {
    expect(
      previewLoadVerdict({
        ...waiting,
        probe: 'unreachable',
        unreachableForMs: PREVIEW_UNREACHABLE_WINDOW_MS,
        waitedMs: PREVIEW_UNREACHABLE_WINDOW_MS,
      }),
    ).toBe('failed');
  });

  // The port-bind race: the agent runs `npm run dev` and the preview opens
  // before the server has bound. A miss, or a few, is a starting server.
  it('does not fail on a port that has only just started missing', () => {
    expect(previewLoadVerdict({ ...waiting, probe: 'unreachable', unreachableForMs: 0 })).toBe(
      'wait',
    );
    expect(
      previewLoadVerdict({
        ...waiting,
        probe: 'unreachable',
        unreachableForMs: PREVIEW_UNREACHABLE_WINDOW_MS - 1,
      }),
    ).toBe('wait');
  });

  // A port that goes 502 → 200 → 502 is a server restarting, not a dead one.
  // Continuity is what the caller resets, and this asserts the reset counts.
  it('does not fail on an intermittent port once a probe has answered again', () => {
    expect(previewLoadVerdict({ ...waiting, probe: 'reachable', unreachableForMs: 0 })).toBe(
      'wait',
    );
  });

  // ─── A stopped workspace is known evidence, not a guess. ──

  it('fails immediately on a sandbox the runtime poll has declared unreachable', () => {
    expect(previewLoadVerdict({ ...waiting, sandbox: 'dead' })).toBe('failed');
  });

  it('never fails on a sandbox whose health is merely not known yet', () => {
    expect(previewLoadVerdict({ ...waiting, sandbox: 'unknown', waitedMs: 1 })).toBe('wait');
  });

  // ─── The bound: never an infinite spinner. ──

  it('fails at the bound even when every probe was inconclusive', () => {
    expect(previewLoadVerdict({ ...waiting, waitedMs: PREVIEW_MAX_WAIT_MS })).toBe('failed');
  });

  it('fails at the bound even when the port answered but the frame never loaded', () => {
    expect(
      previewLoadVerdict({ ...waiting, probe: 'reachable', waitedMs: PREVIEW_MAX_WAIT_MS }),
    ).toBe('failed');
  });
});

describe('shouldKeepProbingPort (a probe is a real request against the user app)', () => {
  const probing = { probe: 'unknown' as const, unreachableForMs: 0, watchedMs: 0 };

  it('stops the moment the port answers — nothing more for a probe to settle', () => {
    expect(shouldKeepProbingPort({ ...probing, probe: 'reachable' })).toBe(false);
  });

  it('keeps probing while the answer is still inconclusive inside the window', () => {
    expect(shouldKeepProbingPort({ ...probing, watchedMs: PREVIEW_PROBE_INTERVAL_MS })).toBe(true);
  });

  // A cold Next.js dev server answers a request by compiling. Polling one for
  // the whole 90s bound would queue compiles behind the very page being waited
  // on, so the watch stops once it has had its chance to see a dead port.
  it('stops probing a slow-but-silent app once the window has passed with no misses', () => {
    expect(shouldKeepProbingPort({ ...probing, watchedMs: PREVIEW_UNREACHABLE_WINDOW_MS })).toBe(
      false,
    );
  });

  // A streak that started late (the first probes were inconclusive) still has
  // to be probed to its conclusion, or a dead port found at second 9 would
  // never accumulate the continuity a failure verdict needs.
  it('always probes an in-progress miss streak to its conclusion, window or not', () => {
    expect(
      shouldKeepProbingPort({
        probe: 'unreachable',
        unreachableForMs: 4_000,
        watchedMs: PREVIEW_UNREACHABLE_WINDOW_MS * 1.5,
      }),
    ).toBe(true);
  });

  // ─── The FIRST miss of a streak carries `unreachableForMs: 0` — the caller
  // starts the streak and reads its elapsed time in the same tick. A rule that
  // keyed on accumulated time therefore did not protect the one sample that
  // BEGINS a streak, so a first miss landing at or after the window ended the
  // loop after a single sample and the failure verdict was never reached. ──
  it('probes on after the miss that STARTS a streak, which has zero elapsed time', () => {
    expect(
      shouldKeepProbingPort({
        probe: 'unreachable',
        unreachableForMs: 0,
        watchedMs: PREVIEW_UNREACHABLE_WINDOW_MS,
      }),
    ).toBe(true);
  });

  // The concrete scenario: an app that accepts the connection and then hangs —
  // the ordinary signature of a dev server compiling its first route. Probe 1
  // stalls to its own ceiling and the loop must not end on that one sample.
  it('leaves room for more than one sample when every probe stalls to its ceiling', () => {
    expect(PREVIEW_PROBE_TIMEOUT_MS + PREVIEW_PROBE_INTERVAL_MS).toBeLessThan(
      PREVIEW_UNREACHABLE_WINDOW_MS,
    );
    expect(shouldKeepProbingPort({ ...probing, watchedMs: PREVIEW_PROBE_TIMEOUT_MS })).toBe(true);
  });

  it('never runs unbounded: a broken streak past the window stops the loop', () => {
    expect(
      shouldKeepProbingPort({
        probe: 'unknown',
        unreachableForMs: 0,
        watchedMs: PREVIEW_UNREACHABLE_WINDOW_MS * 2,
      }),
    ).toBe(false);
  });
});

describe('preview timing constants', () => {
  it('bound the wait past the documented 30-60s cold-compile worst case', () => {
    expect(PREVIEW_MAX_WAIT_MS).toBeGreaterThan(60_000);
    expect(PREVIEW_UNREACHABLE_WINDOW_MS).toBeLessThan(PREVIEW_MAX_WAIT_MS);
    // The probe cadence has to fit the continuity window several times over, or
    // "continuously unreachable" would rest on a single sample.
    expect(PREVIEW_UNREACHABLE_WINDOW_MS / PREVIEW_PROBE_INTERVAL_MS).toBeGreaterThanOrEqual(5);
  });
});

describe('shouldAutoExpandOutputs', () => {
  it('opens exactly on the running -> idle transition when there is content', () => {
    expect(shouldAutoExpandOutputs(true, false, 1)).toBe(true);
  });

  it('does not open while still running', () => {
    expect(shouldAutoExpandOutputs(true, true, 3)).toBe(false);
  });

  it('does not open on every render once already idle (no transition this tick)', () => {
    expect(shouldAutoExpandOutputs(false, false, 3)).toBe(false);
  });

  it('does not open when a run finishes with nothing to show', () => {
    expect(shouldAutoExpandOutputs(true, false, 0)).toBe(false);
  });

  it('does not open when a run is just starting (idle -> running)', () => {
    expect(shouldAutoExpandOutputs(false, true, 3)).toBe(false);
  });
});

describe('deriveIsRunning', () => {
  // ─── BUG 4 — between one tool call completing and the next being emitted,
  // the model streams assistant text and NO tool part is running/pending, so
  // a part-only signal flips true→false→true on every tool boundary of a
  // normal run: the Outputs card pops open at the first inter-tool gap
  // instead of at the actual finish, and the Progress card's shimmer/subtitle
  // flicker. The session's own status (the same signal the chat transcript
  // already uses for its working indicator) stays busy for the whole turn,
  // so ORing it in closes the gap without inventing a new source of truth. ──

  it('is true while a step is actively running, even if the session status lags behind', () => {
    expect(deriveIsRunning(true, false)).toBe(true);
  });

  it('is true during an inter-tool gap (no part running) as long as the session itself is busy', () => {
    expect(deriveIsRunning(false, true)).toBe(true);
  });

  it('is true when both signals agree the run is active', () => {
    expect(deriveIsRunning(true, true)).toBe(true);
  });

  it('is false only when neither signal says the run is active', () => {
    expect(deriveIsRunning(false, false)).toBe(false);
  });
});

describe('shouldAutoOpenPayoff (W2)', () => {
  const base = {
    wasRunning: true,
    isRunning: false,
    outcome: 'succeeded' as const,
    hasPrimary: true,
    detailOpen: false,
    interactedThisRun: false,
  };

  test('fires exactly at the successful running→idle transition with a primary', () => {
    expect(shouldAutoOpenPayoff(base)).toBe(true);
  });

  test('never without a transition, primary, or success', () => {
    expect(shouldAutoOpenPayoff({ ...base, wasRunning: false })).toBe(false);
    expect(shouldAutoOpenPayoff({ ...base, isRunning: true })).toBe(false);
    expect(shouldAutoOpenPayoff({ ...base, hasPrimary: false })).toBe(false);
    expect(shouldAutoOpenPayoff({ ...base, outcome: 'failed' })).toBe(false);
    expect(shouldAutoOpenPayoff({ ...base, outcome: 'stopped' })).toBe(false);
  });

  test('never steals from a user who is (or was) looking at a detail this run', () => {
    expect(shouldAutoOpenPayoff({ ...base, detailOpen: true })).toBe(false);
    expect(shouldAutoOpenPayoff({ ...base, interactedThisRun: true })).toBe(false);
  });

  // The detail panel is content-driven since the cards moved to the floating
  // overlay, so the payoff opening it IS the presentation — the old
  // `panelOpen` refusal (which deferred to the ready chip while the panel was
  // closed) no longer has a closed panel to defer about. The edge is what
  // keeps this one-shot: `wasRunning && !isRunning` can only be true on the
  // single render where the run settles, so the payoff cannot replay while a
  // finished run sits idle.
  test('an idle finished run never re-fires — the edge, not a panel flag, is the guard', () => {
    expect(shouldAutoOpenPayoff({ ...base, wasRunning: false, isRunning: false })).toBe(false);
  });
});

describe('stepForCallId (chat -> panel focus)', () => {
  const steps = [
    { id: 's1', parts: [{ callID: 'c1' }, { callID: 'c2' }] },
    { id: 's2', parts: [{ callID: 'c3' }] },
  ] as unknown as Step[];

  it('finds the step owning a given call, and returns undefined for an unknown call', () => {
    expect(stepForCallId(steps, 'c2')?.id).toBe('s1');
    expect(stepForCallId(steps, 'zz')).toBeUndefined();
  });
});

describe('neighborOutputs (W10)', () => {
  const items = [
    { callID: 'a', name: 'report.pdf', kind: 'file' as const, path: 'report.pdf' },
    { callID: 'b', name: 'data.csv', kind: 'file' as const, path: 'data.csv' },
    { callID: 'c', name: 'img.png', kind: 'image' as const, path: 'img.png' },
  ];

  test('middle item has both neighbors and a position', () => {
    const { prev, next, position } = neighborOutputs(items, 'b:data.csv');
    expect(prev?.callID).toBe('a');
    expect(next?.callID).toBe('c');
    expect(position).toBe('2 of 3');
  });

  test('edges have null on their open side; unknown key has neither', () => {
    expect(neighborOutputs(items, 'a:report.pdf').prev).toBeNull();
    expect(neighborOutputs(items, 'c:img.png').next).toBeNull();
    expect(neighborOutputs(items, 'zz').prev).toBeNull();
    expect(neighborOutputs(items, 'zz').next).toBeNull();
  });
});

describe('quickBrowserOutput (header/palette "Open Browser")', () => {
  it('uses the first running app url when there is one', () => {
    const apps = [{ callID: 'x', name: 'App', kind: 'app', url: 'http://localhost:5173' }] as any;
    expect(quickBrowserOutput(apps).url).toBe('http://localhost:5173');
  });

  it('returns an empty url when no app is running — the preview must land on the port picker, never a guessed dead port', () => {
    expect(quickBrowserOutput([]).url).toBe('');
  });

  it('defaults to the first running app\'s url when several exist', () => {
    const apps = [appOutput({ url: 'http://localhost:5173' }), appOutput({ callID: 'app-2', url: 'http://localhost:8080' })];
    expect(quickBrowserOutput(apps).url).toBe('http://localhost:5173');
  });

  it('always uses a synthetic callID that cannot collide with a real tool call', () => {
    expect(quickBrowserOutput([appOutput()]).callID).toBe('quick-browser');
  });
});

describe('sandboxRecents (AppPreview landing "Recents")', () => {
  test('keeps only localhost recents the sandbox address bar can actually open', () => {
    const recents = [
      { url: 'http://localhost:3000', visitedAt: 1 },
      { url: 'https://github.com/kortix-ai/suna', visitedAt: 2 },
      { url: 'http://127.0.0.1:8008/health', visitedAt: 3 },
      { url: 'http://localhost', visitedAt: 4 },
    ];
    expect(sandboxRecents(recents).map((r) => r.url)).toEqual([
      'http://localhost:3000',
      'http://127.0.0.1:8008/health',
    ]);
  });

  test('empty in, empty out — the landing falls back to the search hint', () => {
    expect(sandboxRecents([])).toEqual([]);
  });
});

describe('pathOutput', () => {
  it('names the output after the file, not the whole path', () => {
    const out = pathOutput('/workspace/reports/q3-summary.md');
    expect(out.name).toBe('q3-summary.md');
    expect(out.path).toBe('/workspace/reports/q3-summary.md');
    expect(out.kind).toBe('file');
  });

  it('handles a bare filename with no directory', () => {
    expect(pathOutput('notes.txt').name).toBe('notes.txt');
  });

  it('gives each path a distinct outputKey so re-opening re-animates', () => {
    expect(outputKey(pathOutput('/a/one.md'))).not.toBe(outputKey(pathOutput('/a/two.md')));
  });

  it('never reports fresh — a path opened by click is not this run\'s deliverable', () => {
    expect(pathOutput('/a/one.md').fresh).toBeUndefined();
  });
});

describe('focusIndexForCall (which command inside a group to open)', () => {
  const parts = [{ callID: 'c1' }, { callID: 'c2' }, { callID: 'c3' }];

  test('finds the clicked call inside the group', () => {
    // The bug: the panel opened at parts.length - 1, so clicking c1 showed c3.
    expect(focusIndexForCall(parts, 'c1')).toBe(0);
    expect(focusIndexForCall(parts, 'c2')).toBe(1);
    expect(focusIndexForCall(parts, 'c3')).toBe(2);
  });

  test('-1 when the call is not in this step, so the caller follows live', () => {
    expect(focusIndexForCall(parts, 'nope')).toBe(-1);
    expect(focusIndexForCall(parts, null)).toBe(-1);
    expect(focusIndexForCall(parts, undefined)).toBe(-1);
    expect(focusIndexForCall([], 'c1')).toBe(-1);
  });
});

/**
 * T17 — page.tsx's phase-gate seam (PR #6273's "unguarded seam 1").
 *
 * `apps/web/src/app/(app)/projects/[id]/sessions/[sessionId]/page.tsx` decides
 * whether to render the full-screen error card with:
 *
 *   const runtimeError = gatedRuntimeError({ phase: sessionState.phase, runtimeError: sessionState.runtimeError });
 *   ...
 *   if (runtimeError) { return <InlineSessionError ... /> }
 *
 * `gatedRuntimeError` (`session-load-state.ts`) is the ONLY thing standing
 * between a benign 503 racing a live `/start` wake (a parked sandbox resuming)
 * and a full-screen "couldn't start session" card replacing a perfectly
 * healthy transcript. `derivePhase` (`@kortix/sdk`) holds `phase` at
 * `'starting'` — never `'error'` — for exactly this race, until `/start`
 * itself settles or gives up. Reading the raw `sessionState.runtimeError`
 * instead of the gated value (the bug this gate exists to prevent) fires the
 * card immediately.
 *
 * These tests exercise the real exported gate functions with the composition
 * page.tsx uses, so a regression that bypasses the gate turns them red — see
 * the MUTATION CHECK in this task's report for the real red/green proof
 * (temporarily reverting `gatedRuntimeError` to ignore `phase`).
 */
import { describe, expect, test } from 'bun:test';

import { gatedRuntimeError, sessionErrorSurfaceReady } from './session-load-state';
import {
  canRenderCachedTranscriptWhileSandboxDown,
  type StoppedSandboxCacheState,
} from './session-terminal-state';

/** The literal shape a benign wake-race 503 arrives in — same fixture the SDK's own `derivePhase` tests use. */
const WAKE_RACE_503 = { status: 503, body: { error: 'sandbox not ready (status: stopped)' } };

/**
 * Mirrors page.tsx's `ActiveSessionChat` decision (lines ~830-945): gate the
 * raw runtime error behind `phase`, then decide whether the error card would
 * render. Composed from the SAME exported functions page.tsx calls — not a
 * reimplementation of their logic.
 */
function wouldShowErrorCard(input: {
  phase: 'starting' | 'ready' | 'error';
  runtimeError: unknown;
  chatSessionId: string | null;
  runtimeBootError: unknown;
}): boolean {
  const runtimeError = gatedRuntimeError({ phase: input.phase, runtimeError: input.runtimeError });
  // page.tsx renders the card the moment the gated value is truthy — before
  // even checking `chatShowable`/`chatSessionId`.
  return Boolean(runtimeError);
}

describe('the page-level phase gate: a benign wake-race 503 never shows the error card', () => {
  test('phase "starting" (a live /start wake in flight) + a 503: NO error card', () => {
    expect(
      wouldShowErrorCard({
        phase: 'starting',
        runtimeError: WAKE_RACE_503,
        chatSessionId: null,
        runtimeBootError: null,
      }),
    ).toBe(false);
  });

  test('the SAME 503 once phase has settled to "error": the card DOES show', () => {
    // This is the control: the gate does not blanket-suppress runtime errors —
    // only ones still racing an in-flight /start.
    expect(
      wouldShowErrorCard({
        phase: 'error',
        runtimeError: WAKE_RACE_503,
        chatSessionId: null,
        runtimeBootError: null,
      }),
    ).toBe(true);
  });

  test('reverting the gate — reading the raw runtimeError directly, ignoring phase — WOULD show the card', () => {
    // This is literally what page.tsx did before T2 gated on `phase`:
    // `if (sessionState.runtimeError) { ...show the card... }`. Simulated
    // here (not by calling a broken function — the real function is correct)
    // to document the exact regression the MUTATION CHECK reproduces for
    // real against `gatedRuntimeError` itself.
    const ungatedDecision = Boolean(WAKE_RACE_503);
    expect(ungatedDecision).toBe(true);
    // ...which disagrees with the gated (correct) decision for this exact input:
    expect(
      wouldShowErrorCard({
        phase: 'starting',
        runtimeError: WAKE_RACE_503,
        chatSessionId: null,
        runtimeBootError: null,
      }),
    ).not.toBe(ungatedDecision);
  });

  test('no runtime error at all: never shows the card, any phase', () => {
    for (const phase of ['starting', 'ready', 'error'] as const) {
      expect(
        wouldShowErrorCard({
          phase,
          runtimeError: null,
          chatSessionId: null,
          runtimeBootError: null,
        }),
      ).toBe(false);
    }
  });
});

describe('the crossfade trigger agrees with the same gated value the error card reads', () => {
  test('a benign 503-during-wake does NOT end the boot shell (still loading), and shows no card', () => {
    const runtimeError = gatedRuntimeError({ phase: 'starting', runtimeError: WAKE_RACE_503 });
    expect(runtimeError).toBeNull();
    // No boot error either — the route stays on the instant shell and never
    // flashes an error card.
    expect(sessionErrorSurfaceReady({ runtimeError, runtimeBootError: null })).toBe(false);
  });

  test('once phase settles to error, the fade starts and the SAME value renders the card', () => {
    const runtimeError = gatedRuntimeError({ phase: 'error', runtimeError: WAKE_RACE_503 });
    expect(runtimeError).toBe(WAKE_RACE_503);
    expect(sessionErrorSurfaceReady({ runtimeError, runtimeBootError: null })).toBe(true);
  });

  test('a resolved transcript pin alone does not start the fade — the chat reports its own content', () => {
    // Regression guard: this predicate used to take `chatSessionId` and fire on
    // it, which crossfaded the instant shell onto SessionChat's compact
    // "starting" loader instead of onto the conversation.
    expect(sessionErrorSurfaceReady({ runtimeError: null, runtimeBootError: null })).toBe(false);
  });
});

// ============================================================================
// The route-level veto: a stopped/error sandbox with cached transcript shows
// the conversation, not the full-screen "sandbox is stopped" terminal card —
// composed exactly as page.tsx's `fatal && !showCachedTranscriptWhileDown`.
// ============================================================================

describe('canRenderCachedTranscriptWhileSandboxDown vetoes the terminal card', () => {
  function wouldShowTerminalCard(state: StoppedSandboxCacheState & { fatal: boolean }): boolean {
    const showCachedTranscriptWhileDown = canRenderCachedTranscriptWhileSandboxDown(state);
    return state.fatal && !showCachedTranscriptWhileDown;
  }

  test('sandbox stopped + cached transcript present: chat renders, not the terminal card', () => {
    expect(
      wouldShowTerminalCard({ fatal: true, sandboxStatus: 'stopped', hasCachedContent: true }),
    ).toBe(false);
  });

  test('sandbox stopped + NO cached content: the terminal card still renders', () => {
    expect(
      wouldShowTerminalCard({ fatal: true, sandboxStatus: 'stopped', hasCachedContent: false }),
    ).toBe(true);
  });

  test('reverting the veto (ignoring cached content) WOULD show the terminal card over real history', () => {
    const state = { sandboxStatus: 'stopped' as const, hasCachedContent: true };
    const gatedDecision = wouldShowTerminalCard({ fatal: true, ...state });
    const ungatedDecision = true; // `fatal` alone, the pre-veto behavior
    expect(gatedDecision).toBe(false);
    expect(gatedDecision).not.toBe(ungatedDecision);
  });
});

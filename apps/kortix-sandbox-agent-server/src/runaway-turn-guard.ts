import { logger } from './logger'

// ─────────────────────────────────────────────────────────────────────────────
// A turn — in ANY session, root or spawned child — that completes successfully
// (`session.idle`, no error) while answering the SAME parent user message it
// already answered on the PREVIOUS completion is a runaway: something re-triggered generation against a
// STANDING prompt instead of recognizing it as already answered — observed
// live 2026-08-18 (session `749045da`) as OpenCode replying the same one-word
// answer back-to-back, indefinitely, until manually aborted at 44 messages /
// $0.18. The likely trigger was a caller-supplied `messageID` that did not
// conform to OpenCode's own sortable-clock id format, breaking its
// "has this prompt already been answered" ordering check — the SDK's
// `promptOpenCodeMessage` always mints a conforming id, so the real web/CLI
// clients are not expected to hit this.
//
// UPSTREAM NOW BOUNDS THE ORIGINAL TRIGGER — KEEP THE GUARD ANYWAY. 1.18.15
// stopped using id ordering as the chronology signal: turn exit is now
// `lastAssistant.parentID === lastUser.id`, and `latest()` orders by
// `time.created`. A non-conforming caller-supplied `messageID` therefore no
// longer breaks the already-answered check on the pinned 1.18.19. That closes
// the ONE path we diagnosed, not the class: any other way a STANDING prompt
// gets re-triggered still produces a full clean success per repeat — no error,
// no timeout — so `turn-auto-resume.ts` (which watches `session.error`) does
// not apply and nothing else stops it, and it burns real tokens with no
// ceiling. This guard is a single counter and a string compare per completion,
// it cannot false-abort (see MAX_CONSECUTIVE_REPEATS below), and it is the only
// thing that bounded the 2026-08-18 incident. Cheap insurance stays.
// Per opencode SESSION, children included: the 2026-08-18
// Essentia incident (session `5d9e298a`) was a spawned child looping this way
// while `relayTurnEndToApi` filtered non-root sessions out before this guard
// ever saw a repeat — the abort must target the session that is looping.
//
// MAX_CONSECUTIVE_REPEATS=3 mirrors `turn-auto-resume.ts`'s
// MAX_ATTEMPTS_PER_WINDOW: a small number of repeats could in principle be
// legitimate (the SAME parent id read twice across two different observation
// paths, before the dedup layer above this catches up); a 4th identical
// repeat of the SAME standing prompt is not.
// ─────────────────────────────────────────────────────────────────────────────

export const MAX_CONSECUTIVE_REPEATS = 3

export interface RunawayGuardState {
  lastParentMessageId: string | null
  repeatCount: number
}

export function createRunawayGuardState(): RunawayGuardState {
  return { lastParentMessageId: null, repeatCount: 0 }
}

/**
 * Advance the guard with one observed, genuinely-new completed turn's
 * `parentMessageId` (the user message it answered —
 * `RootTurnState.parentMessageId` in main.ts). Call only for a confirmed
 * `idle` (non-error) completion that has already passed the turn-end dedup
 * check above it — a duplicate OBSERVATION of the same already-relayed turn
 * must never advance this, or two vantage points on one real reply would
 * read as a repeat.
 *
 * `null` (no confirmed parent — a read failure, or the newest row is a user
 * message with no reply yet) never counts as a repeat and never resets a
 * genuine streak either: `readRootTurnState` returns `null` on ANY read
 * failure, so a single flaky fetch between two real repeats must not erase
 * the count that already caught them. Pure and clock-free — the trigger is
 * event count, not elapsed time, since each repeat here fired within single-
 * digit seconds of the last (see the incident note above).
 */
export function stepRunawayGuard(
  state: RunawayGuardState,
  parentMessageId: string | null,
): { state: RunawayGuardState; shouldAbort: boolean } {
  if (parentMessageId === null) {
    return { state, shouldAbort: false }
  }
  if (parentMessageId !== state.lastParentMessageId) {
    return { state: { lastParentMessageId: parentMessageId, repeatCount: 1 }, shouldAbort: false }
  }
  const repeatCount = state.repeatCount + 1
  return {
    state: { lastParentMessageId: parentMessageId, repeatCount },
    shouldAbort: repeatCount > MAX_CONSECUTIVE_REPEATS,
  }
}

// One guard state per opencode session id observed by this daemon process —
// mirrors `relayedTurnSignatures`'s per-process Map/Set pattern in main.ts.
// A daemon restart resets it, which is correct: a fresh process has observed
// zero repeats so far, and re-arming from zero can only under-detect for one
// more legitimate-looking repeat, never false-abort a healthy session.
const guardStates = new Map<string, RunawayGuardState>()

/** Test-only: clear per-session guard state between cases. */
export function __resetRunawayGuardStates(): void {
  guardStates.clear()
}

/**
 * Observe one genuinely-new `idle` completion for `opencodeSessionId` and
 * abort the session if it is the same standing prompt repeating past
 * {@link MAX_CONSECUTIVE_REPEATS}. `abort` is injected so the caller controls
 * the actual HTTP call (and its base URL / workspace) — this module owns only
 * the counting decision.
 */
export async function observeIdleForRunaway(
  opencodeSessionId: string,
  parentMessageId: string | null,
  abort: () => Promise<void>,
): Promise<void> {
  const current = guardStates.get(opencodeSessionId) ?? createRunawayGuardState()
  const { state, shouldAbort } = stepRunawayGuard(current, parentMessageId)
  guardStates.set(opencodeSessionId, state)
  if (!shouldAbort) return
  logger.error(
    '[runaway-turn-guard] session answered the same standing prompt repeatedly with no new user message — aborting',
    { opencodeSessionId, parentMessageId, repeatCount: state.repeatCount },
  )
  // Reset immediately so the abort's own turn-end (which itself completes
  // with no NEW user message ahead of it either) is never miscounted as
  // another repeat of the same streak this abort just closed.
  guardStates.set(opencodeSessionId, createRunawayGuardState())
  await abort()
}

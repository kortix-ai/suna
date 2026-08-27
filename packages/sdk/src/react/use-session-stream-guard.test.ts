import { describe, expect, test } from 'bun:test';

/**
 * The status-fill rule, pinned at its NEW home.
 *
 * A state snapshot (the bundle's runtime leg, or a
 * `kortix.control.runtime_state` frame) describes the moment it was CAPTURED
 * and carries no per-frame arrival stamp. Written back unconditionally, a
 * `busy` that was true at capture would overwrite an `idle` frame that
 * arrived while it travelled — the exact defect the old `hydrateCore` guard
 * existed for (Stop and the turn shimmer returning on a finished turn).
 *
 * The WHICH-slots rule (fresh wire owns; stale wire and local do not) is
 * behavior-tested on `applyRuntimeStateLeg` in `session-stream-routing.test.ts`
 * ("a fresh WIRE slot blocks the status fill"), and the pure predicate in
 * `use-opencode-events/helpers.test.ts`. What CANNOT be behavior-tested
 * without a hook harness is the hook's wiring of that rule — which stamp it
 * feeds, and how the write is marked — so those two facts are pinned in the
 * source here.
 */
const SOURCE = await Bun.file(new URL('./use-session-stream.ts', import.meta.url).pathname).text();

describe('useSessionRuntimeStream state-snapshot guard wiring', () => {
  test('the slot handed to the fill rule carries the STORE arrival stamp, never a component clock', () => {
    expect(SOURCE).toContain('stampedAtMs: state.sessionStatusAt[sid]');
    expect(SOURCE).toContain('origin: state.sessionStatusOrigin[sid]');
  });

  test('the snapshot write is marked synthetic, so it lands with local origin', () => {
    // A snapshot is a reading ABOUT the runtime taken at capture time, not
    // the runtime speaking on the wire. Unmarked, its write would mint a
    // wire-origin frame that `projectWorking` lets contradict an open turn.
    expect(SOURCE).toContain('synthetic: true');
  });

  test('a delivered runtime frame is reachability evidence and syncs the transcript registry', () => {
    // The old stream's onEvent side-effects, preserved verbatim: every daemon
    // frame vetoes concurrent health-probe failures and renews transcript
    // freshness before the reducer applies it.
    expect(SOURCE).toContain('noteRuntimeEvidence()');
    expect(SOURCE).toContain('noteSessionSyncEvent(event)');
  });
});

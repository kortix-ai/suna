import { describe, expect, test } from 'bun:test';
import { shouldPaintFatalCard, shouldPaintTerminalCard } from './terminal-card-gate';

describe('shouldPaintTerminalCard', () => {
  // I1: a terminal surface is never rendered for a condition its owner marked
  // recoverable. The server answers {stage:'starting', retriable:true} for a
  // wake cooldown and the route painted "Couldn't start session" over it.
  test('a retriable failure never paints a terminal card', () => {
    expect(
      shouldPaintTerminalCard({ hasFailure: true, retriable: true, activelyStarting: false }),
    ).toBe(false);
  });

  // A provider operation is running right now. `actively_starting` exists to
  // say so and had zero readers in the entire client.
  test('an actively starting session never paints a terminal card', () => {
    expect(
      shouldPaintTerminalCard({ hasFailure: true, retriable: false, activelyStarting: true }),
    ).toBe(false);
  });

  test('a genuinely terminal failure paints the card', () => {
    expect(
      shouldPaintTerminalCard({ hasFailure: true, retriable: false, activelyStarting: false }),
    ).toBe(true);
  });

  test('no failure paints nothing', () => {
    expect(
      shouldPaintTerminalCard({ hasFailure: false, retriable: false, activelyStarting: false }),
    ).toBe(false);
  });

  // I2 lives at the `stage` boundary, not here. `SessionStartResult.retriable`
  // is a required boolean on the wire (`session-sandbox.ts:64`); every real
  // caller either has an actual `/start` answer or has nothing to gate. See
  // `shouldPaintFatalCard`'s doc comment for where "not yet known" (`stage`
  // `provisioning`/`starting`) is genuinely enforced.
});

describe('shouldPaintFatalCard', () => {
  // `stage:'starting'` is not a terminal state, whatever the sandbox row
  // says: `sandbox.status` stays `'stopped'` throughout BOTH an active wake
  // AND its retry cooldown. `stage` alone separates the two shapes that must
  // be withheld from the three that must paint.
  test('starting: withheld -- still polling, the server retries on its own', () => {
    expect(shouldPaintFatalCard({ stage: 'starting' })).toBe(false);
  });

  test('failed: paints -- the server is done trying', () => {
    expect(shouldPaintFatalCard({ stage: 'failed' })).toBe(true);
  });

  // `stage:'failed'` is reachable with `actively_starting:true` -- the second
  // `stoppedWakeResult` call site (`shared.ts:1089`) can yield it via a
  // detached wake-fence race the server code itself documents
  // (`shared.ts:1070-1076`). `shouldPaintFatalCard` has no `activelyStarting`
  // parameter to read, so it cannot be tempted to withhold here -- correctly:
  // `shouldPollSessionStart` does not poll `stage:'failed'`, `isSandboxResumable`
  // excludes the wake-class stop reasons so nothing re-invalidates the query,
  // and the wake ladder only holds until it exhausts. Withholding the card for
  // a `failed` stage strands the user with no card AND no poll -- a terminal
  // stage is terminal regardless of any in-flight flag.
  test('failed: paints even where a detached wake-fence race would report actively_starting:true', () => {
    expect(shouldPaintFatalCard({ stage: 'failed' })).toBe(true);
  });

  // `retriable` is not a parameter either. A stale-wake PARK
  // (`preserveEstablishedRuntimeOnOpen`'s park branch,
  // apps/api/src/projects/routes/shared.ts:941-952) answers `stage:'failed'`
  // with `retriable:true` for a box nothing is driving any more; there is no
  // way to accidentally thread that value back in and suppress this card.
  test('failed: paints despite what a hypothetical retriable:true would suggest', () => {
    expect(shouldPaintFatalCard({ stage: 'failed' })).toBe(true);
  });
});

/**
 * The five `/start` shapes a `stopped`/`failed`-classified session can arrive
 * as, bound to the two real page.tsx call sites and to the order they are
 * checked in (`wakeLadderHolding` -> `recoverableFailure` -> ... -> `fatal`).
 *
 * Rows 2 and 3 populate `session.failure` and are decided by
 * `recoverableFailure` (page.tsx ~684), which reads the real `retriable`.
 * Rows 1, 4 and 5 never populate `failure` and are decided by `fatal`
 * (page.tsx ~552, `shouldPaintFatalCard`), which reads `stage` ONLY -- neither
 * `retriable` (row 4, park, proves it cannot be trusted) nor `activelyStarting`
 * (row 3's second `stoppedWakeResult` call site can report `actively_starting:
 * true` on a genuinely `failed` stage, and a terminal stage must still paint).
 *
 * Row 2 is decided by BOTH in sequence: `recoverableFailure`'s `session.failure`
 * branch withholds it first (retriable:true); once the wake ladder is also
 * exhausted, `recoverableFailure` still returns null (no OTHER branch of it
 * matches -- `sandbox.status` is `'stopped'` not `'error'`, and the sandbox
 * row is non-null) so control falls through to `fatal`, which withholds it
 * again on `stage:'starting'` alone -- the actual reported bug, and pinning
 * ONLY the `recoverableFailure` verdict for row 2 (as round 1 did) missed it.
 */
describe('the five /start producer shapes, bound to their real call site', () => {
  test('#1 runtime_waking (shared.ts:755-763) -- owned by `fatal`: no card', () => {
    // stage:'starting', retriable:true, actively_starting:true, no `failure`.
    expect(shouldPaintFatalCard({ stage: 'starting' })).toBe(false);
  });

  test('#2 wake cooldown (shared.ts:805-826) -- `recoverableFailure` withholds it', () => {
    // stage:'starting', retriable:true, actively_starting:false, `failure` set.
    expect(
      shouldPaintTerminalCard({ hasFailure: true, retriable: true, activelyStarting: false }),
    ).toBe(false);
  });

  test('#2 wake cooldown, AFTER the ladder exhausts -- `fatal` also withholds it (the fix)', () => {
    // Same shape as above, evaluated at the `fatal` call site once
    // `recoverableFailure` has already returned null. `stage:'starting'`
    // (still polling, the server retries on its own) withholds it.
    expect(shouldPaintFatalCard({ stage: 'starting' })).toBe(false);
  });

  test('#3 stamped-terminal (shared.ts:828-841) -- owned by `recoverableFailure`: card paints', () => {
    // stage:'failed', retriable:false, actively_starting:false, `failure` set.
    expect(
      shouldPaintTerminalCard({ hasFailure: true, retriable: false, activelyStarting: false }),
    ).toBe(true);
  });

  test('#4 park (shared.ts:941-952) -- owned by `fatal`: card paints despite retriable:true', () => {
    // stage:'failed', retriable:TRUE, actively_starting:false, no `failure`.
    // `shouldPaintFatalCard` has no `retriable` parameter to misread -- which
    // is exactly why this still paints.
    expect(shouldPaintFatalCard({ stage: 'failed' })).toBe(true);
  });

  test('#5 preserve-unavailable (shared.ts:953-962) -- would paint if it reached `fatal`', () => {
    // stage:'failed', retriable:false, actively_starting:false, no `failure`.
    // Real page: `isRuntimeIdentityUnavailable` renders its own card first.
    expect(shouldPaintFatalCard({ stage: 'failed' })).toBe(true);
  });
});

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

  // I2: absence is not negation. An unknown `retriable` is not proof of
  // "not retriable"; withhold the card until the owner has answered.
  test('an unknown retriable withholds the card', () => {
    expect(
      shouldPaintTerminalCard({ hasFailure: true, retriable: null, activelyStarting: false }),
    ).toBe(false);
  });
});

describe('shouldPaintFatalCard', () => {
  // Fix round 2: `stage:'starting'` is not a terminal state, whatever the
  // sandbox row says. `sandbox.status` stays `'stopped'` throughout BOTH an
  // active wake AND its retry cooldown, and `activelyStarting` is `false` for
  // BOTH the cooldown and a genuinely abandoned park -- it cannot tell them
  // apart. Only `stage` can, so it is checked first, before `activelyStarting`.
  test('starting + actively starting: withheld (wake in flight)', () => {
    expect(shouldPaintFatalCard({ stage: 'starting', activelyStarting: true })).toBe(false);
  });

  // THE FIX. A wake-retry cooldown answers stage:'starting', retriable:true,
  // activelyStarting:false. `retriable` is never read here (see below), so
  // `stage` alone must withhold it -- this is the reported bug.
  test('starting + not actively starting (wake-retry cooldown): withheld', () => {
    expect(shouldPaintFatalCard({ stage: 'starting', activelyStarting: false })).toBe(false);
  });

  test('failed + not actively starting: paints', () => {
    expect(shouldPaintFatalCard({ stage: 'failed', activelyStarting: false })).toBe(true);
  });

  // `retriable` is not a parameter of this function at all -- a stale-wake
  // PARK (`preserveEstablishedRuntimeOnOpen`'s park branch,
  // apps/api/src/projects/routes/shared.ts:941-952) answers `stage:'failed'`
  // with `retriable:true` for a box nothing is driving any more; there is no
  // way to accidentally thread that value back in and suppress this card.
  test('failed + actively starting: withheld (an in-place recovery claim)', () => {
    expect(shouldPaintFatalCard({ stage: 'failed', activelyStarting: true })).toBe(false);
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
 * (page.tsx ~552, `shouldPaintFatalCard`), which never reads `retriable` at
 * all -- row 4 (park) proves it cannot be trusted there.
 *
 * Row 2 is decided by BOTH in sequence: `recoverableFailure`'s `session.failure`
 * branch withholds it first (retriable:true); once the wake ladder is also
 * exhausted, `recoverableFailure` still returns null (no OTHER branch of it
 * matches -- `sandbox.status` is `'stopped'` not `'error'`, and the sandbox
 * row is non-null) so control falls through to `fatal`. Before round 2,
 * `fatal` independently re-evaluated to TRUE there (same `activelyStarting:
 * false` as park), repainting a dead end over a session `/start` was still
 * retrying -- that fallthrough is the actual reported bug, and pinning ONLY
 * the `recoverableFailure` verdict for row 2 (as round 1 did) missed it.
 */
describe('the five /start producer shapes, bound to their real call site', () => {
  test('#1 runtime_waking (shared.ts:755-763) -- owned by `fatal`: no card', () => {
    // stage:'starting', retriable:true, actively_starting:true, no `failure`.
    expect(shouldPaintFatalCard({ stage: 'starting', activelyStarting: true })).toBe(false);
  });

  test('#2 wake cooldown (shared.ts:805-826) -- `recoverableFailure` withholds it', () => {
    // stage:'starting', retriable:true, actively_starting:false, `failure` set.
    expect(
      shouldPaintTerminalCard({ hasFailure: true, retriable: true, activelyStarting: false }),
    ).toBe(false);
  });

  test('#2 wake cooldown, AFTER the ladder exhausts -- `fatal` also withholds it (the fix)', () => {
    // Same shape as above, evaluated at the `fatal` call site once
    // `recoverableFailure` has already returned null. `activelyStarting` is
    // `false` here, identical to #4 -- only `stage:'starting'` (still polling,
    // the server retries on its own) tells them apart.
    expect(shouldPaintFatalCard({ stage: 'starting', activelyStarting: false })).toBe(false);
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
    expect(shouldPaintFatalCard({ stage: 'failed', activelyStarting: false })).toBe(true);
  });

  test('#5 preserve-unavailable (shared.ts:953-962) -- would paint if it reached `fatal`', () => {
    // stage:'failed', retriable:false, actively_starting:false, no `failure`.
    // Real page: `isRuntimeIdentityUnavailable` renders its own card first.
    expect(shouldPaintFatalCard({ stage: 'failed', activelyStarting: false })).toBe(true);
  });
});

import { describe, expect, test } from 'bun:test';
import { shouldPaintTerminalCard } from './terminal-card-gate';

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

/**
 * The five `/start` shapes a `stopped`/`failed`-classified session can arrive
 * as (Fix round 1 review), bound to the two real page.tsx call sites rather
 * than tested as bare (retriable, activelyStarting) pairs.
 *
 * Rows 2 and 3 populate `session.failure` and are owned by `recoverableFailure`
 * (page.tsx ~695), which reads the real `retriable`. Rows 1 and 4 never
 * populate `failure` and are owned by `fatal` (page.tsx ~552), which reads a
 * HARDCODED `retriable: false` -- never the real value -- because row 4 (park)
 * proves `retriable` cannot be trusted there: `preserveEstablishedRuntimeOnOpen`'s
 * park branch (apps/api/src/projects/routes/shared.ts:941-952) answers
 * `stage:'failed', retriable:true` for a box nothing is driving any more, and
 * reading `retriable` at that site would suppress its "<session> is stopped /
 * Restart session" card with no poll, no auto-resume, and no ladder rung left
 * to recover the user. Row 5 (preserve-unavailable) never reaches either call
 * site in the real page -- it has its own unconditional
 * `isRuntimeIdentityUnavailable` branch -- included here only to pin that
 * `shouldPaintTerminalCard` would also call it terminal if it ever did.
 */
describe('the five /start producer shapes, bound to their real call site', () => {
  test('#1 runtime_waking (shared.ts:755-763) -- owned by `fatal`: no card', () => {
    // stage:'starting', retriable:true, actively_starting:true, no `failure`.
    expect(
      shouldPaintTerminalCard({ hasFailure: true, retriable: false, activelyStarting: true }),
    ).toBe(false);
  });

  test('#2 wake cooldown (shared.ts:805-826) -- owned by `recoverableFailure`: no card, the reported bug', () => {
    // stage:'starting', retriable:true, actively_starting:false, `failure` set.
    expect(
      shouldPaintTerminalCard({ hasFailure: true, retriable: true, activelyStarting: false }),
    ).toBe(false);
  });

  test('#3 stamped-terminal (shared.ts:828-841) -- owned by `recoverableFailure`: card paints', () => {
    // stage:'failed', retriable:false, actively_starting:false, `failure` set.
    expect(
      shouldPaintTerminalCard({ hasFailure: true, retriable: false, activelyStarting: false }),
    ).toBe(true);
  });

  test('#4 park (shared.ts:941-952) -- owned by `fatal`: card paints despite retriable:true', () => {
    // stage:'failed', retriable:TRUE, actively_starting:false, no `failure`.
    // `fatal` hardcodes retriable:false at its call site -- it never reads the
    // real (misleading) value -- which is exactly why this still paints.
    expect(
      shouldPaintTerminalCard({ hasFailure: true, retriable: false, activelyStarting: false }),
    ).toBe(true);
  });

  test('#5 preserve-unavailable (shared.ts:953-962) -- would paint if it reached the gate', () => {
    // stage:'failed', retriable:false, actively_starting:false, no `failure`.
    // Real page: `isRuntimeIdentityUnavailable` renders its own card first.
    expect(
      shouldPaintTerminalCard({ hasFailure: true, retriable: false, activelyStarting: false }),
    ).toBe(true);
  });
});

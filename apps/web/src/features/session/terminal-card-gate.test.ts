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

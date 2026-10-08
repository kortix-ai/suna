import { describe, expect, test } from 'bun:test';
import { nextKeyboardInset, type KeyboardPhase } from './keyboard-inset';

/** Folds keyboard events into the inset, from a seed read at mount. */
function run(seed: number, events: [KeyboardPhase, number][]): number {
  return events.reduce((inset, [phase, height]) => nextKeyboardInset(inset, phase, height), seed);
}

describe('nextKeyboardInset (KRTX-1672)', () => {
  test('a thread that mounts mid-open ends at the full keyboard height', () => {
    // Seeded at 120 pt while the keyboard was still rising to 336 pt. The
    // open's start event fired before the thread mounted, so none follows.
    expect(run(120, [['move', 240], ['move', 336], ['end', 336]])).toBe(336);
  });

  test('a start event does not jump the inset to its target height', () => {
    expect(run(0, [['start', 336]])).toBe(0);
    expect(run(0, [['start', 336], ['move', 100]])).toBe(100);
  });

  test('a keyboard that grows while open (suggestion strip) raises the inset', () => {
    expect(run(336, [['move', 380], ['end', 380]])).toBe(380);
  });

  test('an interactive drag follows the finger, and a close ends at 0', () => {
    expect(run(336, [['interactive', 150]])).toBe(150);
    expect(run(336, [['interactive', 150], ['move', 0], ['end', 0]])).toBe(0);
  });

  test('a negative height never pads', () => {
    expect(run(0, [['end', -4]])).toBe(0);
  });
});

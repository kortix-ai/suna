import { describe, expect, test } from 'bun:test';

import { testUiTranslator } from '@/i18n/test-translator';

import { computerAwakeLine, computerAwakeText } from './computer-awake';

const MIN = 60_000;
const NOW = Date.UTC(2026, 9, 12, 10, 0);
const at = (minutes: number) => new Date(NOW + minutes * MIN);

/** The English line for a window `until`/`capAt` minutes from now. */
function line(until: number, capAt: number, turnRunning = false, now = NOW) {
  const decided = computerAwakeLine({ awake: { until: at(until), capAt: at(capAt) }, turnRunning, now });
  return decided && computerAwakeText(decided, testUiTranslator);
}

// KRTX-1729: the composer says the computer stays on while the person is here,
// and for how long presence can keep it on.
describe('computerAwakeLine', () => {
  test('presence still extends: how long it can keep the computer on', () => {
    expect(line(15, 100)).toBe("Sandbox stays on while you're here · up to 1 h 40 min");
    expect(line(15, 25)).toBe("Sandbox stays on while you're here · up to 25 min");
    expect(line(15, 120)).toBe("Sandbox stays on while you're here · up to 2 h");
  });

  test('"up to" never overstates: it rounds down to the minute', () => {
    expect(line(15, 25.9)).toBe("Sandbox stays on while you're here · up to 25 min");
  });

  test('the deadline reached the cap: presence no longer extends, so it says when the computer stops', () => {
    expect(line(10, 10)).toBe('Sandbox stops in 10 min. Send a message to keep it on.');
    // Within a second of the cap counts as at the cap.
    expect(line(10 + 0.5 / 60, 10)).toBe('Sandbox stops in 11 min. Send a message to keep it on.');
  });

  // Another grant holds the computer past the cap: presence is not what keeps
  // it on, and that grant can renew, so a countdown would be false.
  test('hidden when another grant holds the deadline past the cap', () => {
    // A preview port renews 30 min on each request.
    expect(line(28, 20)).toBeNull();
    // The cap has passed, and the deadline is another grant's.
    expect(line(5, -10)).toBeNull();
    // A refresh between the runtime's idle frame and the ledger closing the
    // turn reads the open turn: a deadline 4 h out, a cap 2 h out. It said
    // "Sandbox stops in 4 h" for up to 5 min.
    expect(line(240, 120)).toBeNull();
  });

  test('the stop countdown rounds up, so the last minute never reads 0', () => {
    expect(line(0.5, 0.5)).toBe('Sandbox stops in 1 min. Send a message to keep it on.');
    expect(line(9.2, 9.2)).toBe('Sandbox stops in 10 min. Send a message to keep it on.');
  });

  test('the stop line keeps the hour form', () => {
    expect(computerAwakeText({ kind: 'stops', minutes: 95 }, testUiTranslator)).toBe(
      'Sandbox stops in 1 h 35 min. Send a message to keep it on.',
    );
  });

  test('hidden while a turn runs: the turn keeps the computer on', () => {
    expect(line(15, 100, true)).toBeNull();
    expect(line(10, 10, true)).toBeNull();
  });

  test('hidden with no window: a viewer, a stopped computer, an absent tab', () => {
    expect(computerAwakeLine({ awake: null, turnRunning: false, now: NOW })).toBeNull();
  });

  test('hidden once the stop time has passed', () => {
    expect(line(0, 0)).toBeNull();
    expect(line(-1, 100)).toBeNull();
  });

  test('the line follows the clock it is given', () => {
    const awake = { until: at(40), capAt: at(100) };
    expect(computerAwakeText(computerAwakeLine({ awake, turnRunning: false, now: NOW + 30 * MIN })!, testUiTranslator)).toBe(
      "Sandbox stays on while you're here · up to 1 h 10 min",
    );
    expect(computerAwakeLine({ awake, turnRunning: false, now: NOW + 40 * MIN })).toBeNull();
  });
});

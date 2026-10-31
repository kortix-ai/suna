import { describe, expect, test } from 'bun:test';

import { ESC_IDLE, ESC_STOP_WINDOW_MS, countEscape, escStopHint } from './esc-stop.ts';

describe('Esc ×3 to stop', () => {
  test('one and two presses never stop', () => {
    const first = countEscape(ESC_IDLE, 1000);
    expect(first.stop).toBe(false);
    expect(first.remaining).toBe(2);
    const second = countEscape(first.counter, 1500);
    expect(second.stop).toBe(false);
    expect(second.remaining).toBe(1);
  });

  test('the third press inside the window stops and resets', () => {
    let state = countEscape(ESC_IDLE, 0);
    state = countEscape(state.counter, 1000);
    state = countEscape(state.counter, 3999);
    expect(state.stop).toBe(true);
    expect(state.counter).toEqual(ESC_IDLE);
  });

  test('a press after the window starts a new run', () => {
    let state = countEscape(ESC_IDLE, 0);
    state = countEscape(state.counter, 1000);
    state = countEscape(state.counter, ESC_STOP_WINDOW_MS + 1);
    expect(state.stop).toBe(false);
    expect(state.remaining).toBe(2);
  });

  test('the hint counts down', () => {
    expect(escStopHint(2)).toBe('Esc 2 more times to stop');
    expect(escStopHint(1)).toBe('Esc once more to stop');
  });
});

import { describe, expect, test } from 'bun:test';
import { PRESENCE_CHECK_MS, PRESENCE_INPUT_WINDOW_MS, watchHumanPresence } from './human-presence';

/** A document and window stand-in: listeners by event name, one interval. */
function fakeEnv() {
  let clock = 1_000_000;
  let tick: (() => void) | null = null;
  const listeners = new Map<string, Set<() => void>>();
  const target = {
    addEventListener: (type: string, fn: () => void) => {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type)!.add(fn);
    },
    removeEventListener: (type: string, fn: () => void) => listeners.get(type)?.delete(fn),
  };
  const doc = { hidden: false, ...target };
  const win = {
    ...target,
    setInterval: (fn: () => void, ms: number) => {
      expect(ms).toBe(PRESENCE_CHECK_MS);
      tick = fn;
      return 1;
    },
    clearInterval: () => {
      tick = null;
    },
  };
  return {
    env: { doc, win, now: () => clock } as unknown as Parameters<typeof watchHumanPresence>[0],
    doc,
    advance(ms: number) {
      // One interval tick per elapsed check period, as a browser would fire them.
      for (let t = 0; t < ms; t += PRESENCE_CHECK_MS) {
        clock += Math.min(PRESENCE_CHECK_MS, ms - t);
        tick?.();
      }
    },
    fire(type: string) {
      for (const fn of listeners.get(type) ?? []) fn();
    },
    listenerCount: () => [...listeners.values()].reduce((n, s) => n + s.size, 0),
    ticking: () => tick !== null,
  };
}

// KRTX-1729: a visible tab sent "present" forever, and each renewal extended
// the box deadline, so an idle visible tab kept the computer up all night.
describe('watchHumanPresence', () => {
  test('a visible view is present at mount', () => {
    const f = fakeEnv();
    const sent: boolean[] = [];
    watchHumanPresence(f.env, (a) => sent.push(a), () => true);
    expect(sent).toEqual([true]);
  });

  test('a visible tab with no input for the window reports absent, once', () => {
    const f = fakeEnv();
    const sent: boolean[] = [];
    watchHumanPresence(f.env, (a) => sent.push(a), () => true);
    f.advance(PRESENCE_INPUT_WINDOW_MS - PRESENCE_CHECK_MS);
    expect(sent).toEqual([true]);
    f.advance(2 * PRESENCE_CHECK_MS);
    expect(sent).toEqual([true, false]);
    f.advance(60 * 60_000);
    expect(sent).toEqual([true, false]);
  });

  test('input keeps the person present, and the first input after idle reports present at once', () => {
    const f = fakeEnv();
    const sent: boolean[] = [];
    watchHumanPresence(f.env, (a) => sent.push(a), () => true);
    for (let i = 0; i < 6; i++) {
      f.advance(5 * 60_000);
      f.fire('keydown');
    }
    expect(sent).toEqual([true]);
    f.advance(PRESENCE_INPUT_WINDOW_MS + PRESENCE_CHECK_MS);
    expect(sent).toEqual([true, false]);
    f.fire('pointerdown');
    expect(sent).toEqual([true, false, true]);
  });

  test('a hidden tab is absent, and showing it again counts as presence', () => {
    const f = fakeEnv();
    const sent: boolean[] = [];
    watchHumanPresence(f.env, (a) => sent.push(a), () => true);
    f.doc.hidden = true;
    f.fire('visibilitychange');
    expect(sent).toEqual([true, false]);
    f.fire('keydown');
    expect(sent).toEqual([true, false]);
    f.advance(PRESENCE_INPUT_WINDOW_MS * 2);
    f.doc.hidden = false;
    f.fire('visibilitychange');
    expect(sent).toEqual([true, false, true]);
  });

  test('while the stream is down, a present person renews on every check', () => {
    const f = fakeEnv();
    const sent: boolean[] = [];
    let connected = false;
    watchHumanPresence(f.env, (a) => sent.push(a), () => connected);
    f.fire('keydown');
    f.advance(2 * PRESENCE_CHECK_MS);
    expect(sent).toEqual([true, true, true]);
    connected = true;
    f.advance(2 * PRESENCE_CHECK_MS);
    expect(sent).toEqual([true, true, true]);
  });

  test('stop reports absent and removes every listener and the interval', () => {
    const f = fakeEnv();
    const sent: boolean[] = [];
    const stop = watchHumanPresence(f.env, (a) => sent.push(a), () => true);
    expect(f.listenerCount()).toBeGreaterThan(0);
    stop();
    expect(sent).toEqual([true, false]);
    expect(f.listenerCount()).toBe(0);
    expect(f.ticking()).toBe(false);
  });
});

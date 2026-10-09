import { describe, expect, test } from 'bun:test';
import { PRESENCE_CHECK_MS, PRESENCE_INPUT_WINDOW_MS, presenceReporter, watchHumanPresence } from './human-presence';

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

// KRTX-1742: a closing tab must end its lease at once. Otherwise the lease
// outlives the tab by up to 90 s and suppresses the phone and Web Push.
// Only with `pageExit` on: the project's `notification_center` flag.
describe('watchHumanPresence on pagehide', () => {
  test('pagehide reports absent once, and the page stays absent until it is shown or used', () => {
    const f = fakeEnv();
    const sent: boolean[] = [];
    watchHumanPresence(f.env, (a) => sent.push(a), () => false, () => true);
    f.fire('pagehide');
    f.fire('pagehide');
    expect(sent).toEqual([true, false]);
    f.advance(4 * PRESENCE_CHECK_MS);
    expect(sent).toEqual([true, false]);
    // A back/forward-cache restore shows the page again.
    f.fire('visibilitychange');
    expect(sent).toEqual([true, false, true]);
  });

  test('a hidden tab that then unloads sends absent only once', () => {
    const f = fakeEnv();
    const sent: boolean[] = [];
    watchHumanPresence(f.env, (a) => sent.push(a), () => true, () => true);
    f.doc.hidden = true;
    f.fire('visibilitychange');
    f.fire('pagehide');
    expect(sent).toEqual([true, false]);
  });

  test('without pageExit, pagehide reports nothing: the lease lives to its expiry', () => {
    const f = fakeEnv();
    const sent: boolean[] = [];
    watchHumanPresence(f.env, (a) => sent.push(a), () => false);
    f.fire('pagehide');
    f.advance(4 * PRESENCE_CHECK_MS);
    // Still present: the down-stream renewals continue as before.
    expect(sent.every(Boolean)).toBe(true);
  });

  test('pageExit is read when the page hides, so a later change applies without a restart', () => {
    const f = fakeEnv();
    const sent: boolean[] = [];
    let pageExit = false;
    watchHumanPresence(f.env, (a) => sent.push(a), () => true, () => pageExit);
    f.fire('pagehide');
    expect(sent).toEqual([true]);
    pageExit = true;
    f.fire('pagehide');
    expect(sent).toEqual([true, false]);
  });
});

// KRTX-1742: `alerts` tells the server this tab shows its own notifications.
// A change must reach the lease at once, and must never drop the lease: a
// stop-then-start would race an absent PUT against a present PUT.
describe('presenceReporter', () => {
  test('every report carries the current alerts flag', () => {
    const puts: Array<{ active: boolean; alerts: boolean }> = [];
    const reporter = presenceReporter((p) => puts.push(p), false);
    reporter.report(true);
    reporter.report(false);
    expect(puts).toEqual([
      { active: true, alerts: false },
      { active: false, alerts: false },
    ]);
  });

  test('a flag change while present re-sends present with the new flag, once', () => {
    const puts: Array<{ active: boolean; alerts: boolean }> = [];
    const reporter = presenceReporter((p) => puts.push(p), false);
    reporter.report(true);
    reporter.setAlerts(true);
    reporter.setAlerts(true);
    expect(puts).toEqual([
      { active: true, alerts: false },
      { active: true, alerts: true },
    ]);
  });

  test('a flag change while absent sends nothing; the next present report carries it', () => {
    const puts: Array<{ active: boolean; alerts: boolean }> = [];
    const reporter = presenceReporter((p) => puts.push(p), true);
    reporter.report(false);
    reporter.setAlerts(false);
    expect(puts).toEqual([{ active: false, alerts: true }]);
    reporter.report(true);
    expect(puts.at(-1)).toEqual({ active: true, alerts: false });
  });
});

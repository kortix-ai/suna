import { beforeEach, describe, expect, test } from 'bun:test';

import {
  HOVER_CLOSE_DELAY_MS,
  HOVER_MOVE_DEBOUNCE_MS,
  HOVER_OPEN_DELAY_MS,
  clearIfActive,
  hoverOpenDelayMs,
  useSessionHoverStore,
} from './session-hover-store';

const store = useSessionHoverStore;
const active = () => store.getState().activeSessionId;
const warm = () => store.getState().warm;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Half a delay: safely before it elapses. */
const BEFORE = Math.floor(HOVER_CLOSE_DELAY_MS / 2);

/** Real timers run late on a loaded runner: poll for the settled state, up to 2 s. */
async function settled(check: () => boolean): Promise<boolean> {
  const deadline = Date.now() + 2_000;
  while (!check() && Date.now() < deadline) await sleep(10);
  return check();
}
const opened = (sessionId: string) => settled(() => active() === sessionId);

beforeEach(() => {
  store.getState().dismiss();
});

describe('hover delay policy', () => {
  test('the first card waits, the rest pay only the move debounce', () => {
    expect(hoverOpenDelayMs(false)).toBe(HOVER_OPEN_DELAY_MS);
    expect(hoverOpenDelayMs(true)).toBe(HOVER_MOVE_DEBOUNCE_MS);
  });

  test('compare-and-clear ignores a close aimed at a replaced row', () => {
    expect(clearIfActive('a', 'a')).toBeNull();
    expect(clearIfActive('b', 'a')).toBe('b');
    expect(clearIfActive(null, 'a')).toBeNull();
  });
});

describe('session hover group', () => {
  test('a cold row does not open until the delay elapses', async () => {
    store.getState().openSession('a');
    expect(active()).toBeNull();

    expect(await opened('a')).toBe(true);
    expect(warm()).toBe(true);
  });

  test('moving to another row while warm keeps the card up and never shows two', async () => {
    store.getState().openSession('a');
    expect(await opened('a')).toBe(true);

    // Leaving row A schedules its close; entering row B happens inside that
    // window, exactly as a pointer travelling down the sidebar does.
    store.getState().closeSession('a');
    store.getState().openSession('b');

    // During the move debounce the card still shows A: no gap, and the single
    // active id is what guarantees one card exists at a time.
    expect(active()).toBe('a');
    expect(await opened('b')).toBe(true);
  });

  test('a sweep across warm rows moves the card once, to where it stops', async () => {
    store.getState().openSession('a');
    expect(await opened('a')).toBe(true);

    const seen = new Set<string | null>();
    const unsubscribe = store.subscribe((state) => seen.add(state.activeSessionId));
    // The pointer crosses B and C without stopping and comes to rest on D.
    store.getState().closeSession('a');
    store.getState().openSession('b');
    store.getState().closeSession('b');
    store.getState().openSession('c');
    store.getState().closeSession('c');
    store.getState().openSession('d');
    expect(await opened('d')).toBe(true);
    unsubscribe();

    expect([...seen]).toEqual(['d']);
  });

  test('leaving a row before its move lands closes the card still showing', async () => {
    store.getState().openSession('a');
    expect(await opened('a')).toBe(true);

    store.getState().closeSession('a');
    store.getState().openSession('b');
    store.getState().closeSession('b');

    expect(await settled(() => active() === null)).toBe(true);
  });

  test('a close scheduled for the row we left cannot close the row we moved to', async () => {
    store.getState().openSession('a');
    expect(await opened('a')).toBe(true);

    store.getState().closeSession('a');
    store.getState().openSession('b');
    await sleep(HOVER_CLOSE_DELAY_MS + 80);

    // Row A's pending close fired in here. Row B must survive it.
    expect(active()).toBe('b');
  });

  test('sweeping across rows without stopping opens nothing', async () => {
    store.getState().openSession('a');
    await sleep(BEFORE);
    store.getState().closeSession('a');
    store.getState().openSession('b');
    await sleep(BEFORE);
    store.getState().closeSession('b');

    await sleep(HOVER_OPEN_DELAY_MS + 120);
    expect(active()).toBeNull();
  });

  test('re-entering the row already showing does not restart it', async () => {
    store.getState().openSession('a');
    expect(await opened('a')).toBe(true);

    // The pointer crossing back from the card onto the row.
    store.getState().closeSession('a');
    store.getState().openSession('a');
    await sleep(HOVER_CLOSE_DELAY_MS + 80);

    expect(active()).toBe('a');
  });

  test('the group cools down after the last card closes', async () => {
    store.getState().openSession('a');
    expect(await opened('a')).toBe(true);
    store.getState().closeSession('a');

    expect(await settled(() => active() === null && !warm())).toBe(true);

    // Cold again, so the next row pays the delay rather than opening instantly.
    store.getState().openSession('b');
    expect(active()).toBeNull();
  });

  test('dismiss closes immediately and cools the group', async () => {
    store.getState().openSession('a');
    expect(await opened('a')).toBe(true);

    store.getState().dismiss();
    expect(active()).toBeNull();
    expect(warm()).toBe(false);
  });
});

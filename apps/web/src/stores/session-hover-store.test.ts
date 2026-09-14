import { beforeEach, describe, expect, test } from 'bun:test';

import {
  HOVER_CLOSE_DELAY_MS,
  HOVER_OPEN_DELAY_MS,
  HOVER_WARM_GRACE_MS,
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
/** Comfortably after the longest single delay, without making tests slow. */
const AFTER = HOVER_OPEN_DELAY_MS + 120;

beforeEach(() => {
  store.getState().dismiss();
});

describe('hover delay policy', () => {
  test('the first card waits, the rest are instant', () => {
    expect(hoverOpenDelayMs(false)).toBe(HOVER_OPEN_DELAY_MS);
    expect(hoverOpenDelayMs(true)).toBe(0);
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

    await sleep(AFTER);
    expect(active()).toBe('a');
    expect(warm()).toBe(true);
  });

  test('moving to another row while warm is instant and never shows two cards', async () => {
    store.getState().openSession('a');
    await sleep(AFTER);
    expect(active()).toBe('a');

    // Leaving row A schedules its close; entering row B happens inside that
    // window, exactly as a pointer travelling down the sidebar does.
    store.getState().closeSession('a');
    store.getState().openSession('b');

    // Synchronous: no delay paid, and A is not merely "also open" — the single
    // active id is what guarantees one card exists at a time.
    expect(active()).toBe('b');
  });

  test('a close scheduled for the row we left cannot close the row we moved to', async () => {
    store.getState().openSession('a');
    await sleep(AFTER);

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

    await sleep(AFTER);
    expect(active()).toBeNull();
  });

  test('re-entering the row already showing does not restart it', async () => {
    store.getState().openSession('a');
    await sleep(AFTER);

    // The pointer crossing back from the card onto the row.
    store.getState().closeSession('a');
    store.getState().openSession('a');
    await sleep(HOVER_CLOSE_DELAY_MS + 80);

    expect(active()).toBe('a');
  });

  test('the group cools down after the last card closes', async () => {
    store.getState().openSession('a');
    await sleep(AFTER);
    store.getState().closeSession('a');
    await sleep(HOVER_CLOSE_DELAY_MS + HOVER_WARM_GRACE_MS + 120);

    expect(active()).toBeNull();
    expect(warm()).toBe(false);

    // Cold again, so the next row pays the delay rather than opening instantly.
    store.getState().openSession('b');
    expect(active()).toBeNull();
  });

  test('dismiss closes immediately and cools the group', async () => {
    store.getState().openSession('a');
    await sleep(AFTER);

    store.getState().dismiss();
    expect(active()).toBeNull();
    expect(warm()).toBe(false);
  });
});

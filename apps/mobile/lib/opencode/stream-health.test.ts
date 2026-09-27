import { beforeEach, describe, expect, test } from 'bun:test';
import {
  INITIAL_STREAM_HEALTH,
  STREAM_STALLED_MS,
  lastUpdateLabel,
  liveUpdatesView,
  reduceStreamHealth,
  useStreamHealthStore,
  type StreamHealth,
  type StreamHealthEvent,
} from './stream-health';

const MIN = 60_000;

function run(events: StreamHealthEvent[], from: StreamHealth = INITIAL_STREAM_HEALTH): StreamHealth {
  return events.reduce(reduceStreamHealth, from);
}

const connected = run([
  { type: 'connecting', at: 0 },
  { type: 'open', at: 1_000 },
]);

describe('reduceStreamHealth', () => {
  test('first connect then open is connected with no downtime', () => {
    expect(connected).toEqual({ phase: 'connected', pauseReason: null, lastEventAt: 1_000, downSince: null });
  });

  test('a lost connection reconnects and records the last frame and when it went down', () => {
    const state = reduceStreamHealth(connected, { type: 'lost', at: 70_000, lastEventAt: 9_000 });
    expect(state).toEqual({ phase: 'reconnecting', pauseReason: null, lastEventAt: 9_000, downSince: 70_000 });
  });

  test('repeated backoff failures keep the first downSince and the same object', () => {
    const lost = reduceStreamHealth(connected, { type: 'lost', at: 70_000, lastEventAt: 9_000 });
    const again = reduceStreamHealth(lost, { type: 'lost', at: 90_000, lastEventAt: 9_000 });
    expect(again).toBe(lost);
  });

  test('connecting after connect (recycle, foreground) does not leave connected', () => {
    expect(reduceStreamHealth(connected, { type: 'connecting', at: 5_000 })).toBe(connected);
  });

  test('parking pauses with reason gave-up; a failed probe stays paused', () => {
    const parked = run(
      [
        { type: 'lost', at: 70_000, lastEventAt: 9_000 },
        { type: 'parked', at: 200_000, lastEventAt: 9_000 },
      ],
      connected,
    );
    expect(parked).toEqual({ phase: 'paused', pauseReason: 'gave-up', lastEventAt: 9_000, downSince: 70_000 });
    expect(reduceStreamHealth(parked, { type: 'lost', at: 260_000, lastEventAt: 9_000 })).toBe(parked);
    expect(reduceStreamHealth(parked, { type: 'parked', at: 260_000, lastEventAt: 9_000 })).toBe(parked);
    expect(reduceStreamHealth(parked, { type: 'connecting', at: 260_000 })).toBe(parked);
  });

  test('a 401 pauses with reason auth', () => {
    const state = reduceStreamHealth(connected, { type: 'auth-failed', at: 5_000, lastEventAt: 4_000 });
    expect(state.phase).toBe('paused');
    expect(state.pauseReason).toBe('auth');
    expect(state.lastEventAt).toBe(4_000);
  });

  test('open after a pause clears it', () => {
    const paused = reduceStreamHealth(connected, { type: 'auth-failed', at: 5_000, lastEventAt: 4_000 });
    expect(reduceStreamHealth(paused, { type: 'open', at: 9_000 })).toEqual({
      phase: 'connected',
      pauseReason: null,
      lastEventAt: 9_000,
      downSince: null,
    });
  });

  test('stopped resets to idle', () => {
    expect(reduceStreamHealth(connected, { type: 'stopped' })).toBe(INITIAL_STREAM_HEALTH);
  });

  test('a lost event without a frame keeps the known last frame', () => {
    const lost = reduceStreamHealth(connected, { type: 'lost', at: 70_000, lastEventAt: null });
    expect(lost.lastEventAt).toBe(1_000);
  });
});

describe('liveUpdatesView', () => {
  test('connected and idle are not paused', () => {
    expect(liveUpdatesView(connected, 10 * MIN).paused).toBe(false);
    expect(liveUpdatesView(INITIAL_STREAM_HEALTH, 10 * MIN).paused).toBe(false);
  });

  test('reconnecting is not paused until the stall threshold', () => {
    const lost = reduceStreamHealth(connected, { type: 'lost', at: 70_000, lastEventAt: 9_000 });
    expect(liveUpdatesView(lost, 70_000 + STREAM_STALLED_MS - 1).paused).toBe(false);
    expect(liveUpdatesView(lost, 70_000 + STREAM_STALLED_MS)).toEqual({
      paused: true,
      reason: 'stalled',
      lastEventAt: 9_000,
    });
  });

  test('a first connect that never opens stalls too', () => {
    const connecting = reduceStreamHealth(INITIAL_STREAM_HEALTH, { type: 'connecting', at: 0 });
    expect(liveUpdatesView(connecting, STREAM_STALLED_MS)).toEqual({
      paused: true,
      reason: 'stalled',
      lastEventAt: null,
    });
  });

  test('paused carries its reason at once', () => {
    const paused = reduceStreamHealth(connected, { type: 'auth-failed', at: 5_000, lastEventAt: 4_000 });
    expect(liveUpdatesView(paused, 5_000)).toEqual({ paused: true, reason: 'auth', lastEventAt: 4_000 });
  });

  test('the stall threshold outlasts the watchdog', () => {
    expect(STREAM_STALLED_MS).toBe(120_000);
  });
});

describe('lastUpdateLabel', () => {
  test('buckets', () => {
    expect(lastUpdateLabel(null, 0)).toBe('Live updates paused');
    expect(lastUpdateLabel(0, 59_999)).toBe('Last update just now');
    expect(lastUpdateLabel(0, 6 * MIN + 30_000)).toBe('Last update 6 min ago');
    expect(lastUpdateLabel(0, 59 * MIN)).toBe('Last update 59 min ago');
    expect(lastUpdateLabel(0, 2 * 60 * MIN)).toBe('Last update 2 hr ago');
    expect(lastUpdateLabel(0, 24 * 60 * MIN)).toBe('Last update 1 day ago');
    expect(lastUpdateLabel(0, 3 * 24 * 60 * MIN)).toBe('Last update 3 days ago');
  });

  test('a clock behind the frame reads just now', () => {
    expect(lastUpdateLabel(10_000, 0)).toBe('Last update just now');
  });
});

describe('useStreamHealthStore', () => {
  beforeEach(() => useStreamHealthStore.getState().dispatch({ type: 'stopped' }));

  test('dispatch reduces; reconnect calls the registered handler only', () => {
    const store = useStreamHealthStore.getState();
    store.dispatch({ type: 'connecting', at: 0 });
    expect(useStreamHealthStore.getState().health.phase).toBe('connecting');

    let calls = 0;
    const unregister = store.registerReconnect(() => calls++);
    store.reconnect();
    expect(calls).toBe(1);
    unregister();
    store.reconnect();
    expect(calls).toBe(1);
  });

  test('an unchanged reduce does not notify subscribers', () => {
    const store = useStreamHealthStore.getState();
    store.dispatch({ type: 'connecting', at: 0 });
    store.dispatch({ type: 'open', at: 1 });
    let notified = 0;
    const unsubscribe = useStreamHealthStore.subscribe(() => notified++);
    store.dispatch({ type: 'connecting', at: 2 });
    unsubscribe();
    expect(notified).toBe(0);
  });

  test('a newer registration is not removed by an older unregister', () => {
    const store = useStreamHealthStore.getState();
    let first = 0;
    let second = 0;
    const unregisterFirst = store.registerReconnect(() => first++);
    const unregisterSecond = store.registerReconnect(() => second++);
    unregisterFirst();
    store.reconnect();
    expect([first, second]).toEqual([0, 1]);
    unregisterSecond();
  });
});

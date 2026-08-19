import { describe, expect, test } from 'bun:test';
import { livenessBusy, sessionSyncBusy } from './use-session-sync';

/**
 * WHICH signal switches the transcript liveness poll.
 *
 * Every REST prompt used to arm it explicitly, so sending guaranteed the tail
 * was pulled behind SSE. That path is gone, and the only remaining switch read
 * the raw `session.status` slot — a stream this tab can miss frames from. Drop
 * the busy frame (a backgrounded tab, a proxy reconnect across the start of a
 * turn) and the poll never started, while `useSessionWorking` correctly read
 * the session as working off the server's turn authority: the turn rendered as
 * working with no assistant content until the user reloaded.
 *
 * The switch is the working PROJECTION when the caller has one, and the stream
 * slot only when it does not (apps/mobile, which mounts no projection).
 */
describe('livenessBusy', () => {
  test('the caller\'s working projection wins over the stream slot', () => {
    expect(
      livenessBusy({ networkEnabled: true, runtimeHealthy: true, working: true, streamBusy: false }),
    ).toBe(true);
    expect(
      livenessBusy({ networkEnabled: true, runtimeHealthy: true, working: false, streamBusy: true }),
    ).toBe(false);
  });

  test('with no projection the stream slot still decides', () => {
    expect(
      livenessBusy({
        networkEnabled: true,
        runtimeHealthy: true,
        working: undefined,
        streamBusy: true,
      }),
    ).toBe(true);
  });

  test('a poll that cannot reach the runtime never runs', () => {
    expect(
      livenessBusy({ networkEnabled: false, runtimeHealthy: true, working: true, streamBusy: true }),
    ).toBe(false);
    expect(
      livenessBusy({ networkEnabled: true, runtimeHealthy: false, working: true, streamBusy: true }),
    ).toBe(false);
  });
});

/**
 * The hook's PUBLIC `isBusy`, which is a different reader of the same rule.
 *
 * `useSessionSync` is published, so neither `status` nor `isBusy` can be
 * removed — but `isBusy` derived from the raw stream slot while `livenessBusy`
 * (the poll's switch, three lines away) already preferred the caller's
 * projection. Two answers to one question, and the one the hook handed out was
 * the weaker of the two: a dropped busy frame made a session the server's own
 * turn authority reported as working answer `isBusy: false`.
 */
describe('sessionSyncBusy', () => {
  test('the caller\'s projection is the answer when it has one', () => {
    expect(sessionSyncBusy({ working: true, streamBusy: false })).toBe(true);
    expect(sessionSyncBusy({ working: false, streamBusy: true })).toBe(false);
  });

  test('with no projection the stream slot still decides (apps/mobile)', () => {
    expect(sessionSyncBusy({ working: undefined, streamBusy: true })).toBe(true);
    expect(sessionSyncBusy({ working: undefined, streamBusy: false })).toBe(false);
  });

  test('livenessBusy and the public answer are ONE rule, plus the poll\'s reachability gate', () => {
    for (const working of [true, false, undefined] as const) {
      for (const streamBusy of [true, false]) {
        expect(livenessBusy({ networkEnabled: true, runtimeHealthy: true, working, streamBusy })).toBe(
          sessionSyncBusy({ working, streamBusy }),
        );
      }
    }
  });
});

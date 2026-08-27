import { describe, expect, test } from 'bun:test';
import {
  isControlTurnIdle,
  livenessBusy,
  sessionSyncBusy,
  splitKortixSessionScope,
  transcriptFallbackPollMs,
} from './use-session-sync';

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

  test('an offline tab never polls', () => {
    expect(
      livenessBusy({ networkEnabled: false, runtimeHealthy: true, working: true, streamBusy: true }),
    ).toBe(false);
  });

  /**
   * The feedback loop this whole file keeps paying for: the repair for a
   * broken stream was gated on the health probe, and the health probe is the
   * thing that flaps. A loaded box that misses its probe deadline mid-turn got
   * its transcript repair switched off at the exact moment the repair was
   * needed — and stayed off for as long as the probe kept missing.
   *
   * The probe does not decide this. A working session polls; if the box really
   * is unreachable the read fails, bounded, and costs one request per interval.
   */
  test('a failing health probe never switches the repair off', () => {
    expect(
      livenessBusy({
        networkEnabled: true,
        runtimeHealthy: false,
        working: true,
        streamBusy: false,
      }),
    ).toBe(true);
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

/**
 * A DEGRADED DAEMON MUST NEVER WEDGE THE COMPOSER.
 *
 * The wedge: the runtime channel delivers a `busy` frame (turn start) and then
 * dies before the matching `idle` — an old, slow, or crashed daemon — so
 * `streamBusy` latches `true` for the tab's whole life. The API's `/turn` (the
 * lifecycle authority, pushed on the control channel as `kortix.control.turn`)
 * already knows the turn ended. Control is daemon-independent, so its fresh
 * idle snapshot clears the latch.
 */
describe('sessionSyncBusy: the control turn snapshot clears a stale runtime busy', () => {
  test('stale streamBusy + fresh control idle → NOT busy (the wedge is broken)', () => {
    // No projection threaded (apps/mobile, a sub-session, a raw useSessionSync):
    // without the control input this returns `true` forever.
    expect(sessionSyncBusy({ working: undefined, streamBusy: true })).toBe(true);
    expect(
      sessionSyncBusy({ working: undefined, streamBusy: true, controlTurnIdle: true }),
    ).toBe(false);
  });

  test('control idle does NOT override a projection that KNOWS it is working', () => {
    // The projection folds the same control read PLUS the inbox and live
    // content (`projectWorking`); a definite `working: true` still wins.
    expect(
      sessionSyncBusy({ working: true, streamBusy: false, controlTurnIdle: true }),
    ).toBe(true); // working:true wins over control idle
    expect(
      sessionSyncBusy({ working: true, streamBusy: true, controlTurnIdle: true }),
    ).toBe(true);
  });

  test('no control snapshot yet → the old rule (stream slot / projection) stands', () => {
    expect(
      sessionSyncBusy({ working: undefined, streamBusy: true, controlTurnIdle: false }),
    ).toBe(true);
    expect(
      sessionSyncBusy({ working: undefined, streamBusy: false, controlTurnIdle: false }),
    ).toBe(false);
  });
});

describe('isControlTurnIdle (the daemon-independent authority read)', () => {
  const now = 1_000_000;
  test('an empty, fresh turn list is idle', () => {
    expect(isControlTurnIdle({ turns: [], atMs: now }, now)).toBe(true);
  });
  test('an OPEN turn is not idle — the runtime/projection decides then', () => {
    expect(
      isControlTurnIdle(
        { turns: [{ turn_token: 't1', message_id: null, started_at: null } as never], atMs: now },
        now,
      ),
    ).toBe(false);
  });
  test('a stale snapshot decides nothing (past SERVER_OBSERVATION_MAX_MS)', () => {
    expect(isControlTurnIdle({ turns: [], atMs: now - 46_000 }, now)).toBe(false);
  });
  test('no snapshot at all is not idle', () => {
    expect(isControlTurnIdle(undefined, now)).toBe(false);
  });
});

describe('splitKortixSessionScope', () => {
  test('splits the two UUIDs on the first slash', () => {
    expect(splitKortixSessionScope('proj-a/sess-b')).toEqual(['proj-a', 'sess-b']);
  });
  test('absent or malformed scope is inert (no ids → query never enables)', () => {
    expect(splitKortixSessionScope(undefined)).toEqual(['', '']);
    expect(splitKortixSessionScope('')).toEqual(['', '']);
    expect(splitKortixSessionScope('noslash')).toEqual(['', '']);
    expect(splitKortixSessionScope('/leading')).toEqual(['', '']);
    expect(splitKortixSessionScope('trailing/')).toEqual(['', '']);
  });
});

/**
 * The chicken-and-egg this input breaks (prod, 2026-08-26): a stale wire idle
 * frame can veto the server's open turn row in `projectWorking`, so the
 * projection answers `idle` over a session the control plane says is running.
 * `working: false` switched THIS poll off — and the poll's tail read is the
 * only evidence source that could have proven the runtime was still producing
 * output. One wrong answer froze the transcript for the rest of the turn.
 *
 * The control plane holding a turn open (`serverOpenTurnToken !== null`) is
 * server-owned evidence that work MAY be running, so it keeps the transcript
 * verification poll on even when the projection answers idle. It does NOT
 * touch the public `isBusy` — the UI's answer stays the projection's.
 */
describe('livenessBusy: an open server turn keeps the repair running', () => {
  test('idle projection + open server turn still polls', () => {
    expect(
      livenessBusy({
        networkEnabled: true,
        runtimeHealthy: true,
        working: false,
        streamBusy: false,
        serverHoldsTurn: true,
      }),
    ).toBe(true);
  });

  test('idle projection + no open turn stays off (unchanged)', () => {
    expect(
      livenessBusy({
        networkEnabled: true,
        runtimeHealthy: true,
        working: false,
        streamBusy: false,
        serverHoldsTurn: false,
      }),
    ).toBe(false);
  });

  test('an offline tab never polls, open turn or not', () => {
    expect(
      livenessBusy({
        networkEnabled: false,
        runtimeHealthy: true,
        working: false,
        streamBusy: false,
        serverHoldsTurn: true,
      }),
    ).toBe(false);
  });
});

describe('transcriptFallbackPollMs (retired — /events is the only transcript feed)', () => {
  // The transcript-poll fallback is GONE. It re-read `/kortix/opencode/messages`
  // whenever the runtime channel was not live — but that is exactly a box that
  // is down/rebuilding, whose daemon serves NEITHER `/events` NOR `/messages`
  // (they shipped together), so the poll only 404-spammed for nothing while the
  // user watched (dev, 2026-08-27). `/events` is the single transcript feed; a
  // real loss is a dense-seq gap the stream repairs exactly. This function now
  // never asks for a poll, whatever the state.
  test('never polls, in any state — the fallback is retired', () => {
    expect(transcriptFallbackPollMs({ busy: true, runtimeChannelLive: false })).toBeNull();
    expect(transcriptFallbackPollMs({ busy: true, runtimeChannelLive: true })).toBeNull();
    expect(transcriptFallbackPollMs({ busy: false, runtimeChannelLive: false })).toBeNull();
    expect(transcriptFallbackPollMs({ busy: false, runtimeChannelLive: true })).toBeNull();
  });
});

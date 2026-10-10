import { describe, expect, test } from 'bun:test';
import { createElement } from 'react';
import { act, create } from 'react-test-renderer';
import { getSessionSyncController } from '../browser/session-sync/session-sync-registry';
import { useSessionSync } from './use-session-sync';
import { livenessBusy, sessionSyncBusy } from './use-session-sync';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

test('an empty detached session does not start idle transcript verification', () => {
  const controller = getSessionSyncController('', undefined, 'none');
  const original = controller.setBusy;
  const calls: Array<[boolean, boolean | undefined]> = [];
  controller.setBusy = (busy, watchIdle) => {
    calls.push([busy, watchIdle]);
  };
  function Detached() {
    useSessionSync('');
    return null;
  }
  try {
    let renderer: ReturnType<typeof create> | undefined;
    act(() => {
      renderer = create(createElement(Detached));
    });
    expect(calls).toContainEqual([false, false]);
    act(() => renderer?.unmount());
  } finally {
    controller.setBusy = original;
  }
});

// `useSession({ chatEngine: false })` mounts `useSessionSync('')` and still
// passes its working projection. The empty controller must never go busy: a
// busy -> idle step starts a turn-end tail read, and a read for no session is a
// `GET /session//message` 400 that retries every 15 s for the life of the view.
test('a session with no runtime id never marks its controller busy, so no turn-end read starts', () => {
  const controller = getSessionSyncController('', undefined, 'none');
  const original = controller.setBusy;
  const calls: Array<[boolean, boolean | undefined]> = [];
  controller.setBusy = (busy, watchIdle) => {
    calls.push([busy, watchIdle]);
  };
  function Detached({ working }: { working: boolean }) {
    useSessionSync('', { working, networkEnabled: true });
    return null;
  }
  try {
    let renderer: ReturnType<typeof create> | undefined;
    act(() => {
      renderer = create(createElement(Detached, { working: true }));
    });
    act(() => renderer?.update(createElement(Detached, { working: false })));
    expect(calls.length).toBeGreaterThan(0);
    expect(calls.filter(([busy]) => busy)).toEqual([]);
    act(() => renderer?.unmount());
  } finally {
    controller.setBusy = original;
  }
});

// Several hooks share one controller per session (the page's useSession and an
// always-mounted export dialog). A hook that passes no `streamConnected` knows
// nothing about the stream and must not switch the verification poll back on
// for the hook that does: on dev the closed dialog's `false` won, and an idle
// tab read the transcript tail every 30 s while the stream was up.
test('a hook with no stream opinion never resets another hook\'s reliable stream', () => {
  const sessionId = 'ses_stream_owner_and_bystander';
  const controller = getSessionSyncController(sessionId, undefined, 'none');
  const original = controller.setStreamReliable;
  let reliable = false;
  controller.setStreamReliable = (value) => {
    reliable = value;
  };
  function Owner({ connected }: { connected: boolean }) {
    useSessionSync(sessionId, { streamConnected: connected });
    return null;
  }
  function Bystander() {
    useSessionSync(sessionId);
    return null;
  }
  function Page({ connected, owner }: { connected: boolean; owner: boolean }) {
    return createElement('div', null, owner ? createElement(Owner, { connected }) : null, createElement(Bystander));
  }
  try {
    let renderer: ReturnType<typeof create> | undefined;
    act(() => {
      renderer = create(createElement(Page, { connected: true, owner: true }));
    });
    expect(reliable).toBe(true);
    act(() => renderer?.update(createElement(Page, { connected: false, owner: true })));
    expect(reliable).toBe(false);
    act(() => renderer?.update(createElement(Page, { connected: true, owner: true })));
    expect(reliable).toBe(true);
    // The stream's owner leaves: nobody vouches for the stream any more.
    act(() => renderer?.update(createElement(Page, { connected: true, owner: false })));
    expect(reliable).toBe(false);
    act(() => renderer?.unmount());
  } finally {
    controller.setStreamReliable = original;
  }
});

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

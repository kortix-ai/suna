import { afterEach, describe, expect, test } from 'bun:test';
import { createElement } from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import {
  getSessionSyncController,
  resetSessionSyncControllers,
} from '../browser/session-sync/session-sync-registry';
import { useSyncStore } from '../browser/stores/sync-store';
import {
  livenessBusy,
  openTurnTokensEnded,
  sessionSyncBusy,
  useSessionSync,
} from './use-session-sync';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

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

/**
 * A queued prompt keeps the session busy across a turn boundary: turn A ends,
 * the server promotes prompt B, and the projection moves from A's open turn to
 * B's without ever answering idle. `setBusy(false)` never fires, so the
 * turn-end read that repairs A's truncated text never ran; only the 30 s
 * verify poll did. The boundary is visible in `/turn` instead: a token the
 * server listed as open is gone from the next read.
 *
 * The rule compares SETS. The ledger's list is not ordered newest-first, so a
 * reorder is not a boundary, and a turn that opens beside a running one ends
 * nothing.
 */
describe('openTurnTokensEnded', () => {
  test('a token that leaves the open set is a boundary', () => {
    expect(openTurnTokensEnded(['tok_A'], ['tok_B'])).toBe(true);
    expect(openTurnTokensEnded(['tok_A'], [])).toBe(true);
    expect(openTurnTokensEnded(['tok_A', 'tok_B'], ['tok_B'])).toBe(true);
  });

  test('no token left the open set: not a boundary', () => {
    expect(openTurnTokensEnded([], ['tok_B'])).toBe(false);
    expect(openTurnTokensEnded(['tok_A', 'tok_B'], ['tok_B', 'tok_A'])).toBe(false);
    expect(openTurnTokensEnded(['tok_A'], ['tok_A', 'tok_B'])).toBe(false);
    expect(openTurnTokensEnded(['tok_A'], ['tok_A'])).toBe(false);
  });

  test('an unknown set on either side is never a boundary', () => {
    expect(openTurnTokensEnded(undefined, ['tok_A'])).toBe(false);
    expect(openTurnTokensEnded(null, ['tok_A'])).toBe(false);
    expect(openTurnTokensEnded(['tok_A'], undefined)).toBe(false);
    expect(openTurnTokensEnded(['tok_A'], null)).toBe(false);
  });
});

describe('useSessionSync: a turn boundary while the session stays busy', () => {
  let root: ReactTestRenderer | undefined;

  afterEach(async () => {
    if (root) await act(async () => root?.unmount());
    root = undefined;
    resetSessionSyncControllers();
  });

  /** Mounts the hook against a controller whose runtime answers every tail
   *  read with an empty page, and counts those reads. */
  async function mountBusySession(sessionId: string, openTurnTokens: readonly string[] | undefined) {
    let reads = 0;
    useSyncStore.getState().clearSession(sessionId);
    // No current runtime in this test, so the hook resolves the 'none' scope.
    getSessionSyncController(
      sessionId,
      {
        session: {
          messages: async () => {
            reads += 1;
            return { data: [] };
          },
        },
      },
      'none',
    );
    function Probe(props: { tokens: readonly string[] | undefined; working: boolean }) {
      useSessionSync(sessionId, { working: props.working, openTurnTokens: props.tokens });
      return null;
    }
    await act(async () => {
      root = create(createElement(Probe, { tokens: openTurnTokens, working: true }));
    });
    const rerender = async (tokens: readonly string[] | undefined, working = true) => {
      await act(async () => {
        root?.update(createElement(Probe, { tokens, working }));
        await Bun.sleep(5);
      });
    };
    return { reads: () => reads, rerender };
  }

  test('open set [A] -> [B] with working still true issues exactly one transcript read', async () => {
    const session = await mountBusySession('ses_boundary_a_b', ['tok_A']);
    expect(session.reads()).toBe(0);

    await session.rerender(['tok_B']);

    expect(session.reads()).toBe(1);
  });

  test('guard: a reorder of the open set issues no read', async () => {
    const session = await mountBusySession('ses_boundary_reorder', ['tok_A', 'tok_B']);

    await session.rerender(['tok_B', 'tok_A']);

    expect(session.reads()).toBe(0);
  });

  // The busy-to-idle switch already issues the turn-end read. A second
  // turn-end call during that read would chain one more read behind it.
  test('guard: a boundary that also ends the busy state issues one read, not two', async () => {
    const session = await mountBusySession('ses_boundary_idle', ['tok_A']);

    await session.rerender([], false);

    expect(session.reads()).toBe(1);
  });

  test('an unknown read between two known sets still compares the known sets', async () => {
    const session = await mountBusySession('ses_boundary_unknown', ['tok_A']);

    await session.rerender(undefined);
    expect(session.reads()).toBe(0);
    await session.rerender(['tok_B']);

    expect(session.reads()).toBe(1);
  });
});

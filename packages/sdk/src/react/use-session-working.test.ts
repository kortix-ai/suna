import { describe, expect, test } from 'bun:test';
import {
  SERVER_OBSERVATION_MAX_MS,
  projectWorking,
  workingExpiryAtMs,
} from '../core/session/working';
import {
  WORKING_POLL_ACTIVE_MS,
  WORKING_POLL_IDLE_MS,
  buildWorkingInputs,
  workingPollMs,
} from './use-session-working';

const T0 = Date.parse('2026-08-18T10:00:00.000Z');

describe('workingPollMs', () => {
  test('a working session is polled fast — the end of the turn is the news', () => {
    expect(
      workingPollMs({ state: 'working', source: 'server', turnId: 'msg_1', since: T0, serverOpenTurnToken: 'tt-1' }),
    ).toBe(WORKING_POLL_ACTIVE_MS);
  });

  test('an idle session still polls, slowly — a turn can start without this tab', () => {
    // A trigger, a second device, or the inbox delivering a queued prompt all
    // start turns nobody here asked for. `false` would mean only a reload
    // ever shows them.
    expect(workingPollMs({ state: 'idle', source: 'server', turnId: null, since: T0, serverOpenTurnToken: null })).toBe(
      WORKING_POLL_IDLE_MS,
    );
    expect(WORKING_POLL_IDLE_MS).toBeGreaterThan(WORKING_POLL_ACTIVE_MS);
  });

  test('an unanswered optimistic receipt polls at the fast cadence', () => {
    // It is the one state that MUST resolve quickly: the projection is
    // running on this tab's own word until a server source answers.
    expect(
      workingPollMs({ state: 'working', source: 'optimistic', turnId: 'msg_1', since: T0, serverOpenTurnToken: null }),
    ).toBe(WORKING_POLL_ACTIVE_MS);
  });
});

describe('buildWorkingInputs', () => {
  test('a first /turn read that never succeeded contributes NOTHING', () => {
    // A 404/500 with no prior success leaves `turn` undefined. The old machine
    // answered silence with a busy latch; this one answers it with nothing.
    const inputs = buildWorkingInputs({
      turn: undefined,
      inbox: undefined,
      status: undefined,
      statusAtMs: 0,
      optimistic: null,
      nowMs: T0,
    });

    expect(inputs.server).toBeNull();
    expect(inputs.stream).toBeNull();
    expect(projectWorking(inputs).state).toBe('idle');
  });

  test('a read RETAINED from before a run of failures stops deciding', () => {
    // react-query keeps the last successful `data` while every read after it
    // fails, so `turn` is NOT undefined in the failure case the hook actually
    // produces — it is an old open turn. This is the shape that latched the
    // composer on "working" until the tab was reloaded.
    const turn = {
      turns: [
        {
          turn_token: 'tt-1',
          state: 'active' as const,
          message_id: 'msg_01',
          opencode_session_id: 'ses_01',
          started_at: new Date(T0).toISOString(),
          accepted_at: null,
        },
      ],
      atMs: T0,
    };

    expect(
      projectWorking(
        buildWorkingInputs({
          turn,
          inbox: undefined,
          status: undefined,
          statusAtMs: 0,
          optimistic: null,
          nowMs: T0 + 1_000,
        }),
      ).state,
    ).toBe('working');

    expect(
      projectWorking(
        buildWorkingInputs({
          turn,
          inbox: undefined,
          status: undefined,
          statusAtMs: 0,
          optimistic: null,
          nowMs: T0 + SERVER_OBSERVATION_MAX_MS + 1,
        }),
      ).state,
    ).toBe('idle');
  });

  test('the durable inbox reading is carried through', () => {
    const inputs = buildWorkingInputs({
      turn: { turns: [], atMs: T0 },
      inbox: { pending: 2, atMs: T0 },
      status: undefined,
      statusAtMs: 0,
      optimistic: null,
      nowMs: T0,
    });

    expect(inputs.inbox).toEqual({ pending: 2, atMs: T0 });
    // A prompt the server holds but has not turned into a turn yet is still
    // this user's work in flight.
    expect(projectWorking(inputs).state).toBe('working');
  });

  test('a turn read is carried through with the instant it was ISSUED', () => {
    const inputs = buildWorkingInputs({
      turn: { turns: [], last_ended: undefined, atMs: T0 - 500 },
      inbox: undefined,
      status: undefined,
      statusAtMs: 0,
      optimistic: null,
      nowMs: T0,
    });

    expect(inputs.server).toEqual({ turns: [], lastEnded: undefined, atMs: T0 - 500 });
  });

  test('busy and retry frames are working; every other status is idle', () => {
    const at = (status: { type: string } | undefined) =>
      buildWorkingInputs({
        turn: undefined,
        inbox: undefined,
        status: status as never,
        statusAtMs: T0,
        optimistic: null,
        nowMs: T0,
      }).stream;

    expect(at({ type: 'busy' })).toEqual({ type: 'busy', atMs: T0 });
    expect(at({ type: 'retry' })).toEqual({ type: 'retry', atMs: T0 });
    expect(at({ type: 'idle' })).toEqual({ type: 'idle', atMs: T0 });
    // No status frame observed at all is NOT an idle frame — silence is not
    // an observation, and treating it as one is how a live turn got unmasked.
    expect(at(undefined)).toBeNull();
  });

  test('the stop receipt is passed through, so a doomed turn stops deciding', () => {
    // `handleStop` paints idle and issues the cancel; the daemon needs ~1.6s.
    // Every `/turn` read in that window still reports the turn — including the
    // one the optimistic idle FRAME triggers — so without the receipt the
    // composer flipped Send back to Stop about 120ms after the click.
    const inputs = buildWorkingInputs({
      turn: {
        turns: [
          {
            turn_token: 'tt-1',
            state: 'active' as const,
            message_id: 'msg_01',
            opencode_session_id: 'ses_01',
            started_at: new Date(T0).toISOString(),
            accepted_at: null,
          },
        ],
        atMs: T0 + 2,
      },
      inbox: undefined,
      status: { type: 'idle' } as never,
      statusAtMs: T0,
      optimistic: null,
      abort: { atMs: T0, settledAtMs: null },
      nowMs: T0 + 120,
    });

    expect(inputs.abort).toEqual({ atMs: T0, settledAtMs: null });
    expect(projectWorking(inputs).state).toBe('idle');
  });

  test('the expiry the hook arms its timer on comes from the same inputs', () => {
    // The hook re-renders when react-query hands it new `data` — and a run of
    // failed reads hands back the SAME retained `data`, so it does not
    // re-render at all. `SERVER_OBSERVATION_MAX_MS` was only ever evaluated
    // during a render, which in that exact outage never happened again.
    const inputs = buildWorkingInputs({
      turn: { turns: [], atMs: T0 },
      inbox: undefined,
      status: undefined,
      statusAtMs: 0,
      optimistic: null,
      abort: null,
      nowMs: T0 + 1_000,
    });

    expect(workingExpiryAtMs(inputs)).toBe(T0 + SERVER_OBSERVATION_MAX_MS);
  });

  test('the optimistic receipt is passed through untouched', () => {
    const receipt = { messageId: 'msg_42', atMs: T0 };
    expect(
      buildWorkingInputs({
        turn: undefined,
        inbox: undefined,
        status: undefined,
        statusAtMs: 0,
        optimistic: receipt,
        nowMs: T0 + 10,
      }).optimistic,
    ).toEqual(receipt);
  });
});

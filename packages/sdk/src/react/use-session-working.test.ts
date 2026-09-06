import { describe, expect, mock, test } from 'bun:test';
import type { SessionStatus } from '@opencode-ai/sdk/v2/client';
import { useSyncStore } from '../browser/stores/sync-store';
import {
  SERVER_OBSERVATION_MAX_MS,
  STREAM_OBSERVATION_MAX_MS,
  projectWorking,
  workingExpiryAtMs,
} from '../core/session/working';
import { openSessionBundle, resetSessionOpenBundles } from '../core/session/open-bundle';
import { configureKortix } from '../core/http/config';
import {
  WORKING_POLL_ACTIVE_MS,
  readSessionTurnObservation,
  WORKING_POLL_IDLE_MS,
  buildWorkingInputs,
  workingPollMs,
  streamObservationStamp,
  streamTurnPhase,
} from './use-session-working';

const T0 = Date.parse('2026-08-18T10:00:00.000Z');

configureKortix({ backendUrl: 'http://test.local', getToken: async () => 'tok' });

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

  test('only an explicit idle frame is idle; unknown runtime states fail safe as working', () => {
    const at = (status: { type: string } | undefined) =>
      buildWorkingInputs({
        turn: undefined,
        inbox: undefined,
        status: status as never,
        statusAtMs: T0,
        optimistic: null,
        nowMs: T0,
      }).stream;

    // `origin: 'wire'` is the default: an unmarked frame is the runtime's own,
    // and only `sessionStatusOrigin` (threaded via `statusOrigin`) demotes one
    // to `'local'`.
    expect(at({ type: 'busy' })).toEqual({ type: 'busy', origin: 'wire', atMs: T0 });
    expect(at({ type: 'retry' })).toEqual({ type: 'retry', origin: 'wire', atMs: T0 });
    expect(at({ type: 'idle' })).toEqual({ type: 'idle', origin: 'wire', atMs: T0 });
    // Runtime adapters must speak the OpenCode vocabulary, but a newer or
    // malformed active state must not hide the user's Stop control.
    expect(at({ type: 'running' })).toEqual({ type: 'busy', origin: 'wire', atMs: T0 });
    expect(at({ type: 'compacting' })).toEqual({ type: 'busy', origin: 'wire', atMs: T0 });
    // No status frame observed at all is NOT an idle frame — silence is not
    // an observation, and treating it as one is how a live turn got unmasked.
    expect(at(undefined)).toBeNull();
  });

  test('an unknown active status cannot hide a long server-authorized turn', () => {
    const nowMs = T0 + STREAM_OBSERVATION_MAX_MS + 1;
    const inputs = buildWorkingInputs({
      turn: {
        turns: [
          {
            turn_token: 'tt-pi',
            state: 'active' as const,
            message_id: 'msg-pi',
            opencode_session_id: 'ses-pi',
            started_at: new Date(T0).toISOString(),
            accepted_at: null,
          },
        ],
        atMs: nowMs,
      },
      inbox: undefined,
      status: { type: 'running' } as never,
      statusAtMs: T0,
      activityAtMs: T0,
      optimistic: null,
      nowMs,
    });

    expect(projectWorking(inputs)).toMatchObject({
      state: 'working',
      source: 'server',
      serverOpenTurnToken: 'tt-pi',
    });
  });

  test('a local origin is threaded through to the stream input', () => {
    // The fabricators (`markSessionIdleLocally`, `clearSession`, the hydrate
    // snapshot) write `'local'` into `sessionStatusOrigin`; the hook passes it
    // here, and `projectWorking` then refuses to let the frame contradict the
    // server's open turn. Dropping the field on this seam would silently
    // restore the fabricated-idle veto.
    const inputs = buildWorkingInputs({
      turn: undefined,
      inbox: undefined,
      status: { type: 'idle' } as never,
      statusAtMs: T0,
      statusOrigin: 'local',
      optimistic: null,
      nowMs: T0,
    });

    expect(inputs.stream).toEqual({ type: 'idle', origin: 'local', atMs: T0 });
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

/**
 * The latch, reproduced end to end across the two modules that make it.
 *
 * `useSessionWorking` stamps a stream observation in an effect keyed on the
 * status object's IDENTITY (`[status, streamKey]`), so a writer that re-parses
 * an equal-valued status every tick re-stamps `atMs` every tick, and
 * `STREAM_OBSERVATION_MAX_MS` — the bound that stops a dead stream from
 * deciding — is never reached. The liveness poll did exactly that: it read the
 * runtime's status over REST and wrote the result into the same slot SSE frames
 * land in, minting a fresh object each time.
 *
 * `stampObservation` below is the hook's effect, in one line: it re-stamps only
 * when identity moves.
 */
describe('an equal-valued status rewrite is not a new observation', () => {
  function stampObservation(
    previous: { status: SessionStatus; atMs: number } | null,
    status: SessionStatus | undefined,
    nowMs: number,
  ): { status: SessionStatus; atMs: number } | null {
    if (!status) return null;
    if (previous && previous.status === status) return previous;
    return { status, atMs: nowMs };
  }

  test('20 equal writes are ONE observation, and the projection ages out of it', () => {
    useSyncStore.getState().reset();
    let observed: { status: SessionStatus; atMs: number } | null = null;
    for (let tick = 0; tick < 20; tick++) {
      // The poll's cadence — each write re-parses a fresh, equal-valued object.
      useSyncStore.getState().setStatus('ses_1', { type: 'busy' });
      const status = useSyncStore.getState().sessionStatus.ses_1 as SessionStatus | undefined;
      observed = stampObservation(observed, status, T0 + tick * 10_000);
    }

    // ONE stamp, taken at the first write — 190s of polling did not move it.
    expect(observed?.atMs).toBe(T0);

    const inputsAt = (nowMs: number) =>
      buildWorkingInputs({
        turn: undefined, // `getSessionTurn` is failing — the outage this bound is for.
        inbox: undefined,
        status: observed?.status,
        statusAtMs: observed?.atMs ?? 0,
        optimistic: null,
        nowMs,
      });

    expect(projectWorking(inputsAt(T0 + 1_000)).state).toBe('working');
    expect(projectWorking(inputsAt(T0 + STREAM_OBSERVATION_MAX_MS + 1)).state).toBe('idle');
    expect(workingExpiryAtMs(inputsAt(T0 + 1_000))).toBe(T0 + STREAM_OBSERVATION_MAX_MS);
  });
});

/**
 * The SSE-triggered refetch used to fire on EVERY status frame, and the runtime
 * does not emit one frame per turn.
 *
 * MEASURED on the local stack 2026-08-21, mid-turn, one session: the status
 * alternated `busy` → `retry` → `busy` roughly every 140ms. Each flip minted a
 * new observation instant, and the effect keyed on that instant invalidated
 * BOTH `GET .../turn` and `GET .../prompts` — times the three mounts that
 * observe one session (`useSession`, the composer, the session panel). None of
 * it was news: a `busy`→`retry` flip says nothing whatsoever about whether the
 * control plane still holds a turn open.
 *
 * What IS news is the turn boundary, and that is a change of PHASE.
 */
/**
 * Where a status frame's freshness stamp comes from.
 *
 * The hook used to stamp `Date.now()` at the moment ITS effect observed the
 * slot. On a remount — navigate away and back, a route-level remount — the
 * observation state resets and the effect re-stamps whatever the store still
 * holds, so a dead stream's last idle frame came back looking brand new and
 * vetoed the open `/turn` row for another full freshness window. The store now
 * records when the frame actually LANDED (`sessionStatusAt`), and that stamp —
 * never the observation instant — is the frame's age. The fallback exists only
 * for a slot written before the stamp slice existed (test fixtures, mixed
 * versions); it preserves the old behavior there.
 */
describe('streamObservationStamp', () => {
  test('the store stamp is the observation instant when it exists', () => {
    expect(streamObservationStamp(12_345, 99_999)).toBe(12_345);
  });

  test('without a store stamp, the observer clock fills in (old behavior)', () => {
    expect(streamObservationStamp(undefined, 99_999)).toBe(99_999);
  });

  test('a zero store stamp is not "missing"', () => {
    expect(streamObservationStamp(0, 99_999)).toBe(0);
  });
});

describe('streamTurnPhase', () => {
  test('busy and retry are one phase — the turn is running either way', () => {
    expect(streamTurnPhase({ type: 'busy' } as SessionStatus)).toBe('active');
    expect(streamTurnPhase({ type: 'retry' } as unknown as SessionStatus)).toBe('active');
  });

  test('idle is its own phase — this is the end-of-turn edge worth a refetch', () => {
    expect(streamTurnPhase({ type: 'idle' } as SessionStatus)).toBe('idle');
  });

  test('no frame observed is not a phase, and must not pose as idle', () => {
    // Silence is not an observation anywhere else in this file either; a
    // session with no frame yet has to stay distinguishable from an idle one,
    // or the first frame of a turn would not read as a change.
    expect(streamTurnPhase(undefined)).toBe('none');
  });
});

// ── The session-open bundle seam ────────────────────────────────────────────
// `/turn` was read up to 6 times during ONE session open (measured, 20 opens):
// three hooks mount this query, and the open path reads it before anything else
// can. The read now claims the open bundle first, so the whole open costs the
// server ONE answer, and the poll that follows still goes to the endpoint.

describe('readSessionTurnObservation', () => {
  const BUNDLE_AT = '2026-08-26T12:00:00.000Z';

  function mockFetch(body: (url: string) => unknown) {
    const urls: string[] = [];
    globalThis.fetch = mock(async (url: unknown) => {
      urls.push(String(url));
      return new Response(JSON.stringify(body(String(url))), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }) as unknown as typeof fetch;
    return urls;
  }

  test('answers from the open bundle without touching /turn', async () => {
    resetSessionOpenBundles();
    const urls = mockFetch(() => ({
      observed_at: BUNDLE_AT,
      turn: { known: true, turns: [{ turn_token: 'tt-1', state: 'active' }] },
      queue: { known: true, prompts: [], held: false },
      transcript: { known: true, requested: false },
      config: { known: true },
      models: { known: false, reason: 'llm_gateway_disabled' },
      session: { session_id: 'S1' },
    }));
    openSessionBundle('P1', 'S1');
    const observation = await readSessionTurnObservation('P1', 'S1');
    expect(urls.filter((u) => u.endsWith('/turn'))).toHaveLength(0);
    expect(observation.turns).toHaveLength(1);
    // Stamped from the SERVER's clock. Stamping arrival would let a shared
    // bundle claim to be newer than the read it came from.
    expect(observation.atMs).toBe(Date.parse(BUNDLE_AT));
  });

  test('reads /turn when no bundle is in flight — the steady-state poll', async () => {
    resetSessionOpenBundles();
    const urls = mockFetch(() => ({ turns: [], last_ended: { turn_token: 'tt-0', end_reason: 'completed', ended_at: null } }));
    const observation = await readSessionTurnObservation('P1', 'S1');
    expect(urls).toHaveLength(1);
    expect(urls[0]).toContain('/sessions/S1/turn');
    expect(observation.turns).toEqual([]);
    expect(observation.last_ended?.turn_token).toBe('tt-0');
  });

  test('falls back to /turn when the bundle could not answer that leg', async () => {
    resetSessionOpenBundles();
    const urls = mockFetch((url) =>
      url.includes('/snapshot')
        ? {
            observed_at: BUNDLE_AT,
            turn: { known: false, reason: 'turn read exploded' },
            queue: { known: true, prompts: [], held: false },
            transcript: { known: true, requested: false },
            config: { known: true },
            models: { known: false, reason: 'x' },
            session: { session_id: 'S1' },
          }
        : { turns: [{ turn_token: 'tt-2', state: 'delivering' }] },
    );
    openSessionBundle('P1', 'S1');
    const observation = await readSessionTurnObservation('P1', 'S1');
    // UNKNOWN is not idle: the fallback must ASK, not assume.
    expect(urls.some((u) => u.endsWith('/turn'))).toBe(true);
    expect(observation.turns[0]?.turn_token).toBe('tt-2');
  });
});

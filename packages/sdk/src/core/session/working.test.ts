import { describe, expect, test } from 'bun:test';
import type { SessionPrompt, SessionTurn } from '../rest/projects-client/sessions';
import {
  INBOX_OBSERVATION_MAX_MS,
  OPTIMISTIC_ABORT_MAX_MS,
  OPTIMISTIC_RECEIPT_MAX_MS,
  SERVER_OBSERVATION_MAX_MS,
  STREAM_OBSERVATION_MAX_MS,
  TURN_END_LEDGER_LAG_MS,
  countLiveInboxPrompts,
  projectWorking,
  workingExpiryAtMs,
} from './working';

const T0 = Date.parse('2026-08-18T10:00:00.000Z');

function turn(overrides: Partial<SessionTurn> = {}): SessionTurn {
  return {
    turn_token: 'tt-1',
    state: 'active',
    message_id: 'msg_01',
    opencode_session_id: 'ses_01',
    started_at: new Date(T0).toISOString(),
    accepted_at: null,
    ...overrides,
  };
}

/**
 * One projection, one precedence table. Every case below used to be answered by
 * a different machine — a stall timer here, a 30s safety timeout there, a busy
 * latch in a third file — and they disagreed, which is how a session stayed
 * "working" until the user reloaded the page.
 */
describe('projectWorking', () => {
  test('a turn the server is holding open outranks every OLDER observation', () => {
    // The turn STARTS AFTER the last idle frame — which is what "the ledger
    // knows something the stream has not reported yet" actually looks like on
    // the wire. This test used to start the turn at T0, BEFORE the T0+1s idle
    // frame, and still assert `working`; that is the defect this file's
    // "a runtime idle frame ends the turn it names" block was written for, in
    // miniature, so the scenario moved rather than the intent.
    const started = T0 + 2_000;
    const projection = projectWorking({
      optimistic: { messageId: 'msg_99', atMs: T0 + 5_000 },
      server: {
        turns: [turn({ started_at: new Date(started).toISOString() })],
        atMs: T0 + 4_000,
      },
      stream: { type: 'idle', atMs: T0 + 1_000 },
      nowMs: T0 + 5_000,
    });

    expect(projection).toEqual({
      state: 'working',
      source: 'server',
      turnId: 'msg_01',
      since: started,
      serverOpenTurnToken: 'tt-1',
    });
  });

  test('a turn delivered with no wire messageID is still an open turn', () => {
    // `message_id` is the WIRE id of the prompt that opened the turn, and most
    // producers send none: `postPrompt` omits `messageID` for triggers, Slack /
    // Teams / Telegram, approval-resume and email, and `buildSessionCommandInput`
    // omits it for EVERY `/` command including `/compact`. `GET .../turn` then
    // answers `message_id: null` (`r8.ts` — the field is `z.string().nullable()`)
    // for a turn that is very much running. Reporting the open turn off that
    // field answered "the control plane holds nothing" for that whole class.
    // `turn_token` is minted for every turn and is never null.
    const projection = projectWorking({
      optimistic: null,
      server: { turns: [turn({ message_id: null })], atMs: T0 },
      stream: null,
      nowMs: T0 + 1_000,
    });

    expect(projection.state).toBe('working');
    expect(projection.source).toBe('server');
    // The wire id is honestly absent…
    expect(projection.turnId).toBeNull();
    // …and the authority is just as honestly present.
    expect(projection.serverOpenTurnToken).toBe('tt-1');
  });

  test('a NEWER stream idle ends a turn the last poll still saw open', () => {
    // The turn ended between polls: the daemon relayed `turn_end`, the control
    // plane cleared the authority, and the `session.idle` frame landed — all
    // while the cached `/turn` read still says "open". Letting the cached read
    // win kept the composer on Stop for a whole poll interval, and made
    // `rewind()` throw "Cannot rewind a busy session" right after the reply.
    const projection = projectWorking({
      optimistic: null,
      server: { turns: [turn()], atMs: T0 },
      stream: { type: 'idle', atMs: T0 + 4_900 },
      nowMs: T0 + 4_900,
    });

    expect(projection.state).toBe('idle');
    expect(projection.source).toBe('stream');
    // The read the stream just overruled is still REPORTED, because a caller
    // can need the raw fact ("the control plane is holding a turn open") even
    // when a fresher frame decides the state — see `serverOpenTurnToken`.
    expect(projection.serverOpenTurnToken).toBe('tt-1');
  });

  test('a server open turn nothing has refreshed for a minute stops deciding', () => {
    // `GET .../turn` started failing (503 node drain, expired JWT, offline
    // laptop) and react-query keeps handing back the last SUCCESSFUL read.
    // Without a bound that read latches `working` for the lifetime of the tab —
    // the exact "stuck working forever" symptom this projection exists to end.
    const projection = projectWorking({
      optimistic: null,
      server: { turns: [turn()], atMs: T0 },
      stream: null,
      nowMs: T0 + SERVER_OBSERVATION_MAX_MS + 1,
    });

    // Still true, and still the point of the bound: a stale read may not CLAIM
    // the session is working. Nothing here changes that.
    expect(projection.state).toBe('idle');
    expect(projection.turnId).toBeNull();

    // INVERTED. This used to assert `null`, on the reasoning that "a read too
    // old to decide is too old to REPORT an open turn from either". That
    // conflated two different things — refusing to DECIDE on stale data, and
    // refusing to keep LOOKING — and it made the projection self-sealing.
    //
    // `serverOpenTurnToken` is not a verdict. It feeds `serverHoldsTurn`
    // (use-session.ts) -> `livenessBusy` (use-session-sync.ts) -> the transcript
    // fallback poll. Nulling it on staleness switched off the one mechanism
    // that could have produced fresh evidence, so a wrong idle could never be
    // discovered and the UI stayed wrong for the rest of the turn. Measured on a
    // live stack: opencode still writing, the ledger row still `active` after
    // nine minutes, and the composer showing the send arrow.
    //
    // The row is retired by end-of-turn evidence, never by the age of a read.
    // Refuse to decide; never refuse to look.
    expect(projection.serverOpenTurnToken).toBe('tt-1');
  });

  test('a stale server read cannot declare idle either — it decides nothing', () => {
    const projection = projectWorking({
      optimistic: null,
      server: { turns: [], atMs: T0 },
      stream: { type: 'busy', atMs: T0 + SERVER_OBSERVATION_MAX_MS },
      nowMs: T0 + SERVER_OBSERVATION_MAX_MS + 1,
    });

    expect(projection.state).toBe('working');
    expect(projection.source).toBe('stream');
  });

  test('a stream frame nothing has refreshed for its own bound stops deciding too', () => {
    // The failure the server bound was written for does NOT produce
    // `stream: null` — the SSE stream is proxied through the same API that
    // serves `/turn`, so when the API drains BOTH stop refreshing and the last
    // `busy` frame this tab ever saw stays in the store. Bounding only the
    // server read left that frame deciding `working` for the lifetime of the
    // tab: the same latch, one source over.
    const projection = projectWorking({
      optimistic: null,
      server: { turns: [turn()], atMs: T0 },
      stream: { type: 'busy', atMs: T0 },
      nowMs: T0 + STREAM_OBSERVATION_MAX_MS + 1,
    });

    expect(projection.state).toBe('idle');
    expect(projection.turnId).toBeNull();
  });

  test('a turn with no recorded start instant is still running', () => {
    // Legacy authority record: a missing timestamp is not a reason to read a
    // live turn as idle. The observation instant stands in for the start.
    const projection = projectWorking({
      optimistic: null,
      server: { turns: [turn({ started_at: null })], atMs: T0 + 1_000 },
      stream: null,
      nowMs: T0 + 1_000,
    });

    expect(projection).toEqual({
      state: 'working',
      source: 'server',
      turnId: 'msg_01',
      since: T0 + 1_000,
      serverOpenTurnToken: 'tt-1',
    });
  });

  test('an empty server turn list is idle, dated by how the last turn ended', () => {
    const projection = projectWorking({
      optimistic: null,
      server: {
        turns: [],
        lastEnded: {
          turn_token: 'tt-0',
          end_reason: 'completed',
          ended_at: new Date(T0 - 2_000).toISOString(),
        },
        atMs: T0,
      },
      stream: null,
      nowMs: T0,
    });

    expect(projection).toEqual({
      state: 'idle',
      source: 'server',
      turnId: null,
      since: T0 - 2_000,
      serverOpenTurnToken: null,
    });
  });

  test('a server idle NEWER than a stream busy wins', () => {
    // The turn ended, the last SSE frame this tab saw is the busy one from
    // inside it, and the frame that would have corrected it was dropped. The
    // server read is newer, so it answers.
    const projection = projectWorking({
      optimistic: null,
      server: { turns: [], atMs: T0 + 10_000 },
      stream: { type: 'busy', atMs: T0 + 1_000 },
      nowMs: T0 + 10_000,
    });

    expect(projection.state).toBe('idle');
    expect(projection.source).toBe('server');
    expect(projection.since).toBe(T0 + 10_000);
  });

  test('a stream busy NEWER than a server idle wins', () => {
    const projection = projectWorking({
      optimistic: null,
      server: { turns: [], atMs: T0 },
      stream: { type: 'busy', atMs: T0 + 500 },
      nowMs: T0 + 600,
    });

    expect(projection).toEqual({
      state: 'working',
      source: 'stream',
      turnId: null,
      since: T0 + 500,
      serverOpenTurnToken: null,
    });
  });

  test('a stream retry is still working — the provider is backing off, not done', () => {
    const projection = projectWorking({
      optimistic: null,
      server: null,
      stream: { type: 'retry', atMs: T0 },
      nowMs: T0 + 100,
    });

    expect(projection.state).toBe('working');
    expect(projection.source).toBe('stream');
  });

  test('a stream idle with no server answer is idle', () => {
    const projection = projectWorking({
      optimistic: null,
      server: null,
      stream: { type: 'idle', atMs: T0 },
      nowMs: T0 + 100,
    });

    expect(projection).toEqual({
      state: 'idle',
      source: 'stream',
      turnId: null,
      since: T0,
      serverOpenTurnToken: null,
    });
  });

  test('an unanswered optimistic receipt claims working, tagged as optimistic', () => {
    const projection = projectWorking({
      optimistic: { messageId: 'msg_42', atMs: T0 },
      server: null,
      stream: null,
      nowMs: T0 + 1_000,
    });

    expect(projection).toEqual({
      state: 'working',
      source: 'optimistic',
      turnId: 'msg_42',
      since: T0,
      serverOpenTurnToken: null,
    });
  });

  test('an observation ISSUED BEFORE the receipt cannot answer for it', () => {
    // The read went out before the user pressed send, so its "no turns" is
    // honest and irrelevant. Deciding idle here is the flicker that made the
    // composer usable again mid-send.
    const projection = projectWorking({
      optimistic: { messageId: 'msg_42', atMs: T0 + 1_000 },
      server: { turns: [], atMs: T0 },
      stream: { type: 'idle', atMs: T0 + 500 },
      nowMs: T0 + 1_200,
    });

    expect(projection.state).toBe('working');
    expect(projection.source).toBe('optimistic');
  });

  test('a server read cannot answer for a send the server has not accepted yet', () => {
    // `POST .../prompts` is still on the wire. A `/turn` read issued in that
    // window is stamped AFTER the receipt and honestly returns no turns —
    // because there is nothing for it to see yet. Letting it answer swapped
    // Stop back to Send in the middle of the send, and opened the queue drain.
    const projection = projectWorking({
      optimistic: { messageId: 'msg_42', atMs: T0, acceptedAtMs: null },
      server: { turns: [], atMs: T0 + 1_000 },
      stream: { type: 'idle', atMs: T0 - 500 },
      nowMs: T0 + 1_100,
    });

    expect(projection.state).toBe('working');
    expect(projection.source).toBe('optimistic');
  });

  test('a server read issued after the ACCEPTANCE answers it — idle wins immediately', () => {
    const projection = projectWorking({
      optimistic: { messageId: 'msg_42', atMs: T0, acceptedAtMs: T0 + 300 },
      server: { turns: [], atMs: T0 + 1_000 },
      stream: null,
      nowMs: T0 + 1_100,
    });

    expect(projection.state).toBe('idle');
    expect(projection.source).toBe('server');
  });

  test('a durable inbox prompt reads as working, with no turn and no receipt', () => {
    // Between "the row is durable" and "the turn is open" the box may still be
    // resuming — 18.9s on Daytona, 24.5s on Platinum, measured. `GET .../turn`
    // truthfully answers "no turns" for all of it. The prompt is still the
    // user's work in flight, so the composer must stay on Stop.
    const projection = projectWorking({
      optimistic: null,
      inbox: { pending: 1, atMs: T0 + 1_000 },
      server: { turns: [], atMs: T0 + 5_000 },
      stream: { type: 'idle', atMs: T0 + 5_000 },
      nowMs: T0 + 5_100,
    });

    expect(projection).toEqual({
      state: 'working',
      source: 'server',
      turnId: null,
      since: T0 + 1_000,
      serverOpenTurnToken: null,
    });
  });

  test('an inbox reading nobody has refreshed stops deciding on ITS own bound', () => {
    // Three prompt-list cadences, not three `/turn` cadences. The list polls at
    // 3s while rows exist, so a reading that has survived 10s is one the poll
    // failed to refresh — and a delivered row that has since run reads as
    // pending for as long as this stands. Holding it for the server bound (45s)
    // left the composer on Stop with the reply already on screen, and
    // `rewind()` throwing "Cannot rewind a busy session" on the Edit under it.
    const stale = {
      optimistic: null,
      inbox: { pending: 1, atMs: T0 },
      server: { turns: [], atMs: T0 + 2_100 },
      stream: { type: 'idle' as const, atMs: T0 + 2_000 },
    };

    expect(projectWorking({ ...stale, nowMs: T0 + INBOX_OBSERVATION_MAX_MS }).state).toBe('working');
    expect(projectWorking({ ...stale, nowMs: T0 + INBOX_OBSERVATION_MAX_MS + 1 }).state).toBe(
      'idle',
    );
    expect(INBOX_OBSERVATION_MAX_MS).toBeLessThan(SERVER_OBSERVATION_MAX_MS);
  });

  test('a stop this tab issued bars an open-turn read that predates its settlement', () => {
    // `handleStop` paints idle and issues the cancel; the daemon takes ~1.6s to
    // act on it. Every `/turn` read in that window still shows the doomed turn
    // — including the one the optimistic idle FRAME itself triggers — so the
    // composer flipped Send back to Stop about 120ms after the click and stayed
    // there for the whole abort round-trip.
    const inFlight = projectWorking({
      optimistic: null,
      abort: { atMs: T0, settledAtMs: null },
      server: { turns: [turn()], atMs: T0 + 2 },
      stream: { type: 'idle', atMs: T0 },
      nowMs: T0 + 120,
    });

    expect(inFlight.state).toBe('idle');
    expect(inFlight.source).toBe('stream');
  });

  test('a settled stop stops barring reads issued after the settlement', () => {
    // The abort failed, or a new turn started right after it: an open turn a
    // read saw AFTER the cancel was acknowledged is a real turn again.
    const projection = projectWorking({
      optimistic: null,
      abort: { atMs: T0, settledAtMs: T0 + 1_600 },
      server: { turns: [turn()], atMs: T0 + 1_700 },
      stream: { type: 'idle', atMs: T0 },
      nowMs: T0 + 1_800,
    });

    expect(projection.state).toBe('working');
    expect(projection.source).toBe('server');
  });

  test('a stop whose acknowledgement never arrives stops barring anything', () => {
    // The bound is the same promise the send receipt makes in the other
    // direction: an unanswered local action may not pin the UI, either way.
    const projection = projectWorking({
      optimistic: null,
      abort: { atMs: T0, settledAtMs: null },
      server: { turns: [turn()], atMs: T0 + OPTIMISTIC_ABORT_MAX_MS },
      stream: null,
      nowMs: T0 + OPTIMISTIC_ABORT_MAX_MS,
    });

    expect(projection.state).toBe('working');
    expect(projection.source).toBe('server');
  });

  test('an empty inbox never claims working', () => {
    const projection = projectWorking({
      optimistic: null,
      inbox: { pending: 0, atMs: T0 + 1_000 },
      server: { turns: [], atMs: T0 + 1_000 },
      stream: null,
      nowMs: T0 + 1_100,
    });

    expect(projection.state).toBe('idle');
  });

  test('a NEW stream frame still answers an unaccepted receipt', () => {
    // The stream is the runtime's own voice and the store stamps a frame when
    // this tab OBSERVED it, which only moves when the frame itself changes — so
    // a frame stamped after the send is a new transition, not a stale reading.
    // Nothing ever "accepts" a slash command, so blocking the stream here left
    // its receipt claiming `working` for a full minute after the turn ended.
    const projection = projectWorking({
      optimistic: { messageId: 'msg_42', atMs: T0, acceptedAtMs: null },
      server: null,
      stream: { type: 'idle', atMs: T0 + 8_000 },
      nowMs: T0 + 8_100,
    });

    expect(projection.state).toBe('idle');
    expect(projection.source).toBe('stream');
  });

  test('an optimistic receipt older than the cap never claims working', () => {
    // The bound is the whole point: a send whose answer never arrives must not
    // latch the UI. That latch is the failure this phase exists to end.
    const projection = projectWorking({
      optimistic: { messageId: 'msg_42', atMs: T0 },
      server: null,
      stream: null,
      nowMs: T0 + OPTIMISTIC_RECEIPT_MAX_MS,
    });

    expect(projection.state).toBe('idle');
    expect(projection.turnId).toBeNull();
  });

  test('an expired receipt stops shielding a stale server idle too', () => {
    const projection = projectWorking({
      optimistic: { messageId: 'msg_42', atMs: T0 + 1_000 },
      server: { turns: [], atMs: T0 },
      stream: null,
      nowMs: T0 + 1_000 + OPTIMISTIC_RECEIPT_MAX_MS,
    });

    expect(projection.state).toBe('idle');
    expect(projection.source).toBe('server');
  });

  test('no observation at all is idle, and never fabricates a turn', () => {
    const projection = projectWorking({
      optimistic: null,
      server: null,
      stream: null,
      nowMs: T0,
    });

    expect(projection).toEqual({
      state: 'idle',
      source: 'server',
      turnId: null,
      since: T0,
      serverOpenTurnToken: null,
    });
  });

  test('the newest of several open turns is the one reported', () => {
    const older = turn({ turn_token: 'tt-old', message_id: 'msg_00' });
    const newer = turn({
      turn_token: 'tt-new',
      message_id: 'msg_02',
      started_at: new Date(T0 + 3_000).toISOString(),
    });

    // The endpoint answers newest-start-first, so the head is the answer and
    // this projection does not re-sort it.
    const projection = projectWorking({
      optimistic: null,
      server: { turns: [newer, older], atMs: T0 + 4_000 },
      stream: null,
      nowMs: T0 + 4_000,
    });

    expect(projection.turnId).toBe('msg_02');
    expect(projection.since).toBe(T0 + 3_000);
  });
});

/**
 * The projection is pure and moves with `nowMs` — so SOMETHING has to ask it
 * again at the instant an input ages out. Nothing did: a hook that only
 * re-rendered when react-query handed it new `data` never re-rendered at all
 * while every read failed (the retained `data` is unchanged, so the observer
 * does not notify), and `SERVER_OBSERVATION_MAX_MS` was therefore evaluated
 * only on renders that happened for some unrelated reason. In the exact outage
 * it was written for — one success, then a run of 503s — that is never.
 */
describe('workingExpiryAtMs', () => {
  test('is the earliest instant at which an input stops deciding', () => {
    const at = workingExpiryAtMs({
      optimistic: { messageId: 'msg_1', atMs: T0, acceptedAtMs: T0 },
      inbox: { pending: 1, atMs: T0 },
      server: { turns: [turn()], atMs: T0 },
      stream: { type: 'busy', atMs: T0 },
      nowMs: T0 + 1,
    });

    // The inbox reading has the shortest life of the four.
    expect(at).toBe(T0 + INBOX_OBSERVATION_MAX_MS);
  });

  test('skips deadlines already in the past', () => {
    const at = workingExpiryAtMs({
      optimistic: null,
      inbox: { pending: 1, atMs: T0 },
      server: { turns: [turn()], atMs: T0 },
      stream: null,
      nowMs: T0 + INBOX_OBSERVATION_MAX_MS + 1,
    });

    expect(at).toBe(T0 + SERVER_OBSERVATION_MAX_MS);
  });

  test('is null when nothing is left to expire', () => {
    expect(workingExpiryAtMs({ optimistic: null, server: null, stream: null, nowMs: T0 })).toBeNull();
  });

  test('covers the send receipt and the stop receipt too', () => {
    expect(
      workingExpiryAtMs({
        optimistic: { messageId: 'msg_1', atMs: T0 },
        server: null,
        stream: null,
        nowMs: T0,
      }),
    ).toBe(T0 + OPTIMISTIC_RECEIPT_MAX_MS);

    expect(
      workingExpiryAtMs({
        optimistic: null,
        abort: { atMs: T0, settledAtMs: null },
        server: null,
        stream: null,
        nowMs: T0,
      }),
    ).toBe(T0 + OPTIMISTIC_ABORT_MAX_MS);
  });
});

function prompt(overrides: Partial<SessionPrompt> = {}): SessionPrompt {
  return {
    prompt_id: 'p1',
    client_message_id: 'q_1',
    message_id: 'msg_01',
    state: 'queued',
    reason: null,
    text: 'hi',
    attempts: 0,
    last_error: null,
    created_at: new Date(T0).toISOString(),
    available_at: new Date(T0).toISOString(),
    ...overrides,
  };
}

/**
 * The control-plane ledger is not timely about the END of a turn, and the
 * projection used to believe it was.
 *
 * MEASURED on the local stack, 2026-08-21, one ordinary composer turn
 * (session 08cf8a74, turn token 05e2a176):
 *
 *   00:02:55.804  ledger opens the turn
 *   00:03:59.964  the RUNTIME's `session.idle` frame reaches the tab   → idle
 *   00:04:00.150  the refetch that frame itself triggers lands, stamped
 *                 44ms AFTER the frame, and still reports the turn `active`
 *                                                                     → working
 *   00:04:15.132  the ledger finally records `ended_at`
 *   00:04:15.248  the next poll reports no turns                       → idle
 *
 * 15.1 seconds of "working" after the reply was already on screen — the
 * spinner and the Stop button came back a fifth of a second after they left.
 * The daemon relay that normally closes the row (`POST .../turn-stream`
 * `kind:"end"`) never arrived for that turn at all; a reconciliation sweep
 * closed it 15s later. When the relay DOES arrive it lands ~200ms after the
 * frame — still inside the window the frame's own refetch lands in.
 *
 * So the rule cannot be "whichever observation is newer wins". A read ISSUED
 * after the frame is still ABOUT a turn the frame already ended. The turn's
 * own `started_at` is what separates them: a turn that began BEFORE the idle
 * frame is the turn that frame ended.
 */
describe('projectWorking — content is evidence', () => {
  // Reported with a screen recording: the transcript is streaming — a tool row
  // with a live spinner, text growing — and the composer shows its SEND ARROW.
  // No Stop. The session dot in the sidebar is green the whole time.
  //
  // Every input this projection had was an OBSERVER of the runtime: a `/turn`
  // poll, an SSE status frame, a health probe, an inbox read. The transcript
  // renders the runtime's actual OUTPUT, and that was not an input at all. So a
  // dropped status frame — or a poll throttled by a backgrounded tab — left the
  // composer telling the user something the screen was contradicting.
  //
  // Content is the strongest evidence there is: it does not report that the
  // runtime is working, it IS the runtime working.
  test('streaming content outranks a stale idle frame', () => {
    const projection = projectWorking({
      optimistic: null,
      server: { turns: [turn()], atMs: T0 + 61_000 },
      stream: { type: 'idle', atMs: T0 + 60_000 },
      activity: { atMs: T0 + 60_500 },
      nowMs: T0 + 61_100,
    });

    expect(projection).toMatchObject({ state: 'working' });
  });

  test('content older than the idle frame does not resurrect the turn', () => {
    // The frame is the newer statement here, and it says the turn ended.
    expect(
      projectWorking({
        optimistic: null,
        server: { turns: [turn()], atMs: T0 + 61_000 },
        stream: { type: 'idle', atMs: T0 + 60_500 },
        activity: { atMs: T0 + 60_000 },
        nowMs: T0 + 61_100,
      }).state,
    ).toBe('idle');
  });

  test('content answers even when every observer has gone stale', () => {
    // A backgrounded tab throttles the poll and can drop the stream, so both
    // observations age out — and the screen keeps streaming. This is the case
    // where the projection had nothing left to say and said `idle`.
    const projection = projectWorking({
      optimistic: null,
      server: { turns: [turn()], atMs: T0 },
      stream: { type: 'busy', atMs: T0 },
      activity: { atMs: T0 + 200_000 },
      nowMs: T0 + 200_500,
    });

    expect(projection).toMatchObject({ state: 'working' });
  });

  test('stale content is not evidence of anything', () => {
    expect(
      projectWorking({
        optimistic: null,
        server: null,
        stream: null,
        activity: { atMs: T0 },
        nowMs: T0 + 200_000,
      }).state,
    ).toBe('idle');
  });

  test('no activity input at all behaves exactly as before', () => {
    expect(
      projectWorking({
        optimistic: null,
        server: { turns: [], atMs: T0 + 100 },
        stream: null,
        nowMs: T0 + 200,
      }).state,
    ).toBe('idle');
  });
});

describe('projectWorking — a runtime idle frame ends the turn it names', () => {
  test('an open ledger turn that STARTED BEFORE the newest idle frame is over', () => {
    const projection = projectWorking({
      optimistic: null,
      // The read is NEWER than the frame by 44ms — exactly the measured race —
      // and it still reports the turn the frame just ended.
      server: { turns: [turn({ started_at: new Date(T0).toISOString() })], atMs: T0 + 60_044 },
      stream: { type: 'idle', atMs: T0 + 60_000 },
      nowMs: T0 + 60_200,
    });

    expect(projection.state).toBe('idle');
  });

  test('a turn that started AFTER the idle frame is a NEW turn and still works', () => {
    // The whole reason the rule keys on `started_at` instead of a time window:
    // a queued prompt draining into a fresh turn must light the composer up
    // again immediately, even though the last frame this tab saw said idle.
    const projection = projectWorking({
      optimistic: null,
      server: {
        turns: [turn({ turn_token: 'tt-2', started_at: new Date(T0 + 61_000).toISOString() })],
        atMs: T0 + 61_500,
      },
      stream: { type: 'idle', atMs: T0 + 60_000 },
      nowMs: T0 + 61_600,
    });

    expect(projection).toMatchObject({ state: 'working', source: 'server' });
  });

  test('a live turn behind a spent one still reports working', () => {
    // The ledger holds more than one open row whenever a prompt is forwarded
    // while another turn runs, and the list is not ordered newest-first.
    // Measured on the local stack: `turns: [B@00:28:56, A@00:28:22]`. Reading
    // only `turns[0]` would let the spent row decide for the live one.
    const projection = projectWorking({
      optimistic: null,
      server: {
        turns: [
          turn({ turn_token: 'spent', started_at: new Date(T0).toISOString() }),
          turn({ turn_token: 'live', started_at: new Date(T0 + 61_000).toISOString() }),
        ],
        atMs: T0 + 61_500,
      },
      stream: { type: 'idle', atMs: T0 + 60_000 },
      nowMs: T0 + 61_600,
    });

    expect(projection).toMatchObject({ state: 'working', source: 'server' });
  });

  // Reported from dev 2026-08-23 with three screenshots one second apart: the
  // answer is on screen and the composer is idle, then "Gathering thoughts…"
  // and the Stop button come BACK for a couple of seconds, then leave again.
  // "It finishes, then reconnects for a couple secs, then disconnects again."
  //
  // That is this rule oscillating. The runtime went idle; the `kind:"end"`
  // relay that closes the ledger row was dropped, so `/turn` keeps reporting
  // the turn open until a reconciliation sweep closes it (MEASURED in this
  // file's own notes: 15.1s late). The idle frame outranked the row for
  // exactly 3s and then handed authority back — so the UI announced a turn
  // that had already finished, for as long as the sweep took.
  test('a dropped end-relay never re-busies a turn the runtime already ended', () => {
    const ended = { turns: [turn()], atMs: T0 + 60_100 };
    const idleFrame = { type: 'idle' as const, atMs: T0 + 60_000 };

    // Immediately after the frame: idle (this part already worked).
    expect(
      projectWorking({ optimistic: null, server: ended, stream: idleFrame, nowMs: T0 + 60_200 })
        .state,
    ).toBe('idle');

    // Ten seconds later the sweep still has not closed the row. The turn is no
    // more alive than it was a moment ago, and the composer must not say it is.
    expect(
      projectWorking({
        optimistic: null,
        server: { turns: [turn()], atMs: T0 + 70_000 },
        stream: idleFrame,
        nowMs: T0 + 70_100,
      }).state,
    ).toBe('idle');
  });

  test('and it never re-busies once the frame ages out either', () => {
    // The first cut of this fix left the same oscillation 42 seconds later:
    // `idleFrame` was gated on `streamFresh`, so at
    // `stream.atMs + STREAM_OBSERVATION_MAX_MS` the veto vanished with no new
    // input and a still-open row took the composer back to `working` — and this
    // one does NOT self-heal. An unobservable turn record is cleared only at its
    // deadline, and an accepted turn's grant defaults to 240 MINUTES.
    //
    // Staleness cannot make an ended turn un-end. The frame is a statement about
    // a turn that started before it, and that stays true however old the
    // statement gets; a turn that resumed would have produced a newer, non-idle
    // frame.
    const idleFrame = { type: 'idle' as const, atMs: T0 + 60_000 };
    for (const age of [STREAM_OBSERVATION_MAX_MS + 100, 10 * 60_000, 4 * 60 * 60_000]) {
      expect(
        projectWorking({
          optimistic: null,
          server: { turns: [turn()], atMs: T0 + 60_000 + age - 50 },
          stream: idleFrame,
          nowMs: T0 + 60_000 + age,
        }).state,
      ).toBe('idle');
    }
  });

  // The protection the old wall-clock window was really buying: a turn that is
  // still running announces itself, and THAT is what returns authority to the
  // ledger — evidence, not the passage of time.
  test('a newer non-idle frame hands the ledger back immediately', () => {
    for (const type of ['busy', 'retry'] as const) {
      expect(
        projectWorking({
          optimistic: null,
          server: { turns: [turn()], atMs: T0 + 61_000 },
          stream: { type, atMs: T0 + 60_500 },
          nowMs: T0 + 61_100,
        }),
      ).toMatchObject({ state: 'working', source: 'server' });
    }
  });

  test('a BUSY frame never suppresses the ledger — only an idle one ends a turn', () => {
    const projection = projectWorking({
      optimistic: null,
      server: { turns: [turn()], atMs: T0 + 60_044 },
      stream: { type: 'busy', atMs: T0 + 60_000 },
      nowMs: T0 + 60_200,
    });

    expect(projection).toMatchObject({ state: 'working' });
  });

  test('a retry that announces itself takes the ledger back — no window needed', () => {
    // OpenCode emits `retry` while it backs off a provider (429, transient 5xx)
    // with the turn still running, and that frame is NOT idle — so the ledger
    // decides again the moment it lands. This used to be enforced by expiring
    // the idle veto after `TURN_END_LEDGER_LAG_MS`, which also un-ended turns
    // that had genuinely finished (a dropped `kind:"end"` relay looks identical
    // to a retry from a clock's point of view). Pinning the FRAME is what that
    // rule was really for.
    const projection = projectWorking({
      optimistic: null,
      server: { turns: [turn()], atMs: T0 + 60_000 + TURN_END_LEDGER_LAG_MS + 500 },
      stream: { type: 'retry', atMs: T0 + 60_000 + TURN_END_LEDGER_LAG_MS + 100 },
      nowMs: T0 + 60_000 + TURN_END_LEDGER_LAG_MS + 600,
    });

    expect(projection).toMatchObject({ state: 'working', source: 'server' });
  });

  test('an ended turn schedules no flip back to working', () => {
    // The old rule moved with `nowMs` alone, so the expiry timer had to name
    // the instant it flipped — and that scheduled re-render IS the flap the
    // user sees. Nothing about a finished turn changes with time now, so the
    // only expiry left is the frame's own staleness bound.
    const inputs = {
      optimistic: null,
      server: { turns: [turn()], atMs: T0 + 60_100 },
      stream: { type: 'idle' as const, atMs: T0 + 60_000 },
      nowMs: T0 + 60_200,
    };
    expect(projectWorking(inputs).state).toBe('idle');
    expect(workingExpiryAtMs(inputs)).toBe(T0 + 60_000 + STREAM_OBSERVATION_MAX_MS);
  });

  test('a turn with no start instant keeps the ledger its authority', () => {
    // `started_at` is null for a legacy `activeTurn` row. Nothing can be ranked
    // against the frame there, and inventing an order would hide a live turn.
    const projection = projectWorking({
      optimistic: null,
      server: { turns: [turn({ started_at: null as unknown as string })], atMs: T0 + 60_044 },
      stream: { type: 'idle', atMs: T0 + 60_000 },
      nowMs: T0 + 60_200,
    });

    expect(projection).toMatchObject({ state: 'working' });
  });

  test('a stale idle frame still cannot decide WORKING — only that a turn ended', () => {
    // The freshness bound is about testifying to the present, so it still gates
    // every branch that reads `working` out of the stream. What it must not gate
    // is the veto: this test used to assert that an aged-out idle frame handed a
    // still-open row back to the ledger, which is the same oscillation the 3s
    // window produced, 42s later and permanent (an accepted turn's record is
    // cleared only at its deadline — 240 minutes by default).
    //
    // A turn started AFTER the frame is untouched by it at any age, and that is
    // what the ledger keeps deciding.
    const staleIdle = { type: 'idle' as const, atMs: T0 + 60_000 };
    const nowMs = T0 + 60_000 + STREAM_OBSERVATION_MAX_MS + 1_100;

    expect(
      projectWorking({
        optimistic: null,
        server: {
          turns: [turn({ started_at: new Date(T0 + 60_500).toISOString() })],
          atMs: nowMs - 100,
        },
        stream: staleIdle,
        nowMs,
      }),
    ).toMatchObject({ state: 'working', source: 'server' });
  });

  test('the ledger\'s token survives the frame — only the WORKING answer moves', () => {
    // `serverOpenTurnToken` answers a different question from `state`: whether
    // the control plane still holds authority over the turn. A `/` command goes
    // straight at OpenCode with no admission gate in front of it and must see
    // that authority for as long as the row exists, even in the window where
    // the runtime's frame has correctly decided the session is idle.
    const projection = projectWorking({
      optimistic: null,
      server: { turns: [turn()], atMs: T0 + 60_044 },
      stream: { type: 'idle', atMs: T0 + 60_000 },
      nowMs: T0 + 60_200,
    });

    expect(projection.state).toBe('idle');
    expect(projection.serverOpenTurnToken).toBe('tt-1');
  });
});

/**
 * Only the RUNTIME'S OWN idle frame may end a turn. The tab also fabricates
 * idle frames locally — `reconcileMissingBusySessions` when a status snapshot
 * omits a session, `markSessionAbortedLocally` on `server.instance.disposed`,
 * `clearSession` on a cache-ownership handoff — and every one of them is an
 * INFERENCE, not the runtime speaking.
 *
 * Reported from dev 2026-08-24: mid-turn — usually a long `run
 * command` or tool call — the busy indicator disappears and the composer swaps
 * Stop for the send arrow while the agent is still running; the UI comes back
 * "for a brief couple seconds" right as the reply streams, then ends. That is
 * a fabricated idle frame vetoing the ledger's open row: the veto is
 * deliberately unbounded (a dropped `kind:"end"` relay must stay ended — see
 * the block above), so one wrong local frame discards every fresh `/turn`
 * read for the rest of the turn, and a quiet tool call emits no new wire
 * frame to lift it.
 *
 * `origin` is the discriminator: absent or `'wire'` keeps today's full veto;
 * `'local'` may still ANSWER (rule 4 — a repair for a missed terminal frame is
 * still the honest fallback when nothing fresher exists) but may never
 * CONTRADICT the lifecycle authority or the runtime's own output.
 */
describe('projectWorking — a fabricated idle frame cannot contradict the ledger', () => {
  test('a local idle frame never vetoes an open turn the server re-affirms', () => {
    // The sweep fabricated idle at T0+60s; the poll keeps reporting the turn
    // open on reads issued after it. The server is the authority here.
    const projection = projectWorking({
      optimistic: null,
      server: { turns: [turn()], atMs: T0 + 65_000 },
      stream: { type: 'idle', origin: 'local', atMs: T0 + 60_000 },
      nowMs: T0 + 65_100,
    });

    expect(projection).toMatchObject({ state: 'working', source: 'server', turnId: 'msg_01' });
  });

  test('a local idle frame NEWER than the read still loses to the open row', () => {
    // The fabricated frame lands between polls, so it is the newest
    // observation in the tab. Newest is not truest: a local frame never
    // outranks the lifecycle authority, not even for one poll interval.
    const projection = projectWorking({
      optimistic: null,
      server: { turns: [turn()], atMs: T0 + 60_000 },
      stream: { type: 'idle', origin: 'local', atMs: T0 + 62_000 },
      nowMs: T0 + 62_100,
    });

    expect(projection).toMatchObject({ state: 'working', source: 'server' });
  });

  test('streaming content outranks a NEWER local idle frame', () => {
    // Content is the runtime working; a fabricated frame is a guess about it.
    // The wire-idle rule ("content older than the idle frame does not
    // resurrect the turn") must not apply to a frame the runtime never sent.
    const projection = projectWorking({
      optimistic: null,
      server: null,
      stream: { type: 'idle', origin: 'local', atMs: T0 + 60_500 },
      activity: { atMs: T0 + 60_000 },
      nowMs: T0 + 61_000,
    });

    expect(projection).toMatchObject({ state: 'working', source: 'stream' });
  });

  test('a local idle frame still answers when nothing fresher exists', () => {
    // The repair for a missed terminal frame keeps its value: with no server
    // read, no content, and no receipt, the fabricated frame is the only
    // observation there is, and idle is the honest default it feeds.
    const projection = projectWorking({
      optimistic: null,
      server: null,
      stream: { type: 'idle', origin: 'local', atMs: T0 },
      nowMs: T0 + 1_000,
    });

    expect(projection).toMatchObject({ state: 'idle', source: 'stream' });
  });

  test("an explicit 'wire' origin behaves exactly like an unmarked frame", () => {
    // `origin` is additive: absent means wire, and wire keeps the full veto.
    for (const stream of [
      { type: 'idle' as const, atMs: T0 + 60_000 },
      { type: 'idle' as const, origin: 'wire' as const, atMs: T0 + 60_000 },
    ]) {
      expect(
        projectWorking({
          optimistic: null,
          server: { turns: [turn()], atMs: T0 + 60_044 },
          stream,
          nowMs: T0 + 60_200,
        }).state,
      ).toBe('idle');
    }
  });

  test('a local BUSY frame still reports working off the stream', () => {
    // The status snapshot fill writes busy/retry values through the same local
    // path. False-working self-heals through `/turn` and the wire idle; only
    // the idle direction ever masked a live turn, so busy keeps answering.
    const projection = projectWorking({
      optimistic: null,
      server: null,
      stream: { type: 'busy', origin: 'local', atMs: T0 },
      nowMs: T0 + 1_000,
    });

    expect(projection).toMatchObject({ state: 'working', source: 'stream' });
  });
});

/**
 * A prompt queued BEHIND a running turn is not ended by that turn's idle frame.
 *
 * This block exists because the opposite was implemented first and measured
 * wrong. The control plane forwards a queued prompt to OpenCode early — the row
 * reads `delivering` from the moment it is handed over — and OpenCode runs it
 * after the turn in front of it finishes. So the row sits in `delivering`
 * ACROSS the turn boundary, and the idle frame that ends the turn ahead of it
 * says nothing whatsoever about it.
 *
 * MEASURED on the local stack 2026-08-21, prompt B queued behind prompt A:
 * A ended at 00:24:04.7, B did not start until 00:24:18.9. Excluding forwarded
 * rows on the idle frame put the composer back on Send for those 13.8 seconds
 * with B still waiting — the queue's own version of the flicker this branch
 * removes. Every live row counts, whether or not it has been forwarded.
 */
describe('projectWorking — a queued prompt outlives the turn in front of it', () => {
  test('an inbox row still outranks the idle frame that ended the previous turn', () => {
    const projection = projectWorking({
      optimistic: null,
      inbox: { pending: 1, atMs: T0 + 59_000 },
      server: { turns: [], atMs: T0 + 59_000 },
      stream: { type: 'idle', atMs: T0 + 60_000 },
      nowMs: T0 + 60_200,
    });

    expect(projection).toMatchObject({ state: 'working', source: 'server' });
  });
});

describe('countLiveInboxPrompts', () => {
  test('counts the rows the server is still going to run', () => {
    expect(
      countLiveInboxPrompts([
        prompt({ prompt_id: 'a', state: 'queued' }),
        prompt({ prompt_id: 'b', state: 'delivering' }),
        prompt({ prompt_id: 'c', state: 'waiting', reason: 'turn_active' }),
        prompt({ prompt_id: 'd', state: 'waiting', reason: 'older_prompt_pending' }),
      ]),
    ).toBe(4);
  });

  test('a HELD row is not work in flight — Stop must put the composer back', () => {
    // `held` is the Stop button's own state: the row stays, deliberately not
    // due, until the user sends something or presses "send now". Counting it
    // would leave the composer on Stop with nothing running.
    expect(countLiveInboxPrompts([prompt({ state: 'waiting', reason: 'held' })])).toBe(0);
  });

  test('a failed row is not work in flight either', () => {
    expect(countLiveInboxPrompts([prompt({ state: 'failed' })])).toBe(0);
  });

  test('an empty inbox is zero', () => {
    expect(countLiveInboxPrompts([])).toBe(0);
  });
});

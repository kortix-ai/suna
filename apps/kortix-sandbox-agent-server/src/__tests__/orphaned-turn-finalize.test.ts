/**
 * A turn whose opencode process died must be ENDED, not left running forever.
 *
 * A turn ends only when opencode emits `session.idle`/`session.error` over SSE.
 * A killed or crashed opencode emits neither, so the last assistant message
 * stays incomplete and every client streaming it spins — which is what an agent
 * running `kill <opencode pid>` from its own shell produces, and equally what an
 * OOM produces. The supervisor respawns the box within ~500ms, so the sandbox is
 * fine; only the turn is stranded.
 *
 * Boot already finalized such a turn when it adopted a root. These tests cover
 * the extracted version, which the supervisor's unplanned-respawn hook now calls
 * too.
 */
import { afterEach, describe, expect, test } from 'bun:test'


import { finalizeOrphanedTurn } from '../main'
import { inspectOpencodeRoot,
  observeOpencodeDelivery,
  opencodeDeliveryInFlight,
  opencodeTurnInFlight,
} from '../opencode-turn-state';
import { createHealthRouter, observeRequestedTurn } from '../routes/health';

const BASE = 'http://127.0.0.1:4096';
const WORKSPACE = '/workspace';
const SESSION = 'ses_abc';

const ORIGINAL_FETCH = globalThis.fetch;
let calls: string[] = [];

function stubFetch(
  messages: unknown,
  opts: {
    messagesOk?: boolean;
    abortThrows?: boolean;
    sessionStatus?: unknown;
    sessionStatusOk?: boolean;
  } = {},
) {
  calls = []
  ;(globalThis as { fetch: unknown }).fetch = async (input: unknown, init?: { method?: string }) => {
    const url = String(input);
    calls.push(`${init?.method ?? 'GET'} ${url.split('?')[0]}`);
    if (url.includes('/abort')) {
      if (opts.abortThrows) throw new Error('connection refused');
      return new Response('{}', { status: 200 });
    }
    if (url.includes('/session/status')) {
      if (opts.sessionStatusOk === false) return new Response('nope', { status: 503 });
      return new Response(JSON.stringify(opts.sessionStatus ?? {}), { status: 200 });
    }
    if (opts.messagesOk === false) return new Response('nope', { status: 503 });
    return new Response(JSON.stringify(messages), { status: 200 });
  };
}

afterEach(() => {
  (globalThis as { fetch: unknown }).fetch = ORIGINAL_FETCH;
});

const assistantTurn = (completed?: number) => [
  { info: { role: 'user', time: { completed: 1 } } },
  { info: { role: 'assistant', time: completed === undefined ? {} : { completed } } },
];

describe('finalizeOrphanedTurn', () => {
  test('aborts an assistant turn that never completed', async () => {
    stubFetch(assistantTurn(undefined));

    expect(await finalizeOrphanedTurn(BASE, WORKSPACE, SESSION)).toBe(true);
    expect(calls.some((c) => c.startsWith('POST') && c.endsWith('/abort'))).toBe(true);
  });

  test('leaves a COMPLETED turn alone', async () => {
    // Aborting a finished turn would be a visible lie in the transcript, and the
    // supervisor's hook fires on every unplanned respawn — including ones where
    // nothing was in flight.
    stubFetch(assistantTurn(1_700_000_000));

    expect(await finalizeOrphanedTurn(BASE, WORKSPACE, SESSION)).toBe(false);
    expect(calls.some((c) => c.includes('/abort'))).toBe(false);
  });

  test('a session whose last message is the USER is not an orphaned turn', async () => {
    // The prompt never reached the model. There is no assistant message to end.
    stubFetch([{ info: { role: 'user', time: { completed: 1 } } }]);

    expect(await finalizeOrphanedTurn(BASE, WORKSPACE, SESSION)).toBe(false);
  });

  test('an empty session is not an orphaned turn', async () => {
    stubFetch([]);
    expect(await finalizeOrphanedTurn(BASE, WORKSPACE, SESSION)).toBe(false);
  });

  test('an unreadable message list does NOT abort', async () => {
    // opencode may still be coming back up after the respawn. Aborting on a
    // failed read would end turns that are perfectly alive.
    stubFetch(null, { messagesOk: false });

    expect(await finalizeOrphanedTurn(BASE, WORKSPACE, SESSION)).toBe(false);
    expect(calls.some((c) => c.includes('/abort'))).toBe(false);
  });

  test('a failing abort is swallowed, never thrown at the supervisor', async () => {
    // This runs from the respawn path. A daemon that cannot finish bringing
    // opencode back because it could not tidy up a turn is worse than a spinner.
    stubFetch(assistantTurn(undefined), { abortThrows: true });

    expect(await finalizeOrphanedTurn(BASE, WORKSPACE, SESSION)).toBe(true);
  });

  test('the session id and workspace are passed through url-encoded', async () => {
    stubFetch(assistantTurn(undefined));
    await finalizeOrphanedTurn(BASE, '/work space', 'ses/1');

    expect(calls.every((c) => !c.includes('ses/1'))).toBe(true);
  });
});

describe('inspectOpencodeRoot — could-not-tell is its own answer', () => {
  test('a successful read is known', async () => {
    stubFetch(assistantTurn(undefined));
    const result = await inspectOpencodeRoot(BASE, WORKSPACE, SESSION);
    expect(result).toEqual({
      hasMessages: true,
      lastTurnIncomplete: true,
      turnInFlight: true,
      orphanedPrompt: false,
      known: true,
    });
  });

  test('an EMPTY session is known-idle, not unknown', async () => {
    // Nothing has run. That is a definite answer and the reload gate may act on it.
    stubFetch([]);
    expect((await inspectOpencodeRoot(BASE, WORKSPACE, SESSION)).known).toBe(true);
  });

  test('an unreadable list is UNKNOWN, not idle', async () => {
    // Reporting idle here let the reload restart opencode while a turn was
    // running and opencode was merely slow to answer — defeating the one
    // promise the gate makes.
    stubFetch(null, { messagesOk: false });
    const result = await inspectOpencodeRoot(BASE, WORKSPACE, SESSION);
    expect(result.known).toBe(false);
    expect(result.lastTurnIncomplete).toBe(false);
    expect(result.orphanedPrompt).toBe(false);
  });

  test('a TRAILING USER MESSAGE is an ORPHANED PROMPT, not a turn in flight', async () => {
    // THE PHANTOM-BUSY THIS FIELD ENDS. A respawned opencode keeps the
    // persisted user message and loses the in-memory queue, so the root's last
    // message is a prompt nothing will ever answer. Reporting that as
    // `turnInFlight` renewed the control plane's turn grant on every reaper
    // pass — for ever — and the session rendered "working" with nothing
    // working. It is "a prompt was dropped", which the inbox can repair by
    // redelivering it.
    stubFetch([{ info: { role: 'user', time: { completed: 1 } } }]);
    const result = await inspectOpencodeRoot(BASE, WORKSPACE, SESSION);
    expect(result).toEqual({
      hasMessages: true,
      lastTurnIncomplete: false,
      turnInFlight: false,
      orphanedPrompt: true,
      known: true,
    });
  });

  test('an EMPTY root has no orphaned prompt', async () => {
    stubFetch([]);
    expect(await inspectOpencodeRoot(BASE, WORKSPACE, SESSION)).toEqual({
      hasMessages: false,
      lastTurnIncomplete: false,
      turnInFlight: false,
      orphanedPrompt: false,
      known: true,
    });
  });
});

describe('opencodeTurnInFlight — the reload gate reads this', () => {
  test('no root is a definite false — nothing has ever run in this sandbox', async () => {
    expect(await opencodeTurnInFlight(BASE, WORKSPACE, null)).toBe(false);
  });

  test('a running turn is true', async () => {
    stubFetch(assistantTurn(undefined));
    expect(await opencodeTurnInFlight(BASE, WORKSPACE, SESSION)).toBe(true);
  });

  test('a trailing user message is NO LONGER in flight — it is an orphaned prompt', async () => {
    // REWRITTEN, not deleted. This used to assert `true`, on the theory that a
    // queued user message still owns the runtime. It does not: opencode's
    // in-memory queue does not survive a respawn, so the persisted user message
    // outlives every process that could answer it, and reporting it busy is
    // what made a session render "working" for ever. The reload gate now
    // ALLOWS a restart here, which is exactly what unsticks it, and the inbox
    // redelivers the prompt (see `orphanedPrompt`).
    stubFetch([{ info: { role: 'user', time: { completed: 1 } } }]);
    expect(await opencodeTurnInFlight(BASE, WORKSPACE, SESSION)).toBe(false);
  });

  test('an unreadable box is NULL, so the gate refuses instead of restarting', async () => {
    // The bug this closes: returning false here handed the reload a green light
    // while a turn was running and opencode was merely slow to answer.
    stubFetch(null, { messagesOk: false });
    expect(await opencodeTurnInFlight(BASE, WORKSPACE, SESSION)).toBeNull();
  });
});

describe('opencodeDeliveryInFlight — lifecycle acceptance recovery', () => {
  test('a delivered user message without an assistant is active only while OpenCode reports busy', async () => {
    stubFetch([{ info: { id: 'msg_turn_1', role: 'user' } }], {
      sessionStatus: { [SESSION]: { type: 'busy' } },
    });
    expect(await opencodeDeliveryInFlight(BASE, WORKSPACE, SESSION, 'msg_turn_1')).toBe(true);
  });

  test('a user-only message in an idle OpenCode session is terminal', async () => {
    stubFetch([{ info: { id: 'msg_turn_1', role: 'user' } }], {
      sessionStatus: { [SESSION]: { type: 'idle' } },
    });
    expect(await opencodeDeliveryInFlight(BASE, WORKSPACE, SESSION, 'msg_turn_1')).toBe(false);
  });

  test('an absent OpenCode session status is terminal', async () => {
    stubFetch([{ info: { id: 'msg_turn_1', role: 'user' } }], { sessionStatus: {} });
    expect(await opencodeDeliveryInFlight(BASE, WORKSPACE, SESSION, 'msg_turn_1')).toBe(false);
  });

  test('a retrying OpenCode session keeps a user-only message active', async () => {
    stubFetch([{ info: { id: 'msg_turn_1', role: 'user' } }], {
      sessionStatus: { [SESSION]: { type: 'retry' } },
    });
    expect(await opencodeDeliveryInFlight(BASE, WORKSPACE, SESSION, 'msg_turn_1')).toBe(true);
  });

  test('an unreadable OpenCode session status makes user-only evidence unknown', async () => {
    stubFetch([{ info: { id: 'msg_turn_1', role: 'user' } }], { sessionStatusOk: false });
    expect(await opencodeDeliveryInFlight(BASE, WORKSPACE, SESSION, 'msg_turn_1')).toBeNull();
  });

  test('an unrecognized OpenCode session status makes user-only evidence unknown', async () => {
    stubFetch([{ info: { id: 'msg_turn_1', role: 'user' } }], {
      sessionStatus: { [SESSION]: { type: 'paused' } },
    });
    expect(await opencodeDeliveryInFlight(BASE, WORKSPACE, SESSION, 'msg_turn_1')).toBeNull();
  });

  test('a later user message makes the exact older turn terminal even while the session is busy', async () => {
    stubFetch(
      [
        { info: { id: 'msg_turn_1', role: 'user' } },
        { info: { id: 'msg_turn_2', role: 'user' } },
      ],
      { sessionStatus: { [SESSION]: { type: 'busy' } } },
    );
    expect(await opencodeDeliveryInFlight(BASE, WORKSPACE, SESSION, 'msg_turn_1')).toBe(false);
    expect(calls.some((url) => url.includes('/session/status'))).toBe(false);
  });

  test('an incomplete assistant for the exact user message remains active', async () => {
    stubFetch([
      { info: { id: 'msg_turn_1', role: 'user' } },
      { info: { role: 'assistant', parentID: 'msg_turn_1', time: {} } },
    ], { sessionStatus: { [SESSION]: { type: 'busy' } } });
    expect(await opencodeDeliveryInFlight(BASE, WORKSPACE, SESSION, 'msg_turn_1')).toBe(true);
  });

  test('a terminal assistant error without a completion timestamp is terminal', async () => {
    stubFetch([
      { info: { id: 'msg_turn_1', role: 'user' } },
      {
        info: {
          role: 'assistant',
          parentID: 'msg_turn_1',
          time: {},
          error: { name: 'APIError', data: { isRetryable: false } },
        },
      },
    ]);
    expect(await opencodeDeliveryInFlight(BASE, WORKSPACE, SESSION, 'msg_turn_1')).toBe(false);
    expect(await opencodeTurnInFlight(BASE, WORKSPACE, SESSION)).toBe(false);
  });

  test('a retryable assistant error remains active during backoff', async () => {
    stubFetch([
      { info: { id: 'msg_turn_1', role: 'user' } },
      {
        info: {
          role: 'assistant',
          parentID: 'msg_turn_1',
          time: {},
          error: { name: 'APIError', data: { isRetryable: true } },
        },
      },
    ], { sessionStatus: { [SESSION]: { type: 'retry' } } });
    expect(await opencodeDeliveryInFlight(BASE, WORKSPACE, SESSION, 'msg_turn_1')).toBe(true);
    expect(await opencodeTurnInFlight(BASE, WORKSPACE, SESSION)).toBe(true);
  });

  test('a completed assistant for the exact user message is terminal', async () => {
    stubFetch([
      { info: { id: 'msg_turn_1', role: 'user' } },
      {
        info: {
          role: 'assistant',
          parentID: 'msg_turn_1',
          time: { completed: 1234 },
        },
      },
    ]);
    expect(await opencodeDeliveryInFlight(BASE, WORKSPACE, SESSION, 'msg_turn_1')).toBe(false);
  });

  test('a missing user message after delivery grace is terminal', async () => {
    stubFetch([]);
    expect(await opencodeDeliveryInFlight(BASE, WORKSPACE, SESSION, 'msg_turn_1')).toBe(false);
  });
});

/**
 * `turn_in_flight: false` is FOUR different outcomes, and the control plane
 * writes exactly one of them into `kortix.session_turns.end_reason`. Only this
 * daemon can tell them apart — it is the process holding the message list — so
 * it names the outcome and the API stops guessing 'completed' for every one.
 */
describe('observeOpencodeDelivery — WHY the turn is not in flight', () => {
  test("a client-minted message that never reached OpenCode is 'abandoned'", async () => {
    // The user's prompt vanished. Recording this as 'completed' is the exact
    // mislabel that makes end_reason unable to name a lost delivery.
    stubFetch([{ info: { id: 'msg_other', role: 'user' } }]);
    expect(await observeOpencodeDelivery(BASE, WORKSPACE, SESSION, 'msg_turn_1')).toEqual({
      inFlight: false,
      end: 'abandoned',
    });
  });

  test("a terminal model error is 'failed', the same word the session.error relay writes", async () => {
    stubFetch([
      { info: { id: 'msg_turn_1', role: 'user' } },
      {
        info: {
          role: 'assistant',
          parentID: 'msg_turn_1',
          time: {},
          error: { name: 'APIError', data: { isRetryable: false } },
        },
      },
    ]);
    expect(await observeOpencodeDelivery(BASE, WORKSPACE, SESSION, 'msg_turn_1')).toEqual({
      inFlight: false,
      end: 'failed',
    });
  });

  test("a completed assistant is 'completed'", async () => {
    stubFetch([
      { info: { id: 'msg_turn_1', role: 'user' } },
      { info: { role: 'assistant', parentID: 'msg_turn_1', time: { completed: 1234 } } },
    ]);
    expect(await observeOpencodeDelivery(BASE, WORKSPACE, SESSION, 'msg_turn_1')).toEqual({
      inFlight: false,
      end: 'completed',
    });
  });

  test("an assistant message left open on an idle root is 'failed'", async () => {
    // The husk a killed model call leaves. Through the relay this same end
    // arrives as session.error and is written 'failed'; observing it late must
    // not rename it.
    stubFetch(
      [
        { info: { id: 'msg_turn_1', role: 'user' } },
        { info: { role: 'assistant', parentID: 'msg_turn_1', time: {} } },
      ],
      { sessionStatus: { [SESSION]: { type: 'idle' } } },
    );
    expect(await observeOpencodeDelivery(BASE, WORKSPACE, SESSION, 'msg_turn_1')).toEqual({
      inFlight: false,
      end: 'failed',
      // An assistant message exists, so the prompt WAS answered — badly, but
      // answered. Redelivering it would run the user's message twice.
      orphanedPrompt: false,
    });
  });

  test('a delivered prompt that produced nothing on an idle root names no outcome', async () => {
    // The message landed, so it was not abandoned, and no assistant message
    // says how it ended. An honest null beats an invented reason — but the
    // prompt IS orphaned, which is a separate, provable fact.
    stubFetch([{ info: { id: 'msg_turn_1', role: 'user' } }], {
      sessionStatus: { [SESSION]: { type: 'idle' } },
    });
    expect(await observeOpencodeDelivery(BASE, WORKSPACE, SESSION, 'msg_turn_1')).toEqual({
      inFlight: false,
      end: null,
      orphanedPrompt: true,
    });
  });

  test('a newer turn on the root ends this one with the reason its own messages carry', async () => {
    stubFetch(
      [
        { info: { id: 'msg_turn_1', role: 'user' } },
        { info: { role: 'assistant', parentID: 'msg_turn_1', time: { completed: 7 } } },
        { info: { id: 'msg_turn_2', role: 'user' } },
      ],
      { sessionStatus: { [SESSION]: { type: 'busy' } } },
    );
    expect(await observeOpencodeDelivery(BASE, WORKSPACE, SESSION, 'msg_turn_1')).toEqual({
      inFlight: false,
      end: 'completed',
    });
    // The root's status describes the NEWER turn, so it is never consulted.
    expect(calls.some((url) => url.includes('/session/status'))).toBe(false);
  });

  test('a running turn and an unreadable box name no outcome', async () => {
    stubFetch(
      [
        { info: { id: 'msg_turn_1', role: 'user' } },
        { info: { role: 'assistant', parentID: 'msg_turn_1', time: {} } },
      ],
      { sessionStatus: { [SESSION]: { type: 'busy' } } },
    );
    expect(await observeOpencodeDelivery(BASE, WORKSPACE, SESSION, 'msg_turn_1')).toEqual({
      inFlight: true,
      end: null,
    });

    stubFetch(null, { messagesOk: false });
    expect(await observeOpencodeDelivery(BASE, WORKSPACE, SESSION, 'msg_turn_1')).toEqual({
      inFlight: null,
      end: null,
    });
  });
});

describe('observeRequestedTurn — what /kortix/health?turn=1 answers with', () => {
  test('a message-scoped request carries the outcome the messages prove', async () => {
    stubFetch([
      { info: { id: 'msg_turn_1', role: 'user' } },
      { info: { role: 'assistant', parentID: 'msg_turn_1', time: { completed: 1234 } } },
    ]);
    expect(
      await observeRequestedTurn(BASE, WORKSPACE, { sessionId: SESSION, messageId: 'msg_turn_1' }),
    ).toEqual({ inFlight: false, end: 'completed' });
  });

  test('a root-scoped request cannot attribute an outcome to one turn', async () => {
    // Without a message id the answer is about the whole root, so naming an
    // end reason would attribute another turn's outcome to this one.
    stubFetch(assistantTurn(1_700_000_000));
    expect(
      await observeRequestedTurn(BASE, WORKSPACE, { sessionId: SESSION, messageId: null }),
    ).toEqual({ inFlight: false, end: null, orphanedPrompt: false });
  });

  test('a root-scoped request DOES name `abandoned` for an orphaned prompt', async () => {
    // The one ending a root-scoped read can prove: the root's last message is
    // a user prompt nothing answered. That is not another turn's outcome, it is
    // this root's own state, and it routes straight into the inbox's redelivery
    // (`DAEMON_REPORTABLE_END_REASONS` already accepts `abandoned`).
    stubFetch([{ info: { role: 'user', time: { completed: 1 } } }]);
    expect(
      await observeRequestedTurn(BASE, WORKSPACE, { sessionId: SESSION, messageId: null }),
    ).toEqual({ inFlight: false, end: 'abandoned', orphanedPrompt: true });
  });

  test('an unreadable root-scoped request stays unknown', async () => {
    stubFetch(null, { messagesOk: false });
    expect(
      await observeRequestedTurn(BASE, WORKSPACE, { sessionId: SESSION, messageId: null }),
    ).toEqual({ inFlight: null, end: null });
  });

  test('/kortix/health?turn=1 puts the outcome on the wire as turn_end', async () => {
    // The cross-process contract: the control plane writes this value straight
    // into session_turns.end_reason and cannot derive it, because only this
    // process holds the message list.
    stubFetch([
      { info: { id: 'msg_turn_1', role: 'user' } },
      {
        info: {
          role: 'assistant',
          parentID: 'msg_turn_1',
          time: {},
          error: { name: 'APIError', data: { isRetryable: false } },
        },
      },
    ]);
    const router = createHealthRouter(
      { projectTarget: '/workspace', autoClone: false, sandboxToken: '' } as never,
      {
        getState: () => 'ok',
        getInternalUrl: () => BASE,
        getPid: () => 1,
        getActivePort: () => 4096,
      } as never,
      Date.now(),
      { repoMaterializationError: null, timeline: [] },
    );

    const body = (await (
      await router.request(`/?turn=1&turn_session_id=${SESSION}&turn_message_id=msg_turn_1`)
    ).json()) as Record<string, unknown>;

    expect(body.turn_in_flight).toBe(false);
    expect(body.turn_end).toBe('failed');
    expect(body.turn_orphaned_prompt).toBe(false);
  });

  test('/kortix/health?turn=1 reports a root-scoped orphaned prompt on the wire', async () => {
    stubFetch([{ info: { role: 'user', time: { completed: 1 } } }]);
    const router = createHealthRouter(
      { projectTarget: '/workspace', autoClone: false, sandboxToken: '' } as never,
      {
        getState: () => 'ok',
        getInternalUrl: () => BASE,
        getPid: () => 1,
        getActivePort: () => 4096,
      } as never,
      Date.now(),
      { repoMaterializationError: null, timeline: [] },
    );

    const body = (await (
      await router.request(`/?turn=1&turn_session_id=${SESSION}`)
    ).json()) as Record<string, unknown>;

    // `turn_in_flight: false` + `turn_end: 'abandoned'` is what the reaper reads
    // as terminal-and-abandoned, which is the input its redelivery needs.
    expect(body.turn_in_flight).toBe(false);
    expect(body.turn_end).toBe('abandoned');
    expect(body.turn_orphaned_prompt).toBe(true);
  });

  test('/kortix/health without ?turn=1 still answers nothing about turns', async () => {
    stubFetch(assistantTurn(undefined));
    const router = createHealthRouter(
      { projectTarget: '/workspace', autoClone: false, sandboxToken: '' } as never,
      {
        getState: () => 'ok',
        getInternalUrl: () => BASE,
        getPid: () => 1,
        getActivePort: () => 4096,
      } as never,
      Date.now(),
      { repoMaterializationError: null, timeline: [] },
    );

    const body = (await (await router.request('/')).json()) as Record<string, unknown>;

    // Health is polled every few seconds on every idle box; the turn read costs
    // a call into opencode and stays opt-in.
    expect('turn_in_flight' in body).toBe(false);
    expect('turn_end' in body).toBe(false);
  });
});

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
  opencodeDeliveryInFlight,
  opencodeTurnInFlight,
} from '../opencode-turn-state';

const BASE = 'http://127.0.0.1:4096';
const WORKSPACE = '/workspace';
const SESSION = 'ses_abc';

const ORIGINAL_FETCH = globalThis.fetch;
let calls: string[] = [];

function stubFetch(messages: unknown, opts: { messagesOk?: boolean; abortThrows?: boolean } = {}) {
  calls = []
  ;(globalThis as { fetch: unknown }).fetch = async (input: unknown, init?: { method?: string }) => {
    const url = String(input);
    calls.push(`${init?.method ?? 'GET'} ${url.split('?')[0]}`);
    if (url.includes('/abort')) {
      if (opts.abortThrows) throw new Error('connection refused');
      return new Response('{}', { status: 200 });
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

  test('a queued command whose newest message is the user remains active', async () => {
    stubFetch([{ info: { role: 'user', time: { completed: 1 } } }]);
    expect(await opencodeTurnInFlight(BASE, WORKSPACE, SESSION)).toBe(true);
  });

  test('an unreadable box is NULL, so the gate refuses instead of restarting', async () => {
    // The bug this closes: returning false here handed the reload a green light
    // while a turn was running and opencode was merely slow to answer.
    stubFetch(null, { messagesOk: false });
    expect(await opencodeTurnInFlight(BASE, WORKSPACE, SESSION)).toBeNull();
  });
});

describe('opencodeDeliveryInFlight — lifecycle acceptance recovery', () => {
  test('a delivered user message without an assistant is active, not terminal', async () => {
    stubFetch([{ info: { id: 'msg_turn_1', role: 'user' } }]);
    expect(await opencodeDeliveryInFlight(BASE, WORKSPACE, SESSION, 'msg_turn_1')).toBe(true);
  });

  test('an incomplete assistant for the exact user message remains active', async () => {
    stubFetch([
      { info: { id: 'msg_turn_1', role: 'user' } },
      { info: { role: 'assistant', parentID: 'msg_turn_1', time: {} } },
    ]);
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
    ]);
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

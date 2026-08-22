import { afterAll, beforeEach, describe, expect, mock, test } from 'bun:test';
import * as realSandboxProxyBackend from '../../sandbox-proxy/backend';

// The reaper's terminal observation says "no turn in flight". It does NOT say
// "the assistant message is closed". `finalizeHuskTurn` is what closes the gap:
// it reads the turn's OWN OpenCode root through the daemon, applies the daemon's
// own open-turn predicate, and — only after a settle re-read agrees — aborts
// that root and PROVES the turn is closed by reading it once more.
//
// Every test drives the real module through a scripted `globalThis.fetch`, so
// the assertions are on the exact URLs, methods and headers that reach the box.

let serviceKey: string | null = 'daemon-service-key';
let fetchCalls: Array<{ url: string; method: string; headers: Record<string, string> }> = [];
let responses: Array<() => Promise<Response>> = [];
const originalFetch = globalThis.fetch;

// Spread the real module: `mock.module` replaces it WHOLESALE, so a stub that
// lists exports by hand deletes every export it omits — the failure surfaces in
// whatever unrelated file imports the missing name next, attributed to no test.
mock.module('../../sandbox-proxy/backend', () => ({
  ...realSandboxProxyBackend,
  resolveServiceKey: async (_externalId: string) => serviceKey,
}));

mock.module('../../compute-nodes', () => ({
  fetchComputeNode: async (
    _externalId: string,
    _port: number,
    path: string,
    init?: RequestInit,
  ) => globalThis.fetch(`https://daemon.example.test${path}`, init),
}));

const { finalizeHuskTurn } = await import('./husk-finalizer');

const TARGET = {
  sandboxId: 'sb-1',
  externalId: 'ext-1',
  opencodeSessionId: 'ses_root',
  messageId: 'msg_turn_1',
};

// The read is TAIL-BOUNDED. `/session/:id/message` returns every message with
// its full `parts` array and the request forces `Accept-Encoding: identity`, so
// an unbounded read drags the whole transcript across the provider ingress —
// and blows READ_TIMEOUT_MS on exactly the long sessions that leave husks.
const READ_URL =
  'https://daemon.example.test/session/ses_root/message?directory=%2Fworkspace&limit=4';
const ABORT_URL = 'https://daemon.example.test/session/ses_root/abort?directory=%2Fworkspace';

/** A `/session/:id/message` body, shaped exactly as OpenCode returns it. */
function transcript(...infos: Array<Record<string, unknown>>): () => Promise<Response> {
  return async () => new Response(JSON.stringify(infos.map((info) => ({ info }))), { status: 200 });
}

function status(code: number): () => Promise<Response> {
  return async () => new Response('{}', { status: code });
}

/** The husk: an assistant message answering TARGET.messageId that never closed. */
const OPEN_TURN = {
  id: 'msg_1',
  role: 'assistant',
  parentID: 'msg_turn_1',
  time: { created: 1 },
};

beforeEach(() => {
  serviceKey = 'daemon-service-key';
  fetchCalls = [];
  responses = [];
  globalThis.fetch = (async (url: unknown, init: unknown) => {
    const request = (init ?? {}) as { method?: string; headers?: Record<string, string> };
    fetchCalls.push({
      url: String(url),
      method: request.method ?? 'GET',
      headers: request.headers ?? {},
    });
    const next = responses.shift();
    if (!next) throw new Error(`unscripted fetch: ${String(url)}`);
    return next();
  }) as typeof fetch;
});

afterAll(() => {
  globalThis.fetch = originalFetch;
});

describe('finalizeHuskTurn', () => {
  test('returns "unreadable" and issues no request when the sandbox has no service key on record', async () => {
    serviceKey = null;

    expect(await finalizeHuskTurn(TARGET, { settleMs: 0 })).toBe('unreadable');
    expect(fetchCalls).toEqual([]);
  });

  test('returns "unreadable" on a non-2xx transcript read and never aborts', async () => {
    responses = [status(503)];

    expect(await finalizeHuskTurn(TARGET, { settleMs: 0 })).toBe('unreadable');
    expect(fetchCalls).toHaveLength(1);
    expect(fetchCalls.every((call) => call.method === 'GET')).toBe(true);
  });

  test('returns "unreadable" when the transcript read throws', async () => {
    responses = [
      async () => {
        throw new DOMException('The operation timed out.', 'TimeoutError');
      },
    ];

    expect(await finalizeHuskTurn(TARGET, { settleMs: 0 })).toBe('unreadable');
    expect(fetchCalls).toHaveLength(1);
  });

  test('returns "not_husk" when the last assistant message carries time.completed', async () => {
    responses = [transcript({ ...OPEN_TURN, time: { created: 1, completed: 2 } })];

    expect(await finalizeHuskTurn(TARGET, { settleMs: 0 })).toBe('not_husk');
    expect(fetchCalls).toHaveLength(1);
  });

  test('returns "not_husk" when the last assistant message carries a non-retryable error', async () => {
    responses = [
      transcript({
        ...OPEN_TURN,
        error: { name: 'APIError', data: { message: 'x', isRetryable: false } },
      }),
    ];

    expect(await finalizeHuskTurn(TARGET, { settleMs: 0 })).toBe('not_husk');
    expect(fetchCalls).toHaveLength(1);
  });

  // The shared-predicate pin: a retryable error is a turn OpenCode still owns,
  // not a closed one. Diverging from opencode-turn-state.ts here would leave the
  // exact class of husk this module exists to close.
  test('treats a retryable error as an OPEN turn', async () => {
    const retryable = {
      ...OPEN_TURN,
      error: { name: 'APIError', data: { message: 'rate limited', isRetryable: true } },
    };
    responses = [
      transcript(retryable),
      transcript(retryable),
      status(200),
      transcript({
        ...OPEN_TURN,
        error: { name: 'MessageAbortedError', data: { message: 'aborted' } },
      }),
    ];

    await finalizeHuskTurn(TARGET, { settleMs: 0 });

    const aborts = fetchCalls.filter((call) => call.method === 'POST');
    expect(aborts).toHaveLength(1);
    expect(aborts[0]?.url).toBe(ABORT_URL);
  });

  // ── ownership: the abort is ROOT-scoped, the terminal evidence is not ──
  // Every prompt of a session runs on one OpenCode root and `activeTurns` holds
  // one record per prompt, so the reaper reaches this module for turn A while
  // turn B is streaming on the SAME root — `opencodeDeliveryInFlight` reports A
  // terminal the moment B's user message follows it. Aborting the root there
  // ends B mid-answer and the UI renders it "Interrupted".
  test('never aborts when the open assistant message answers ANOTHER turn on the same root', async () => {
    responses = [
      transcript(
        { id: 'msg_turn_1', role: 'user' },
        {
          id: 'a_1',
          role: 'assistant',
          parentID: 'msg_turn_1',
          time: { created: 1, completed: 2 },
        },
        { id: 'msg_turn_2', role: 'user' },
        { id: 'a_2', role: 'assistant', parentID: 'msg_turn_2', time: { created: 3 } },
      ),
    ];

    expect(await finalizeHuskTurn(TARGET, { settleMs: 0 })).toBe('not_husk');
    expect(fetchCalls).toHaveLength(1);
    expect(fetchCalls.filter((call) => call.method === 'POST')).toEqual([]);
  });

  // The same shape for a `delivering` record whose prompt never reached
  // OpenCode: no assistant message can belong to it, so nothing may be aborted.
  test('never aborts when this turn has no message on the root at all', async () => {
    responses = [
      transcript(
        { id: 'msg_turn_9', role: 'user' },
        { id: 'a_9', role: 'assistant', parentID: 'msg_turn_9', time: { created: 1 } },
      ),
    ];

    expect(await finalizeHuskTurn(TARGET, { settleMs: 0 })).toBe('not_husk');
    expect(fetchCalls.filter((call) => call.method === 'POST')).toEqual([]);
  });

  test('returns "not_husk" and issues no request when the record carries no messageId', async () => {
    expect(await finalizeHuskTurn({ ...TARGET, messageId: null }, { settleMs: 0 })).toBe(
      'not_husk',
    );
    expect(fetchCalls).toEqual([]);
  });

  test('returns "not_husk" when a newer user message is the last message on the root', async () => {
    responses = [transcript(OPEN_TURN, { id: 'msg_turn_2', role: 'user' })];

    expect(await finalizeHuskTurn(TARGET, { settleMs: 0 })).toBe('not_husk');
    expect(fetchCalls.filter((call) => call.method === 'POST')).toEqual([]);
  });

  test('returns "not_husk" when a newer turn started during the settle window', async () => {
    responses = [transcript(OPEN_TURN), transcript({ ...OPEN_TURN, id: 'msg_2' })];

    expect(await finalizeHuskTurn(TARGET, { settleMs: 0 })).toBe('not_husk');
    expect(fetchCalls.filter((call) => call.method === 'POST')).toEqual([]);
  });

  test('returns "unreadable" when the settle re-read fails', async () => {
    responses = [transcript(OPEN_TURN), status(500)];

    expect(await finalizeHuskTurn(TARGET, { settleMs: 0 })).toBe('unreadable');
    expect(fetchCalls.filter((call) => call.method === 'POST')).toEqual([]);
  });

  test("finalizes and proves it: aborts the turn's OWN OpenCode session, then re-reads", async () => {
    responses = [
      transcript(OPEN_TURN),
      transcript(OPEN_TURN),
      status(200),
      transcript({
        ...OPEN_TURN,
        error: { name: 'MessageAbortedError', data: { message: 'aborted' } },
      }),
    ];

    expect(await finalizeHuskTurn(TARGET, { settleMs: 0 })).toBe('finalized');

    const urls = fetchCalls.map((call) => call.url);
    expect(urls).toEqual([READ_URL, READ_URL, ABORT_URL, READ_URL]);
    expect(fetchCalls[2]?.method).toBe('POST');
    // `/kortix/abort` resolves the PINNED root, not this turn's root, so it can
    // never stand in for the session-scoped abort above.
    expect(urls.some((url) => url.includes('/kortix/abort'))).toBe(false);
  });

  test('returns "unconfirmed" when the post-condition read still shows an open turn', async () => {
    responses = [transcript(OPEN_TURN), transcript(OPEN_TURN), status(200), transcript(OPEN_TURN)];

    expect(await finalizeHuskTurn(TARGET, { settleMs: 0 })).toBe('unconfirmed');
    expect(fetchCalls).toHaveLength(4);
  });

  // ── the read is bounded ──
  // The finalizer needs the tail of the root, never the conversation. An
  // unbounded GET returns every message WITH its `parts` (all tool output),
  // uncompressed, under a 5s timeout — so the repair times out first on the
  // long-running sessions that produce husks, three times per husk, and the
  // record is cleared anyway (box-reaper.ts:227). Same `limit` the sibling
  // readers already send (session-transcript.ts:130).
  test('bounds every transcript read with a limit instead of pulling the whole conversation', async () => {
    responses = [
      transcript(OPEN_TURN),
      transcript(OPEN_TURN),
      status(200),
      transcript({
        ...OPEN_TURN,
        error: { name: 'MessageAbortedError', data: { message: 'aborted' } },
      }),
    ];

    expect(await finalizeHuskTurn(TARGET, { settleMs: 0 })).toBe('finalized');

    const reads = fetchCalls.filter((call) => call.method === 'GET');
    expect(reads).toHaveLength(3);
    for (const read of reads) {
      expect(new URL(read.url).searchParams.get('limit')).toBe('4');
    }
  });

  // ── the post-condition is TARGET-scoped, not last-message-scoped ──
  // 'finalized' is a claim about ONE message. Judging the root's last message
  // instead answers "the target is no longer last" — which is not evidence
  // about the target — and box-reaper.ts:227 then deletes the record, so the
  // still-open husk is never retried and the counter says it was closed.
  test('returns "unconfirmed" when a newer turn follows and the target is STILL open', async () => {
    responses = [
      transcript(OPEN_TURN),
      transcript(OPEN_TURN),
      status(200),
      transcript(
        OPEN_TURN,
        { id: 'msg_turn_2', role: 'user' },
        {
          id: 'msg_2',
          role: 'assistant',
          parentID: 'msg_turn_2',
          time: { created: 3 },
        },
      ),
    ];

    expect(await finalizeHuskTurn(TARGET, { settleMs: 0 })).toBe('unconfirmed');
    expect(fetchCalls).toHaveLength(4);
  });

  test('returns "unconfirmed" when the target message is gone from the post-condition read', async () => {
    responses = [transcript(OPEN_TURN), transcript(OPEN_TURN), status(200), transcript()];

    expect(await finalizeHuskTurn(TARGET, { settleMs: 0 })).toBe('unconfirmed');
    expect(fetchCalls).toHaveLength(4);
  });

  test('returns "unconfirmed" when the abort is declined and the target stays open behind a newer turn', async () => {
    responses = [
      transcript(OPEN_TURN),
      transcript(OPEN_TURN),
      status(500),
      transcript(OPEN_TURN, { id: 'msg_turn_2', role: 'user' }),
    ];

    expect(await finalizeHuskTurn(TARGET, { settleMs: 0 })).toBe('unconfirmed');
    expect(fetchCalls).toHaveLength(4);
  });

  // The other half of target-scoping: the abort landed, and a newer turn opened
  // on the root before the post-condition read. The target reads CLOSED, so the
  // husk really is finalized — a last-message test would have to guess.
  test('finalizes when the target closed even though a newer turn now trails it', async () => {
    responses = [
      transcript(OPEN_TURN),
      transcript(OPEN_TURN),
      status(200),
      transcript(
        { ...OPEN_TURN, error: { name: 'MessageAbortedError', data: { message: 'aborted' } } },
        { id: 'msg_turn_2', role: 'user' },
      ),
    ];

    expect(await finalizeHuskTurn(TARGET, { settleMs: 0 })).toBe('finalized');
  });

  test('every request carries the signed system-reaper context and the service-key bearer', async () => {
    responses = [
      transcript(OPEN_TURN),
      transcript(OPEN_TURN),
      status(200),
      transcript({
        ...OPEN_TURN,
        error: { name: 'MessageAbortedError', data: { message: 'aborted' } },
      }),
    ];

    expect(await finalizeHuskTurn(TARGET, { settleMs: 0 })).toBe('finalized');
    expect(fetchCalls).toHaveLength(4);
    for (const call of fetchCalls) {
      expect(call.headers.Authorization).toBe('Bearer daemon-service-key');
      expect(call.headers['X-Kortix-User-Context']?.length ?? 0).toBeGreaterThan(0);
    }
  });
});

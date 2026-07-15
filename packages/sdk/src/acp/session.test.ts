import { describe, expect, test } from 'bun:test';

import { createAcpSession } from './session';

// ── SSE / JSON-RPC mock ──
// Mirrors `client.test.ts`'s streamOf/sseResponse style, extended with a
// *live* stream controller so a test can push frames into an already-open
// SSE connection on demand (`emitSse`), and per-method call recording so
// assertions can target exactly the RPC(s) they care about.
type RecordedCall = { method: string; url: string; body?: Record<string, unknown> };

function makeSessionFetchMock({ transcript = [] as unknown[], failPrompt = false } = {}) {
  const callsByMethod = new Map<string, RecordedCall[]>();
  const encoder = new TextEncoder();
  let sseConnections = 0;
  let currentController: ReadableStreamDefaultController<Uint8Array> | null = null;
  let lastSseAborted = false;

  function record(method: string, call: RecordedCall) {
    const list = callsByMethod.get(method) ?? [];
    list.push(call);
    callsByMethod.set(method, list);
  }

  const fetchImpl = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = String(input);
    const method = init?.method ?? 'GET';

    if (method === 'GET' && url.endsWith('/transcript')) {
      record('transcript', { method, url });
      return Response.json({ runtime_id: 'r1', envelopes: transcript });
    }

    if (method === 'GET') {
      // The bare-endpoint SSE connect GET (`Accept: text/event-stream`).
      // Stays open indefinitely — `emitSse` pushes frames into it later,
      // `close()`'s AbortSignal is what ends it.
      sseConnections += 1;
      record('sse', { method, url });
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          currentController = controller;
        },
      });
      init?.signal?.addEventListener('abort', () => {
        lastSseAborted = true;
      }, { once: true });
      return new Response(stream, { status: 200, headers: { 'content-type': 'text/event-stream' } });
    }

    const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};
    if (!('method' in body)) {
      // A bare JSON-RPC response envelope with no `method` — this is
      // `AcpClient.respond()`. The real bridge persists it and answers 202.
      record('respond', { method, url, body });
      return new Response(null, { status: 202 });
    }

    record(String(body.method), { method, url, body });
    const respond = (result: unknown) => Response.json({ jsonrpc: '2.0', id: body.id, result });
    switch (body.method) {
      case 'initialize':
        return respond({ protocolVersion: 1, agentCapabilities: {}, authMethods: [], agentInfo: { name: 'test-agent' } });
      case 'session/new':
        return respond({ sessionId: 'acp-new-1', configOptions: [] });
      case 'session/load':
        return respond({ sessionId: (body.params as Record<string, unknown> | undefined)?.sessionId, configOptions: [] });
      case 'session/prompt':
        if (failPrompt) return new Response('boom', { status: 500 });
        return respond({ stopReason: 'end_turn' });
      default:
        return respond({});
    }
  };

  return {
    fetch: fetchImpl as unknown as typeof fetch,
    calls: (method: string) => callsByMethod.get(method) ?? [],
    get sseConnections() {
      return sseConnections;
    },
    get lastSseAborted() {
      return lastSseAborted;
    },
    /** Pushes SSE frames into the live connection and waits for the
     *  consuming stream reader's microtask chain to fully drain, so the
     *  caller can rely on every event having reached the session's onEvent
     *  handler by the time this resolves. */
    async emitSse(events: Array<{ id: number; envelope: unknown }>) {
      if (!currentController) throw new Error('emitSse: no active SSE connection');
      for (const event of events) {
        currentController.enqueue(encoder.encode(`id: ${event.id}\ndata: ${JSON.stringify(event.envelope)}\n\n`));
      }
      await new Promise((resolve) => setTimeout(resolve, 0));
    },
    /** Ends the CURRENT live SSE response body cleanly (as if the server
     *  closed the connection) without aborting the client — this is what
     *  drives the underlying `AcpClient`'s own reconnect loop to fire a NEW
     *  GET, which a test can then answer differently (e.g. a terminal 401/
     *  403/410) to simulate a mid-session, unrecoverable transport failure. */
    endSse() {
      currentController?.close();
      currentController = null;
    },
  };
}

/** Wraps `makeSessionFetchMock` so the FIRST `initialize` POST fails with an
 *  HTTP 500 and every subsequent call (including a retried `initialize`)
 *  goes through to the underlying mock normally. `transcript` is forwarded
 *  as-is (same array reference) to `makeSessionFetchMock` — since the mock
 *  reads it fresh on every `/transcript` GET, a caller can mutate/`push`
 *  onto that same array BETWEEN two `connect()`-driven bootstrap attempts
 *  to make the retried bootstrap's transcript fetch "re-serve" a transcript
 *  with new rows, without needing any further mock plumbing. */
function makeFlakyInitializeFetchMock({ transcript = [] as unknown[] } = {}) {
  const base = makeSessionFetchMock({ transcript });
  let initializeAttempts = 0;

  const fetchImpl = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    if (init?.method === 'POST') {
      const body = init.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};
      if (body.method === 'initialize') {
        initializeAttempts += 1;
        if (initializeAttempts === 1) return new Response('boom', { status: 500 });
      }
    }
    return base.fetch(input, init);
  };

  return {
    ...base,
    fetch: fetchImpl as unknown as typeof fetch,
    get initializeAttempts() {
      return initializeAttempts;
    },
  };
}

function chunkEnvelope(id: number, text: string): { id: number; envelope: unknown } {
  return {
    id,
    envelope: {
      jsonrpc: '2.0',
      method: 'session/update',
      params: { update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } } },
    },
  };
}

async function waitUntil(condition: () => boolean, { timeout = 2000, interval = 5 } = {}): Promise<void> {
  const deadline = Date.now() + timeout;
  for (;;) {
    if (condition()) return;
    if (Date.now() > deadline) throw new Error('waitUntil: timed out');
    await new Promise((resolve) => setTimeout(resolve, interval));
  }
}

describe('AcpSession', () => {
  test('connect is idempotent — one stream, one bootstrap', async () => {
    const fetchMock = makeSessionFetchMock();
    const session = createAcpSession({ endpoint: 'https://api.test/acp/s1', fetch: fetchMock.fetch, scheduleFlush: (f) => f() });

    session.connect();
    session.connect();
    await waitUntil(() => session.getSnapshot().ready);

    expect(fetchMock.sseConnections).toBe(1);
    expect(fetchMock.calls('initialize')).toHaveLength(1);
    expect(fetchMock.calls('session/new')).toHaveLength(1);
  });

  test('getSnapshot identity is stable between emissions and changes after one', async () => {
    const fetchMock = makeSessionFetchMock();
    const session = createAcpSession({ endpoint: 'https://api.test/acp/s1', fetch: fetchMock.fetch, scheduleFlush: (f) => f() });

    session.connect();
    await waitUntil(() => session.getSnapshot().ready);

    const a = session.getSnapshot();
    expect(session.getSnapshot()).toBe(a);

    await fetchMock.emitSse([chunkEnvelope(1, 'x')]);

    expect(session.getSnapshot()).not.toBe(a);
  });

  test('pendingPrompts keeps its identity across an unrelated flush, and changes identity when a request opens or closes', async () => {
    const fetchMock = makeSessionFetchMock();
    const session = createAcpSession({ endpoint: 'https://api.test/acp/s1', fetch: fetchMock.fetch, scheduleFlush: (f) => f() });

    session.connect();
    await waitUntil(() => session.getSnapshot().ready);

    // Establish the baseline AFTER the first real flush — before any flush
    // ever runs, `getSnapshot().pendingPrompts` is still the static
    // `EMPTY_SNAPSHOT` placeholder, which is a different object from
    // anything `derivePendingPrompts` ever produces, so comparing against it
    // would trivially fail regardless of the cache working correctly.
    await fetchMock.emitSse([chunkEnvelope(1, 'x')]);
    const pendingBefore = session.getSnapshot().pendingPrompts;

    // A second, equally unrelated message chunk never touches
    // `openRequests` — the derived `pendingPrompts` object must keep its
    // previous identity so a `memo`-wrapped consumer (e.g.
    // `AcpChatItemRow`) never re-renders purely because an unrelated turn
    // streamed a chunk.
    await fetchMock.emitSse([chunkEnvelope(2, 'y')]);
    expect(session.getSnapshot().pendingPrompts).toBe(pendingBefore);

    await fetchMock.emitSse([{
      id: 3,
      envelope: {
        jsonrpc: '2.0', id: 9, method: 'session/request_permission',
        params: { options: [{ optionId: 'allow', label: 'Allow' }] },
      },
    }]);

    const pendingAfterOpen = session.getSnapshot().pendingPrompts;
    expect(pendingAfterOpen).not.toBe(pendingBefore);
    expect(pendingAfterOpen.permissions).toHaveLength(1);

    await session.respondPermission(9, 'allow');

    expect(session.getSnapshot().pendingPrompts).not.toBe(pendingAfterOpen);
    expect(session.getSnapshot().pendingPrompts.permissions).toHaveLength(0);
  });

  test('events in one flush window coalesce into a single emission', async () => {
    const fetchMock = makeSessionFetchMock();
    let flush: (() => void) | null = null;
    const session = createAcpSession({
      endpoint: 'https://api.test/acp/s1',
      fetch: fetchMock.fetch,
      scheduleFlush: (f) => {
        flush = f;
      },
    });
    session.connect();
    await waitUntil(() => session.getSnapshot().ready);

    // Only count notifications from the SSE burst below — bootstrap's own
    // direct patches (connecting → open/ready) legitimately emit on their
    // own and aren't part of what this test is coalescing.
    let notifications = 0;
    session.subscribe(() => {
      notifications += 1;
    });

    await fetchMock.emitSse([chunkEnvelope(1, 'a'), chunkEnvelope(2, 'b'), chunkEnvelope(3, 'c')]);
    flush!();

    expect(notifications).toBe(1);
    expect(session.getSnapshot().envelopes).toHaveLength(3);
  });

  test('close() aborts the stream and further events are ignored', async () => {
    const fetchMock = makeSessionFetchMock();
    const session = createAcpSession({ endpoint: 'https://api.test/acp/s1', fetch: fetchMock.fetch, scheduleFlush: (f) => f() });

    session.connect();
    await waitUntil(() => session.getSnapshot().connection === 'open');

    session.close();
    expect(fetchMock.lastSseAborted).toBe(true);

    await fetchMock.emitSse([chunkEnvelope(1, 'late')]);

    expect(session.getSnapshot().envelopes).toHaveLength(0);
    expect(session.getSnapshot().connection).toBe('closed');
  });

  test('respondPermission appends a client_to_agent response row after a 202', async () => {
    const fetchMock = makeSessionFetchMock();
    const session = createAcpSession({ endpoint: 'https://api.test/acp/s1', fetch: fetchMock.fetch, scheduleFlush: (f) => f() });

    session.connect();
    await waitUntil(() => session.getSnapshot().ready);

    await session.respondPermission(9, 'allow');

    const respondCalls = fetchMock.calls('respond');
    expect(respondCalls).toHaveLength(1);
    expect(respondCalls[0].body).toEqual({
      jsonrpc: '2.0',
      id: 9,
      result: { outcome: { outcome: 'selected', optionId: 'allow' } },
    });

    const echoed = session.getSnapshot().envelopes.find(
      (row) => row.direction === 'client_to_agent' && (row.envelope as Record<string, unknown>).id === 9,
    );
    expect(echoed).toBeDefined();
    expect((echoed!.envelope as Record<string, unknown>).result).toEqual({
      outcome: { outcome: 'selected', optionId: 'allow' },
    });
  });

  test('send() appends an optimistic client_to_agent prompt row and calls session/prompt', async () => {
    const fetchMock = makeSessionFetchMock();
    const session = createAcpSession({ endpoint: 'https://api.test/acp/s1', fetch: fetchMock.fetch, scheduleFlush: (f) => f() });

    session.connect();
    await waitUntil(() => session.getSnapshot().ready);

    const ok = await session.send([{ type: 'text', text: 'hello' }]);

    expect(ok).toBe(true);
    expect(fetchMock.calls('session/prompt')).toHaveLength(1);
    expect(session.getSnapshot().busy).toBe(false);

    const echoed = session.getSnapshot().envelopes.find(
      (row) => row.direction === 'client_to_agent' && (row.envelope as Record<string, unknown>).method === 'session/prompt',
    );
    expect(echoed).toBeDefined();
  });

  test('send() proceeds when busy comes only from persisted state, and supersedes the orphaned prompt', async () => {
    // Simulates a reload mid-turn: the transcript has an unanswered,
    // uncancelled `session/prompt` from a previous page load — persisted
    // busy is true, but nothing is actually in flight.
    const orphanedPrompt = {
      ordinal: 1,
      direction: 'client_to_agent',
      streamEventId: null,
      envelope: {
        jsonrpc: '2.0', id: 'orphan-1', method: 'session/prompt',
        params: { sessionId: 'acp-new-1', prompt: [{ type: 'text', text: 'stuck mid-turn' }] },
      },
      createdAt: new Date().toISOString(),
    };
    const fetchMock = makeSessionFetchMock({ transcript: [orphanedPrompt] });
    const session = createAcpSession({ endpoint: 'https://api.test/acp/s1', fetch: fetchMock.fetch, scheduleFlush: (f) => f() });

    session.connect();
    await waitUntil(() => session.getSnapshot().ready);

    // Busy purely from the persisted transcript — no live request in flight.
    expect(session.getSnapshot().busy).toBe(true);
    expect(session.getSnapshot().turnState.pendingPromptIds).toEqual(['orphan-1']);

    const ok = await session.send([{ type: 'text', text: 'hello' }]);

    expect(ok).toBe(true);
    expect(fetchMock.calls('session/prompt')).toHaveLength(1);

    // The old orphan is superseded by the new prompt: busy now reflects only
    // the new (already-resolved) request, never permanently wedged.
    expect(session.getSnapshot().busy).toBe(false);
    expect(session.getSnapshot().turnState.pendingPromptIds).toEqual([]);
  });

  test('cancel() enqueues an optimistic local session/cancel row that clears busy without any server row', async () => {
    const busyPrompt = {
      ordinal: 1,
      direction: 'client_to_agent',
      streamEventId: null,
      envelope: {
        jsonrpc: '2.0', id: 'req-1', method: 'session/prompt',
        params: { sessionId: 'acp-new-1', prompt: [{ type: 'text', text: 'go' }] },
      },
      createdAt: new Date().toISOString(),
    };
    const fetchMock = makeSessionFetchMock({ transcript: [busyPrompt] });
    const session = createAcpSession({ endpoint: 'https://api.test/acp/s1', fetch: fetchMock.fetch, scheduleFlush: (f) => f() });

    session.connect();
    await waitUntil(() => session.getSnapshot().ready);

    expect(session.getSnapshot().busy).toBe(true);

    await session.cancel();

    expect(fetchMock.calls('session/cancel')).toHaveLength(1);
    expect(session.getSnapshot().busy).toBe(false);

    const echoed = session.getSnapshot().envelopes.find(
      (row) => row.direction === 'client_to_agent' && (row.envelope as Record<string, unknown>).method === 'session/cancel',
    );
    expect(echoed).toBeDefined();
  });

  test('connect() after close() reopens the stream without re-running bootstrap', async () => {
    const fetchMock = makeSessionFetchMock();
    const session = createAcpSession({ endpoint: 'https://api.test/acp/s1', fetch: fetchMock.fetch, scheduleFlush: (f) => f() });

    session.connect();
    await waitUntil(() => session.getSnapshot().ready);

    session.close();
    session.connect();
    await waitUntil(() => session.getSnapshot().connection === 'open');

    expect(fetchMock.sseConnections).toBe(2);
    expect(fetchMock.calls('session/new')).toHaveLength(1);
  });

  test('a bootstrap failure enters error state; a later connect() retries and succeeds', async () => {
    const fetchMock = makeFlakyInitializeFetchMock();
    const session = createAcpSession({ endpoint: 'https://api.test/acp/s1', fetch: fetchMock.fetch, scheduleFlush: (f) => f() });

    session.connect();
    await waitUntil(() => session.getSnapshot().error?.kind === 'bootstrap');

    expect(session.getSnapshot().ready).toBe(false);
    expect(session.getSnapshot().connection).toBe('failed');

    // The bootstrap failure left `this.stream` alive (SSE keeps retrying on
    // its own) — this second connect() must still re-run bootstrap instead
    // of returning early because a stream already exists.
    session.connect();
    await waitUntil(() => session.getSnapshot().ready);

    expect(fetchMock.initializeAttempts).toBe(2);
    expect(fetchMock.calls('session/new')).toHaveLength(1);
    expect(session.getSnapshot().ready).toBe(true);
  });

  test('a successful bootstrap retry clears the earlier bootstrap error', async () => {
    // Companion to the test above: once a retried `connect()` actually
    // reaches `ready`, the stale failure from the FIRST attempt must not
    // keep surfacing as `snapshot.error` — a consumer (e.g. `useAcpSession`'s
    // `retry()`) that shows an error banner off this field would otherwise
    // display a permanent, misleading error for a session that is now fully
    // functional.
    const fetchMock = makeFlakyInitializeFetchMock();
    const session = createAcpSession({ endpoint: 'https://api.test/acp/s1', fetch: fetchMock.fetch, scheduleFlush: (f) => f() });

    session.connect();
    await waitUntil(() => session.getSnapshot().error?.kind === 'bootstrap');

    session.connect();
    await waitUntil(() => session.getSnapshot().ready);

    expect(session.getSnapshot().error).toBeNull();
  });

  test('send() rolls back the optimistic prompt row when session/prompt rejects', async () => {
    const fetchMock = makeSessionFetchMock({ failPrompt: true });
    const session = createAcpSession({ endpoint: 'https://api.test/acp/s1', fetch: fetchMock.fetch, scheduleFlush: (f) => f() });

    session.connect();
    await waitUntil(() => session.getSnapshot().ready);

    const ok = await session.send([{ type: 'text', text: 'hello' }]);

    expect(ok).toBe(false);
    expect(session.getSnapshot().error).not.toBeNull();

    const promptRow = session.getSnapshot().envelopes.find(
      (row) => row.direction === 'client_to_agent' && (row.envelope as Record<string, unknown>).method === 'session/prompt',
    );
    expect(promptRow).toBeUndefined();

    const userMessage = session.getSnapshot().chatItems.find((item) => item.kind === 'message' && item.role === 'user');
    expect(userMessage).toBeUndefined();
  });

  test('connection state transitions surface in snapshot: connecting then open, and stays open across a live event', async () => {
    const fetchMock = makeSessionFetchMock();
    const session = createAcpSession({ endpoint: 'https://api.test/acp/s1', fetch: fetchMock.fetch, scheduleFlush: (f) => f() });

    const connections: string[] = [];
    session.subscribe(() => {
      const current = session.getSnapshot().connection;
      if (connections[connections.length - 1] !== current) connections.push(current);
    });
    connections.push(session.getSnapshot().connection);

    session.connect();
    await waitUntil(() => session.getSnapshot().connection === 'open');

    expect(connections).toContain('connecting');
    expect(connections[connections.length - 1]).toBe('open');

    await fetchMock.emitSse([chunkEnvelope(1, 'hello')]);

    // A live event must not regress the connection state back to 'connecting'.
    expect(session.getSnapshot().connection).toBe('open');
  });

  /** A fetch mock whose SSE GET fails once (HTTP 500, non-terminal) before
   *  succeeding, so the underlying `AcpClient` retry loop reconnects on its
   *  own — used to exercise the transient-transport-error-then-recovery path. */
  function makeFlakySseFetchMock() {
    const base = makeSessionFetchMock();
    let sseAttempts = 0;

    const fetchImpl = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const url = String(input);
      const method = init?.method ?? 'GET';
      if (method === 'GET' && !url.endsWith('/transcript')) {
        sseAttempts += 1;
        if (sseAttempts === 1) return new Response('boom', { status: 500 });
      }
      return base.fetch(input, init);
    };

    return { ...base, fetch: fetchImpl as unknown as typeof fetch, get sseAttempts() { return sseAttempts; } };
  }

  test('a transient transport error is recorded, then cleared once the reconnect reaches open', async () => {
    const fetchMock = makeFlakySseFetchMock();
    const session = createAcpSession({ endpoint: 'https://api.test/acp/s1', fetch: fetchMock.fetch, scheduleFlush: (f) => f() });

    session.connect();
    await waitUntil(() => session.getSnapshot().error?.kind === 'transport');

    expect(session.getSnapshot().error?.kind).toBe('transport');

    await waitUntil(() => session.getSnapshot().connection === 'open' && session.getSnapshot().error === null);

    expect(fetchMock.sseAttempts).toBeGreaterThanOrEqual(2);
    expect(session.getSnapshot().error).toBeNull();
  });

  /** A fetch mock whose SSE GET succeeds on the FIRST attempt (so a session
   *  can go ready/open and stream real events) and returns a TERMINAL 403
   *  (token expiry / session deleted, mid-session) on exactly the SECOND
   *  attempt — i.e. once the underlying `AcpClient` reconnects after the
   *  first stream ends. Every attempt after that succeeds again, so a
   *  caller-driven retry (a brand new `connect()` call, not the client's own
   *  internal reconnect loop) can re-establish the stream. */
  function makeMidSessionTerminalFetchMock() {
    const base = makeSessionFetchMock();
    let sseAttempts = 0;

    const fetchImpl = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const url = String(input);
      const method = init?.method ?? 'GET';
      if (method === 'GET' && !url.endsWith('/transcript')) {
        sseAttempts += 1;
        if (sseAttempts === 2) return new Response('token expired', { status: 403 });
      }
      return base.fetch(input, init);
    };

    // NOT a `{ ...base, ... }` spread: `base.sseConnections`/`lastSseAborted`
    // are getters, and spreading an object reads a getter ONCE at spread
    // time, flattening it into a static value — every later assertion on
    // the spread copy's `sseConnections` would silently read the same stale
    // number forever. Delegating through a new getter keeps it live.
    return {
      fetch: fetchImpl as unknown as typeof fetch,
      calls: base.calls,
      emitSse: base.emitSse,
      endSse: base.endSse,
      get sseConnections() { return base.sseConnections; },
      get lastSseAborted() { return base.lastSseAborted; },
      get sseAttempts() { return sseAttempts; },
    };
  }

  test('a mid-session terminal stream failure (403 on reconnect) marks the connection failed with a terminal transport error', async () => {
    const fetchMock = makeMidSessionTerminalFetchMock();
    const session = createAcpSession({ endpoint: 'https://api.test/acp/s1', fetch: fetchMock.fetch, scheduleFlush: (f) => f() });

    session.connect();
    await waitUntil(() => session.getSnapshot().connection === 'open');

    // Session ready and items flowing before the failure hits.
    await fetchMock.emitSse([chunkEnvelope(1, 'hello')]);
    expect(session.getSnapshot().chatItems.length).toBeGreaterThan(0);

    // End the live stream — the client's own reconnect loop fires a second
    // GET, which the mock answers with a terminal 403.
    fetchMock.endSse();

    await waitUntil(() => session.getSnapshot().connection === 'failed');

    expect(session.getSnapshot().error?.kind).toBe('transport');
    expect(session.getSnapshot().error?.terminal).toBe(true);
  });

  test('retry after a terminal stream failure opens a brand new SSE connection and clears the transport error on success', async () => {
    const fetchMock = makeMidSessionTerminalFetchMock();
    const session = createAcpSession({ endpoint: 'https://api.test/acp/s1', fetch: fetchMock.fetch, scheduleFlush: (f) => f() });

    session.connect();
    await waitUntil(() => session.getSnapshot().connection === 'open');
    await fetchMock.emitSse([chunkEnvelope(1, 'hello')]);
    fetchMock.endSse();
    await waitUntil(() => session.getSnapshot().connection === 'failed');

    const sseConnectionsBeforeRetry = fetchMock.sseConnections;

    session.connect();
    await waitUntil(() => session.getSnapshot().connection === 'open' && session.getSnapshot().error === null);

    // A genuinely NEW SSE connection was opened (not a no-op retry() left
    // stuck on the dead handle) and the terminal transport error clears.
    expect(fetchMock.sseConnections).toBe(sseConnectionsBeforeRetry + 1);
    expect(session.getSnapshot().error).toBeNull();
  });

  // ── Task 11: optimistic-echo reconciliation by ordinal + idempotent
  // history merge ──
  describe('history merge idempotency + local-echo reconciliation', () => {
    test('a retried bootstrap does not duplicate history rows, incl. a null-streamEventId client_to_agent row', async () => {
      const persistedPrompt = {
        ordinal: 1,
        direction: 'client_to_agent',
        streamEventId: null,
        envelope: {
          jsonrpc: '2.0', id: 'persisted-1', method: 'session/prompt',
          params: { sessionId: 'acp-new-1', prompt: [{ type: 'text', text: 'hi' }] },
        },
        createdAt: new Date().toISOString(),
      };
      const fetchMock = makeFlakyInitializeFetchMock({ transcript: [persistedPrompt] });
      const session = createAcpSession({ endpoint: 'https://api.test/acp/s1', fetch: fetchMock.fetch, scheduleFlush: (f) => f() });

      // First connect(): transcript fetch #1 succeeds, `initialize` 500s —
      // bootstrap resets (`this.bootstrap = null`) for a retry.
      session.connect();
      await waitUntil(() => session.getSnapshot().error?.kind === 'bootstrap');

      // Second connect(): bootstrap reruns from scratch — transcript fetch
      // #2 re-serves the SAME rows.
      session.connect();
      await waitUntil(() => session.getSnapshot().ready);

      expect(fetchMock.calls('transcript')).toHaveLength(2);
      expect(session.getSnapshot().envelopes).toHaveLength(1);
      const promptRows = session.getSnapshot().envelopes.filter(
        (row) => row.direction === 'client_to_agent' && (row.envelope as Record<string, unknown>).method === 'session/prompt',
      );
      expect(promptRows).toHaveLength(1);
      expect(session.getSnapshot().chatItems.filter((item) => item.kind === 'message' && item.role === 'user')).toHaveLength(1);
    });

    test('optimistic send echo is replaced once the server prompt row appears in a re-fetched transcript', async () => {
      const transcript: unknown[] = [];
      const fetchMock = makeFlakyInitializeFetchMock({ transcript });
      // `acpSessionId` supplied up front so `send()` (which only requires a
      // non-null `snapshot.acpSessionId`, not `ready`) can run between the
      // first (failed) and second (retried) bootstrap attempts — exactly
      // the "optimistic echo, then a later history re-fetch reconciles it"
      // ordering that can never happen after a session is already `ready`
      // (bootstrap never reruns post-success through the public API).
      const session = createAcpSession({
        endpoint: 'https://api.test/acp/s1',
        acpSessionId: 'acp-existing-1',
        fetch: fetchMock.fetch,
        scheduleFlush: (f) => f(),
      });

      session.connect();
      await waitUntil(() => session.getSnapshot().error?.kind === 'bootstrap');

      const ok = await session.send([{ type: 'text', text: 'hello' }]);
      expect(ok).toBe(true);

      const localEcho = session.getSnapshot().envelopes.find(
        (row) => row.direction === 'client_to_agent' && (row.envelope as Record<string, unknown>).method === 'session/prompt',
      );
      expect(localEcho).toBeDefined();
      const localId = (localEcho!.envelope as Record<string, unknown>).id;
      expect(typeof localId === 'string' && (localId as string).startsWith('local-')).toBe(true);

      // The server persists the SAME prompt under its OWN real id — never
      // the `local-...` id the optimistic echo used — at a real ordinal.
      transcript.push({
        ordinal: 5,
        direction: 'client_to_agent',
        streamEventId: null,
        envelope: {
          jsonrpc: '2.0', id: 'server-real-id-1', method: 'session/prompt',
          params: { sessionId: 'acp-existing-1', prompt: [{ type: 'text', text: 'hello' }] },
        },
        createdAt: new Date().toISOString(),
      });

      session.connect();
      await waitUntil(() => session.getSnapshot().ready);

      const promptChatItems = session.getSnapshot().chatItems.filter((item) => item.kind === 'message' && item.role === 'user');
      expect(promptChatItems).toHaveLength(1);

      const promptRows = session.getSnapshot().envelopes.filter(
        (row) => row.direction === 'client_to_agent' && (row.envelope as Record<string, unknown>).method === 'session/prompt',
      );
      expect(promptRows).toHaveLength(1);
      expect((promptRows[0].envelope as Record<string, unknown>).id).toBe('server-real-id-1');
    });

    test('respond echo is replaced once the server response row appears in a re-fetched transcript', async () => {
      const permissionRequest = {
        ordinal: 1,
        direction: 'agent_to_client',
        streamEventId: 1,
        envelope: {
          jsonrpc: '2.0', id: 42, method: 'session/request_permission',
          params: { sessionId: 'acp-new-1', toolCall: { title: 'run it' }, options: [{ optionId: 'allow', name: 'Allow' }] },
        },
        createdAt: new Date().toISOString(),
      };
      const transcript: unknown[] = [permissionRequest];
      const fetchMock = makeFlakyInitializeFetchMock({ transcript });
      const session = createAcpSession({ endpoint: 'https://api.test/acp/s1', fetch: fetchMock.fetch, scheduleFlush: (f) => f() });

      session.connect();
      await waitUntil(() => session.getSnapshot().error?.kind === 'bootstrap');

      expect(session.getSnapshot().pendingPrompts.permissions).toHaveLength(1);

      await session.respondPermission(42, 'allow');
      expect(session.getSnapshot().pendingPrompts.permissions).toHaveLength(0);

      const localEcho = session.getSnapshot().envelopes.find(
        (row) => row.direction === 'client_to_agent' && (row.envelope as Record<string, unknown>).id === 42,
      );
      expect(localEcho).toBeDefined();
      expect(localEcho!.createdAt).toBeUndefined();

      // The server persists the client's own response row too, at a real
      // ordinal — simulated here via a re-fetched transcript (the ONLY
      // transport that ever redelivers a `client_to_agent` row; live
      // SSE/poll only ever replay `agent_to_client`, per `AcpClient`).
      transcript.push({
        ordinal: 2,
        direction: 'client_to_agent',
        streamEventId: null,
        envelope: { jsonrpc: '2.0', id: 42, result: { outcome: { outcome: 'selected', optionId: 'allow' } } },
        createdAt: new Date().toISOString(),
      });

      session.connect();
      await waitUntil(() => session.getSnapshot().ready);

      expect(session.getSnapshot().pendingPrompts.permissions).toHaveLength(0);
      const responseRows = session.getSnapshot().envelopes.filter(
        (row) => row.direction === 'client_to_agent' && (row.envelope as Record<string, unknown>).id === 42,
      );
      expect(responseRows).toHaveLength(1);
      expect(responseRows[0].createdAt).toBeDefined();
    });
  });
});

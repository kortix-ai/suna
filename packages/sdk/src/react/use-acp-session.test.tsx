import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import { StrictMode, type ComponentType, type ReactNode } from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';

import { projectAcpPendingPrompts } from '../acp';
import { configureKortix } from '../core/http/config';
import { useAcpSession } from './use-acp-session';

// react-test-renderer's `act` only suppresses its "not configured" warning
// when this flag is set — there is no jsdom/testing-library setup file in
// this package to do it globally, so it is set here instead.
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

// ── sessionStorage stub ──
// `useAcpSession` reads the start-stash via `readStartStash`, which wraps
// every `sessionStorage` access in try/catch — so it never crashes without a
// DOM — but stubbing it (as `session-start-stash.test.ts` does) keeps the
// effect's start-stash branch inert instead of relying on a caught
// ReferenceError, and matches this package's existing test convention.
class MemoryStorage {
  private map = new Map<string, string>();
  getItem(key: string): string | null {
    return this.map.has(key) ? this.map.get(key)! : null;
  }
  setItem(key: string, value: string): void {
    this.map.set(key, value);
  }
  removeItem(key: string): void {
    this.map.delete(key);
  }
  clear(): void {
    this.map.clear();
  }
}

beforeEach(() => {
  (globalThis as any).sessionStorage = new MemoryStorage();
  configureKortix({ backendUrl: 'https://api.test/v1', getToken: async () => 'tok' });
});

afterEach(() => {
  delete (globalThis as any).sessionStorage;
});

// ── ACP fetch mock ──
// `useAcpSession` reaches the ACP bridge through `authenticatedFetch`, which
// calls the *global* `fetch` directly (see `core/http/auth.ts`), so — same as
// `core/rest/projects-client/session-sandbox.test.ts` — the mock is installed
// on `globalThis.fetch`, not injected into `createAcpClient`.
type AcpTranscriptRow = {
  ordinal: number;
  direction: 'client_to_agent' | 'agent_to_client';
  streamEventId: number | null;
  envelope: Record<string, unknown>;
  createdAt?: string;
};

type RecordedCall = { method: string; url: string; body?: Record<string, unknown> };

function makeAcpFetchMock({ transcript = [] as AcpTranscriptRow[] } = {}) {
  const calls: RecordedCall[] = [];
  let sseAborted = false;
  const fetchImpl = async (
    input: unknown,
    init?: { method?: string; headers?: unknown; body?: string; signal?: AbortSignal },
  ): Promise<Response> => {
    const url = String(input);
    const method = init?.method ?? 'GET';

    if (method === 'GET' && url.endsWith('/transcript')) {
      calls.push({ method, url });
      return Response.json({ runtime_id: 'r1', envelopes: transcript });
    }

    if (method === 'GET') {
      // The SSE connect GET. Never enqueues or closes on its own — the
      // hook's `connect()` just stays open for the duration of the test,
      // exactly like a live stream with no new server events. `close()`
      // (unmount's effect cleanup) aborts `init.signal`, observed here.
      calls.push({ method, url });
      const stream = new ReadableStream<Uint8Array>({ start() {} });
      init?.signal?.addEventListener('abort', () => { sseAborted = true; }, { once: true });
      return new Response(stream, { status: 200, headers: { 'content-type': 'text/event-stream' } });
    }

    const body = init?.body ? (JSON.parse(init.body) as Record<string, unknown>) : {};
    calls.push({ method, url, body });

    if (!('method' in body)) {
      // A bare JSON-RPC response envelope with no `method` — this is
      // `AcpClient.respond()`. The real bridge persists it and answers 202.
      return new Response(null, { status: 202 });
    }

    const respond = (result: unknown) => Response.json({ jsonrpc: '2.0', id: body.id, result });
    switch (body.method) {
      case 'initialize':
        return respond({ protocolVersion: 1, agentCapabilities: {}, authMethods: [], agentInfo: { name: 'test-agent' } });
      case 'session/new':
        return respond({ sessionId: 'acp-new-1', configOptions: [] });
      case 'session/load':
        return respond({ sessionId: (body.params as Record<string, unknown> | undefined)?.sessionId, configOptions: [] });
      case 'session/prompt':
        return respond({ stopReason: 'end_turn' });
      default:
        return respond({});
    }
  };
  return { fetchImpl, calls, get sseAborted() { return sseAborted; } };
}

/** Wraps `makeAcpFetchMock` so the FIRST `initialize` POST fails with an HTTP
 *  500 and every subsequent call (including a retried `initialize`) goes
 *  through normally — mirrors `acp/session.test.ts`'s
 *  `makeFlakyInitializeFetchMock`, adapted to this file's mock shape. */
function makeFlakyInitializeFetchMock({ transcript = [] as AcpTranscriptRow[] } = {}) {
  const base = makeAcpFetchMock({ transcript });
  let initializeAttempts = 0;
  const fetchImpl = async (
    input: unknown,
    init?: { method?: string; headers?: unknown; body?: string; signal?: AbortSignal },
  ): Promise<Response> => {
    if (init?.method === 'POST') {
      const body = init.body ? (JSON.parse(init.body) as Record<string, unknown>) : {};
      if (body.method === 'initialize') {
        initializeAttempts += 1;
        if (initializeAttempts === 1) return new Response('boom', { status: 500 });
      }
    }
    return base.fetchImpl(input, init);
  };
  return { ...base, fetchImpl, get initializeAttempts() { return initializeAttempts; } };
}

// ── minimal renderHook/waitFor over react-test-renderer ──
// This package has no DOM/jsdom/@testing-library dependency anywhere (see
// `src/react/*.test.ts`, all pure-function tests). `react-test-renderer` is
// the standard DOM-free React renderer, so a small local harness is built on
// top of it rather than reaching for `@testing-library/react` + jsdom, which
// nothing else in this monorepo uses.
function renderHook<TResult>(
  callback: () => TResult,
  options?: { wrapper?: ComponentType<{ children?: ReactNode }> },
) {
  const result: { current: TResult } = { current: undefined as unknown as TResult };
  function Harness() {
    result.current = callback();
    return null;
  }
  const Wrapper = options?.wrapper;
  let renderer!: ReactTestRenderer;
  act(() => {
    renderer = create(Wrapper ? <Wrapper><Harness /></Wrapper> : <Harness />);
  });
  return {
    result,
    unmount() {
      act(() => {
        renderer.unmount();
      });
    },
  };
}

// Filters the fetch mock's recorded calls down to JSON-RPC POSTs for a given
// ACP method (e.g. `session/new`) — `RecordedCall.body` is only present on
// POSTs, and only JSON-RPC request bodies carry a `method` field (see
// `makeAcpFetchMock`: a bare response envelope has no `method`).
function rpcCallsFor(calls: RecordedCall[], method: string): RecordedCall[] {
  return calls.filter((call) => call.method === 'POST' && call.body?.method === method);
}

async function waitFor(assertion: () => void, { timeout = 2000, interval = 10 } = {}): Promise<void> {
  const deadline = Date.now() + timeout;
  for (;;) {
    try {
      assertion();
      return;
    } catch (error) {
      if (Date.now() > deadline) throw error;
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, interval));
      });
    }
  }
}

describe('useAcpSession — optimistic response echo', () => {
  test('respondPermission clears the pending permission without a reload', async () => {
    const permissionRequest: AcpTranscriptRow = {
      ordinal: 5,
      direction: 'agent_to_client',
      streamEventId: 5,
      envelope: {
        jsonrpc: '2.0',
        id: 9,
        method: 'session/request_permission',
        params: { sessionId: 's1', options: [{ optionId: 'allow', label: 'Allow' }] },
      },
      createdAt: '2026-07-14T00:00:00Z',
    };
    const { fetchImpl, calls } = makeAcpFetchMock({ transcript: [permissionRequest] });
    globalThis.fetch = mock(fetchImpl) as unknown as typeof fetch;

    const { result, unmount } = renderHook(() =>
      useAcpSession({ projectId: 'p1', sessionId: 's1', runtimeSessionId: 'acp-1' }),
    );

    try {
      await waitFor(() => expect(result.current.ready).toBe(true));
      expect(projectAcpPendingPrompts(result.current.envelopes).permissions).toHaveLength(1);

      const callsBeforeRespond = calls.length;
      await act(async () => {
        await result.current.respondPermission(9, 'allow');
      });

      // No reload, no new server event — the pending permission must clear
      // purely from the locally-appended response envelope.
      expect(projectAcpPendingPrompts(result.current.envelopes).permissions).toHaveLength(0);

      const respondCalls = calls.slice(callsBeforeRespond).filter((call) => call.method === 'POST');
      expect(respondCalls).toHaveLength(1);
      expect(respondCalls[0].body).toEqual({
        jsonrpc: '2.0',
        id: 9,
        result: { outcome: { outcome: 'selected', optionId: 'allow' } },
      });
    } finally {
      unmount();
    }
  });

  test('rejectQuestion clears the pending question without a reload', async () => {
    const questionRequest: AcpTranscriptRow = {
      ordinal: 6,
      direction: 'agent_to_client',
      streamEventId: 6,
      envelope: {
        jsonrpc: '2.0',
        id: 11,
        // `elicitation/create` is a real, exact-match question method
        // (`classifyAcpMethod`, `../acp/reduce`). The previous fixture used
        // the fabricated `session/elicitation_request`, which only rendered
        // as a question under the old substring-sniffing `isQuestionMethod`
        // (matched because it contained both "elicitation" and "request") —
        // that bug is exactly what Task 7's exact-match table removes.
        method: 'elicitation/create',
        params: { sessionId: 's1', message: 'Pick one', options: [{ optionId: 'a', label: 'A' }] },
      },
      createdAt: '2026-07-14T00:00:00Z',
    };
    const { fetchImpl, calls } = makeAcpFetchMock({ transcript: [questionRequest] });
    globalThis.fetch = mock(fetchImpl) as unknown as typeof fetch;

    const { result, unmount } = renderHook(() =>
      useAcpSession({ projectId: 'p1', sessionId: 's1', runtimeSessionId: 'acp-1' }),
    );

    try {
      await waitFor(() => expect(result.current.ready).toBe(true));
      expect(projectAcpPendingPrompts(result.current.envelopes).questions).toHaveLength(1);

      const callsBeforeRespond = calls.length;
      await act(async () => {
        await result.current.rejectQuestion(11);
      });

      expect(projectAcpPendingPrompts(result.current.envelopes).questions).toHaveLength(0);

      const respondCalls = calls.slice(callsBeforeRespond).filter((call) => call.method === 'POST');
      expect(respondCalls).toHaveLength(1);
      expect(respondCalls[0].body).toEqual({
        jsonrpc: '2.0',
        id: 11,
        result: { action: 'decline' },
      });
    } finally {
      unmount();
    }
  });
});

describe('useAcpSession — session/new is minted at most once', () => {
  // This is the literal test from the Task 4 brief. Against the OLD
  // per-hook `createdSessionIdRef` guard it was deterministically red under
  // StrictMode: the effect's cleanup and its second mount run synchronously,
  // back-to-back, *before* either async bootstrap awaited far enough to reach
  // the `id` check, so both invocations' async IIFEs read
  // `createdSessionIdRef.current` while it was still null and both called
  // `session/new` — a ref guards sequential re-runs, not two concurrently
  // in-flight runs racing the same unset ref.
  //
  // Task 14 rewires the hook onto `AcpSession` (`../acp/session.ts`), whose
  // `connect()` makes bootstrap single-flight via `this.bootstrap ??=
  // this.runBootstrap()` at the SESSION level, not the per-render ref level —
  // StrictMode's second mount reuses the SAME memoized `session` instance
  // (see the hook's `useMemo` keyed on `[projectId, sessionId,
  // runtimeSessionId]`), so its second `connect()` call sees `this.bootstrap`
  // already set and never re-runs `runBootstrap()`. That closes the race this
  // test was written to catch — it was `test.failing` for exactly this
  // reason (documented, CI-visible, flips to a hard failure the moment the
  // race closes) and is now a regular passing test.
  test('StrictMode double-mount creates exactly one ACP session', async () => {
    const { fetchImpl, calls } = makeAcpFetchMock({ transcript: [] });
    globalThis.fetch = mock(fetchImpl) as unknown as typeof fetch;

    const { result, unmount } = renderHook(
      () => useAcpSession({ projectId: 'p1', sessionId: 's1', runtimeSessionId: null }),
      { wrapper: StrictMode },
    );

    try {
      await waitFor(() => expect(result.current.ready).toBe(true));
      expect(rpcCallsFor(calls, 'session/new')).toHaveLength(1);
    } finally {
      unmount();
    }
  });

  test('enabled: false -> true reuses the created session instead of minting a new one', async () => {
    // Belt-and-suspenders alongside the StrictMode test above, updated for
    // the Task 14 rewrite: the hook's connect effect now depends on
    // `[enabled, session]` only (`session` itself is memoized on
    // `[projectId, sessionId, runtimeSessionId]`, which never change here),
    // so toggling `enabled` off then back on re-runs the effect — `close()`
    // on the way out, `connect()` on the way back in — against the SAME
    // `AcpSession` instance. Unlike the old per-render hook (where a re-run
    // re-executed the whole init sequence and issued a `session/load` to
    // "reuse" the created session), the store's `connect()` is a true no-op
    // on an already-resolved `this.bootstrap`: neither a second `session/new`
    // NOR a `session/load` is issued at all.
    const { fetchImpl, calls } = makeAcpFetchMock({ transcript: [] });
    globalThis.fetch = mock(fetchImpl) as unknown as typeof fetch;

    function Harness({ enabled }: { enabled: boolean }) {
      return useAcpSession({ projectId: 'p1', sessionId: 's1', runtimeSessionId: null, enabled });
    }
    const result: { current: ReturnType<typeof useAcpSession> } = { current: undefined as unknown as ReturnType<typeof useAcpSession> };
    function Wrapped(props: { enabled: boolean }) {
      result.current = Harness(props);
      return null;
    }
    let renderer!: ReactTestRenderer;
    act(() => {
      renderer = create(<Wrapped enabled={true} />);
    });

    try {
      await waitFor(() => expect(result.current.ready).toBe(true));
      expect(rpcCallsFor(calls, 'session/new')).toHaveLength(1);

      // Disable, then re-enable — the connect effect's cleanup (`close()`)
      // runs, then the effect body (`connect()`) re-runs.
      act(() => {
        renderer.update(<Wrapped enabled={false} />);
      });
      act(() => {
        renderer.update(<Wrapped enabled={true} />);
      });
      await waitFor(() => expect(result.current.connection).toBe('open'));

      expect(rpcCallsFor(calls, 'session/new')).toHaveLength(1);
      expect(rpcCallsFor(calls, 'session/load')).toHaveLength(0);
    } finally {
      act(() => {
        renderer.unmount();
      });
    }
  });
});

describe('useAcpSession — useSyncExternalStore wrapper over AcpSession (Task 14)', () => {
  test('unmounting closes the stream — the SSE fetch signal is aborted', async () => {
    // `sseAborted` is a getter on the mock object — read it THROUGH the
    // object (`fetchMock.sseAborted`), not destructured, or the destructure
    // would freeze a snapshot of its value at that instant instead of a live
    // reference to the mutable closure variable behind the getter.
    const fetchMock = makeAcpFetchMock({ transcript: [] });
    globalThis.fetch = mock(fetchMock.fetchImpl) as unknown as typeof fetch;

    const { result, unmount } = renderHook(() =>
      useAcpSession({ projectId: 'p1', sessionId: 's1', runtimeSessionId: null }),
    );

    await waitFor(() => expect(result.current.ready).toBe(true));
    expect(fetchMock.sseAborted).toBe(false);

    unmount();

    expect(fetchMock.sseAborted).toBe(true);
    // Cleanup is `session.close()`, not a teardown of the whole session —
    // no further bootstrap RPC is issued just because the component unmounted.
    expect(rpcCallsFor(fetchMock.calls, 'session/new')).toHaveLength(1);
  });

  test('snapshot identity is stable across a render with no new events', async () => {
    const { fetchImpl } = makeAcpFetchMock({ transcript: [] });
    globalThis.fetch = mock(fetchImpl) as unknown as typeof fetch;

    function Harness({ tick }: { tick: number }) {
      void tick;
      return useAcpSession({ projectId: 'p1', sessionId: 's1', runtimeSessionId: null });
    }
    const result: { current: ReturnType<typeof useAcpSession> } = { current: undefined as unknown as ReturnType<typeof useAcpSession> };
    function Wrapped(props: { tick: number }) {
      result.current = Harness(props);
      return null;
    }
    let renderer!: ReactTestRenderer;
    act(() => {
      renderer = create(<Wrapped tick={0} />);
    });

    try {
      await waitFor(() => expect(result.current.ready).toBe(true));
      const envelopesBefore = result.current.envelopes;

      // Force a re-render of the tree with no change relevant to the
      // memoized session (`projectId`/`sessionId`/`runtimeSessionId`) and no
      // new store event in between — `useSyncExternalStore` must hand back
      // the exact same `envelopes` reference, not a fresh array.
      act(() => {
        renderer.update(<Wrapped tick={1} />);
      });

      expect(result.current.envelopes).toBe(envelopesBefore);
    } finally {
      act(() => {
        renderer.unmount();
      });
    }
  });

  test('exposes chatItems/pendingPrompts/usage from the snapshot, stable across an unrelated re-render', async () => {
    const permissionRequest: AcpTranscriptRow = {
      ordinal: 1,
      direction: 'agent_to_client',
      streamEventId: 1,
      envelope: {
        jsonrpc: '2.0',
        id: 9,
        method: 'session/request_permission',
        params: { sessionId: 's1', options: [{ optionId: 'allow', label: 'Allow' }] },
      },
      createdAt: '2026-07-14T00:00:00Z',
    };
    const { fetchImpl } = makeAcpFetchMock({ transcript: [permissionRequest] });
    globalThis.fetch = mock(fetchImpl) as unknown as typeof fetch;

    function Harness({ tick }: { tick: number }) {
      void tick;
      return useAcpSession({ projectId: 'p1', sessionId: 's1', runtimeSessionId: 'acp-1' });
    }
    const result: { current: ReturnType<typeof useAcpSession> } = { current: undefined as unknown as ReturnType<typeof useAcpSession> };
    function Wrapped(props: { tick: number }) {
      result.current = Harness(props);
      return null;
    }
    let renderer!: ReactTestRenderer;
    act(() => {
      renderer = create(<Wrapped tick={0} />);
    });

    try {
      await waitFor(() => expect(result.current.ready).toBe(true));
      expect(result.current.chatItems).toEqual([{ kind: 'permission', id: 9, method: 'session/request_permission', params: { sessionId: 's1', options: [{ optionId: 'allow', label: 'Allow' }] } }]);
      expect(result.current.pendingPrompts.permissions).toHaveLength(1);
      expect(result.current.usage).toBeNull();

      const chatItemsBefore = result.current.chatItems;
      const pendingPromptsBefore = result.current.pendingPrompts;

      // Re-render the tree with no change relevant to the memoized session
      // and no new store event in between — identical to the `envelopes`
      // identity test above, but for the two derived fields Task 16 hands
      // straight to a `memo`-wrapped `AcpChatItemRow` as props.
      act(() => {
        renderer.update(<Wrapped tick={1} />);
      });

      expect(result.current.chatItems).toBe(chatItemsBefore);
      expect(result.current.pendingPrompts).toBe(pendingPromptsBefore);
    } finally {
      act(() => {
        renderer.unmount();
      });
    }
  });

  test('retry() after a terminal bootstrap failure re-runs bootstrap and reaches ready', async () => {
    // `initializeAttempts` is a getter — read it THROUGH the mock object
    // (`fetchMock.initializeAttempts`), not destructured (see the
    // `sseAborted` note above for why a destructure would freeze it at 0).
    const fetchMock = makeFlakyInitializeFetchMock({ transcript: [] });
    globalThis.fetch = mock(fetchMock.fetchImpl) as unknown as typeof fetch;

    const { result, unmount } = renderHook(() =>
      useAcpSession({ projectId: 'p1', sessionId: 's1', runtimeSessionId: null }),
    );

    try {
      await waitFor(() => expect(result.current.connection).toBe('failed'));
      expect(result.current.ready).toBe(false);
      expect(result.current.error).not.toBeNull();
      expect(result.current.errorInfo).not.toBeNull();
      expect(result.current.errorInfo?.kind).toBe('bootstrap');

      await act(async () => {
        result.current.retry();
      });

      await waitFor(() => expect(result.current.ready).toBe(true));
      expect(fetchMock.initializeAttempts).toBe(2);
      expect(rpcCallsFor(fetchMock.calls, 'session/new')).toHaveLength(1);
      expect(result.current.error).toBeNull();
      expect(result.current.errorInfo).toBeNull();
    } finally {
      unmount();
    }
  });

  test('runtimeSessionId is a deprecated alias for acpSessionId', async () => {
    const { fetchImpl } = makeAcpFetchMock({ transcript: [] });
    globalThis.fetch = mock(fetchImpl) as unknown as typeof fetch;

    const { result, unmount } = renderHook(() =>
      useAcpSession({ projectId: 'p1', sessionId: 's1', runtimeSessionId: null }),
    );

    try {
      await waitFor(() => expect(result.current.ready).toBe(true));
      expect(result.current.acpSessionId).toBe('acp-new-1');
      expect(result.current.runtimeSessionId).toBe(result.current.acpSessionId);
    } finally {
      unmount();
    }
  });

  test('connection surfaces the session store\'s connection lifecycle', async () => {
    // A component that has unmounted no longer re-renders, so the 'closed'
    // transition on `close()` can't be observed through `result.current`
    // after `unmount()` — that's correct React behavior, not something to
    // work around. Instead this records every `connection` value seen across
    // renders (including the very first, pre-`connect()` one) to assert the
    // full 'idle' -> ... -> 'open' lifecycle the hook surfaces while mounted;
    // the 'closed' half of the lifecycle is covered separately by "unmounting
    // closes the stream" above (which observes the underlying fetch abort).
    const { fetchImpl } = makeAcpFetchMock({ transcript: [] });
    globalThis.fetch = mock(fetchImpl) as unknown as typeof fetch;

    const seen: string[] = [];
    const result: { current: ReturnType<typeof useAcpSession> } = { current: undefined as unknown as ReturnType<typeof useAcpSession> };
    function Harness() {
      result.current = useAcpSession({ projectId: 'p1', sessionId: 's1', runtimeSessionId: null });
      seen.push(result.current.connection);
      return null;
    }
    let renderer!: ReactTestRenderer;
    act(() => {
      renderer = create(<Harness />);
    });

    try {
      await waitFor(() => expect(result.current.connection).toBe('open'));
      expect(result.current.ready).toBe(true);
      expect(seen[0]).toBe('idle');
      expect(seen).toContain('connecting');
      expect(seen[seen.length - 1]).toBe('open');
    } finally {
      act(() => {
        renderer.unmount();
      });
    }
  });

  test('start-stash replay fires exactly once after ready', async () => {
    const { fetchImpl, calls } = makeAcpFetchMock({ transcript: [] });
    globalThis.fetch = mock(fetchImpl) as unknown as typeof fetch;
    (globalThis as any).sessionStorage.setItem('kortix:start:s1', JSON.stringify({ prompt: 'hello from stash', model: null, agent: null }));

    const { result, unmount } = renderHook(() =>
      useAcpSession({ projectId: 'p1', sessionId: 's1', runtimeSessionId: null }),
    );

    try {
      await waitFor(() => expect(rpcCallsFor(calls, 'session/prompt')).toHaveLength(1));
      expect(rpcCallsFor(calls, 'session/prompt')[0].body).toMatchObject({
        method: 'session/prompt',
        params: { prompt: [{ type: 'text', text: 'hello from stash' }] },
      });
      // The stash must be cleared — a later re-render/re-mount must not replay it again.
      expect((globalThis as any).sessionStorage.getItem('kortix:start:s1')).toBeNull();

      await waitFor(() => expect(result.current.ready).toBe(true));
      expect(rpcCallsFor(calls, 'session/prompt')).toHaveLength(1);
    } finally {
      unmount();
    }
  });

  test('autoApprovePermissions auto-responds pending permissions exactly once', async () => {
    const permissionRequest: AcpTranscriptRow = {
      ordinal: 5,
      direction: 'agent_to_client',
      streamEventId: 5,
      envelope: {
        jsonrpc: '2.0',
        id: 9,
        method: 'session/request_permission',
        params: { sessionId: 's1', options: [{ optionId: 'allow', kind: 'allow_once', label: 'Allow' }] },
      },
      createdAt: '2026-07-14T00:00:00Z',
    };
    const { fetchImpl, calls } = makeAcpFetchMock({ transcript: [permissionRequest] });
    globalThis.fetch = mock(fetchImpl) as unknown as typeof fetch;

    function Harness({ tick }: { tick: number }) {
      void tick;
      return useAcpSession({ projectId: 'p1', sessionId: 's1', runtimeSessionId: 'acp-1' });
    }
    const result: { current: ReturnType<typeof useAcpSession> } = { current: undefined as unknown as ReturnType<typeof useAcpSession> };
    function Wrapped(props: { tick: number }) {
      result.current = Harness(props);
      return null;
    }
    let renderer!: ReactTestRenderer;
    act(() => {
      renderer = create(<Wrapped tick={0} />);
    });

    try {
      await waitFor(() => expect(result.current.ready).toBe(true));
      expect(result.current.pendingPrompts.permissions).toHaveLength(1);

      // Initially autoApprovePermissions is false; permission stays pending
      expect(result.current.autoApprovePermissions).toBe(false);

      // Record the number of respond-type POSTs before enabling auto-approve
      const respondCallsBefore = calls.filter(
        (call) => call.method === 'POST' && call.body && !('method' in call.body),
      ).length;

      // Enable auto-approve
      await act(async () => {
        result.current.setAutoApprovePermissions(true);
      });

      // Wait for the auto-response to be recorded
      await waitFor(() => {
        const respondCallsNow = calls.filter(
          (call) => call.method === 'POST' && call.body && !('method' in call.body),
        ).length;
        expect(respondCallsNow).toBeGreaterThan(respondCallsBefore);
      });

      // Pending list must clear
      expect(result.current.pendingPrompts.permissions).toHaveLength(0);

      // Assert the response body is correct
      const respondCalls = calls.filter(
        (call) => call.method === 'POST' && call.body && !('method' in call.body),
      );
      expect(respondCalls).toHaveLength(1);
      expect(respondCalls[0].body).toEqual({
        jsonrpc: '2.0',
        id: 9,
        result: { outcome: { outcome: 'selected', optionId: 'allow' } },
      });

      // Re-render with a different tick to verify no duplicate response is issued
      const respondCallsBeforeRerender = calls.filter(
        (call) => call.method === 'POST' && call.body && !('method' in call.body),
      ).length;
      act(() => {
        renderer.update(<Wrapped tick={1} />);
      });

      // Expect no new respond POST (only the original one)
      const respondCallsAfterRerender = calls.filter(
        (call) => call.method === 'POST' && call.body && !('method' in call.body),
      ).length;
      expect(respondCallsAfterRerender).toBe(respondCallsBeforeRerender);
    } finally {
      act(() => {
        renderer.unmount();
      });
    }
  });
});

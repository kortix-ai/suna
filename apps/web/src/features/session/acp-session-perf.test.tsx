import { describe, expect, test } from 'bun:test';
import { Profiler, type ProfilerOnRenderCallback } from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';

import { createAcpSession, type AcpSession } from '@kortix/sdk/acp';
import type { AcpSessionChat as AcpSessionChatType } from './acp-session-chat';
import fixtureRows from './__fixtures__/acp-replay-session.json';

// Same DOM-free harness `acp-session-chat.test.tsx`/`acp-chat-item-row.test.tsx`
// use — no jsdom in this workspace, so `react-test-renderer` + manual `act()`,
// with the minimal browser-global stubs Radix/`motion`/`Disclosure`'s
// `useId` reach for during mount/unmount. Must be set up before the first
// `import('./acp-session-chat')` below, same as the sibling test file.
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

if (typeof (globalThis as any).window === 'undefined') {
  (globalThis as any).window = globalThis;
}
if (typeof (globalThis as any).matchMedia === 'undefined') {
  (globalThis as any).matchMedia = () => ({
    matches: false,
    media: '',
    addEventListener: () => {},
    removeEventListener: () => {},
    addListener: () => {},
    removeListener: () => {},
    dispatchEvent: () => false,
  });
}
if (typeof (globalThis as any).document === 'undefined') {
  const stubElement = () => ({ appendChild: () => {}, style: {} }) as { appendChild: () => void; style: Record<string, unknown> };
  (globalThis as any).document = {
    addEventListener: () => {},
    removeEventListener: () => {},
    activeElement: null,
    documentElement: stubElement(),
    head: stubElement(),
    body: stubElement(),
    getElementsByTagName: () => [stubElement()],
    createElement: () => ({ ...stubElement(), styleSheet: undefined }),
    createTextNode: () => ({}),
  };
}
if (typeof (globalThis as any).requestAnimationFrame === 'undefined') {
  (globalThis as any).requestAnimationFrame = (cb: FrameRequestCallback) => setTimeout(() => cb(Date.now()), 0) as unknown as number;
  (globalThis as any).cancelAnimationFrame = (handle: number) => clearTimeout(handle);
}
if (typeof (globalThis as any).localStorage === 'undefined') {
  const store = new Map<string, string>();
  (globalThis as any).localStorage = {
    getItem: (key: string) => (store.has(key) ? store.get(key)! : null),
    setItem: (key: string, value: string) => { store.set(key, value); },
    removeItem: (key: string) => { store.delete(key); },
    clear: () => { store.clear(); },
  };
}

// Same stubs `acp-session-chat.test.tsx` registers, for the same reasons —
// see that file's header comment. Must be registered before the first
// `import('./acp-session-chat')` below.
const { mock } = await import('bun:test');
mock.module('@/components/markdown', () => ({ UnifiedMarkdown: () => null }));
mock.module('./header/session-site-header', () => ({ SessionSiteHeader: () => null }));
// The composer now routes through `ComposerChatInput` (Runtime catalog-query /
// model-store wiring); stubbed to `null` so its subtree contributes no render
// cost to the commit budget measured here — same as the old SessionChatInput
// stub it replaces.
import * as actualComposerChatInput from './composer-chat-input';
mock.module('./composer-chat-input', () => ({
  ...actualComposerChatInput,
  ComposerChatInput: () => null,
}));
// `useSessionAudit` (connector-approval lock) calls `useQuery`, which needs a
// `QueryClientProvider` this DOM-free harness has no reason to mount. Only that
// hook is overridden — the module's pure helpers stay real for
// `session-approval-prompt` (imported by `AcpSessionChat`).
import * as actualSessionAudit from './session-audit-shared';
mock.module('./session-audit-shared', () => ({
  ...actualSessionAudit,
  useSessionAudit: () => ({ data: undefined }),
}));
mock.module('./session-context-modal', () => ({ SessionContextModal: () => null }));
// This file — unlike the sibling test files above — replays real `tool`
// chat items (the fixture's 30 tool calls), which route through
// `AcpToolCallCard` -> `tool-renderers.tsx`'s per-kind renderers
// (`BashTool`, etc.), all of which call `next-intl`'s `useTranslations()`
// unconditionally at the top of their render body. There is no
// `NextIntlClientProvider` in this DOM-free harness, so the real hook
// throws synchronously on mount regardless of props — stubbed to an
// identity passthrough (`t(key) === key`), same convention as the other
// framework-context stubs above.
mock.module('next-intl', () => ({
  useTranslations: () => Object.assign((key: string) => key, { raw: (key: string) => key, rich: (key: string) => key, markup: (key: string) => key }),
}));
// `AcpChatItemRow`'s per-row `motion.div` and `AcpQuestionCard`'s
// `AnimatePresence mode="popLayout"` swap animations —
// same rationale `acp-request-cards.test.tsx` documents: under
// `react-test-renderer` there is no real DOM for `motion` to animate
// against, so its internal RAF/timer-driven completion callbacks fire
// asynchronously, OUTSIDE the `act()` that triggered them, producing extra
// Profiler commits that have nothing to do with `AcpSessionChat`'s own
// render cost — pure test-harness noise a real browser mount never
// produces. Swapped for the same deterministic stand-in
// `acp-request-cards.test.tsx` uses (current-children-only, no animation
// machinery). Must be registered before the first `import('./acp-session-chat')`.
mock.module('motion/react', () => {
  const ReactModule = require('react');
  function stripMotionProps(props: Record<string, unknown>) {
    const { initial, animate, exit, transition, layout, layoutId, variants, ...rest } = props;
    return rest;
  }
  // `motion.create(Component)` (`@/components/ui/text-shimmer`'s
  // `TextShimmer`) wraps an arbitrary component, not an intrinsic tag —
  // handled as a special-cased property on the same Proxy, returning a
  // component that renders the wrapped `Component` with motion props
  // stripped, rather than treating `'create'` as an intrinsic tag name
  // (which crashed with "Element type is invalid: ... got: <create />").
  const motionFactory = (Component: unknown) =>
    function MotionCreateStub(props: Record<string, unknown>) {
      return ReactModule.createElement(Component as never, stripMotionProps(props));
    };
  const motion = new Proxy(motionFactory, {
    apply: (target, _thisArg, args) => (target as typeof motionFactory)(args[0]),
    get: (_target, tag: string) => {
      if (tag === 'create') return motionFactory;
      return function MotionStub(props: Record<string, unknown>) {
        return ReactModule.createElement(tag, stripMotionProps(props));
      };
    },
  });
  function AnimatePresence({ children }: { children?: unknown }) {
    return ReactModule.createElement(ReactModule.Fragment, null, children);
  }
  // `@/components/ui/disclosure` (the "Protocol events (n)" collapsible)
  // wraps its tree in `MotionConfig` — a config-only provider with no
  // visual output of its own, so a Fragment pass-through is exact, not an
  // approximation.
  function MotionConfig({ children }: { children?: unknown }) {
    return ReactModule.createElement(ReactModule.Fragment, null, children);
  }
  function useReducedMotion() {
    return false;
  }
  return { motion, AnimatePresence, MotionConfig, useReducedMotion };
});

type AcpProp = Parameters<typeof AcpSessionChatType>[0]['acp'];
type FixtureRow = {
  ordinal: number;
  direction: 'client_to_agent' | 'agent_to_client';
  streamEventId: number | null;
  envelope: Record<string, any>;
  createdAt?: string;
};

const fixture = fixtureRows as FixtureRow[];

/**
 * Adapts a raw `AcpSession` snapshot (`@kortix/sdk/acp`) into the exact
 * hook-shaped `acp` prop `AcpSessionChat` expects — the same shape
 * `useAcpSession` (`packages/sdk/src/react/use-acp-session.ts`) returns.
 * Re-derived by the caller after every manual flush, mirroring what
 * `useSyncExternalStore` would do in production.
 */
function sessionAsHookShape(session: AcpSession): AcpProp {
  const snapshot = session.getSnapshot();
  return {
    ready: snapshot.ready,
    busy: snapshot.busy,
    error: snapshot.error?.message ?? null,
    envelopes: snapshot.envelopes,
    chatItems: snapshot.chatItems,
    pendingPrompts: snapshot.pendingPrompts,
    usage: snapshot.usage,
    configOptions: snapshot.configOptions,
    capabilities: snapshot.capabilities,
    agentInfo: snapshot.agentInfo,
    authMethods: snapshot.authMethods,
    send: (prompt) => session.send(prompt),
    cancel: () => session.cancel(),
    setConfigOption: (configId, value) => session.setConfigOption(configId, value),
    respondPermission: (id, optionId) => session.respondPermission(id, optionId),
    respondQuestion: (id, content) => session.respondQuestion(id, content),
    rejectQuestion: (id) => session.rejectQuestion(id),
    autoApprovePermissions: false,
    setAutoApprovePermissions: () => {},
    acpSessionId: snapshot.acpSessionId,
    connection: snapshot.connection,
    errorInfo: snapshot.error,
    retry: () => session.connect(),
    runtimeSessionId: snapshot.acpSessionId,
  } as AcpProp;
}

/**
 * Builds an injectable `fetch` for a bare-bones ACP bridge: bootstrap
 * (`initialize` -> `session/new`) succeeds immediately with an empty
 * history, and the live SSE connect's GET captures its stream controller
 * on `sse.controller` so `replayFixtureThrough` can push wire-formatted SSE
 * frames (`id: <n>\ndata: <json>\n\n`, the exact grammar `consumeSse`
 * — `packages/sdk/src/acp/client.ts` — parses) whenever it wants to.
 *
 * `session/prompt` and permission/question `respond()` POSTs are answered
 * too, because `replayFixtureThrough` drives those through the SAME public
 * `AcpSession.send()`/`respondPermission()`/`respondQuestion()` methods a
 * real host calls — the live SSE stream can only ever deliver
 * `agent_to_client` rows (both `AcpClient.connect()`'s SSE loop and its
 * poll fallback hard-code that direction), so a `client_to_agent` row
 * (a user prompt, or a permission/question response) can only enter the
 * session's log via bootstrap history or one of these real client calls —
 * never via the live stream. See the module doc comment on
 * `replayFixtureThrough` below.
 */
function makeFixtureFetch() {
  const sse: { controller: ReadableStreamDefaultController<Uint8Array> | null } = { controller: null };
  const encoder = new TextEncoder();
  const fetchImpl = async (
    input: unknown,
    init?: { method?: string; body?: string },
  ): Promise<Response> => {
    const url = String(input);
    const method = init?.method ?? 'GET';

    if (method === 'GET' && url.endsWith('/transcript')) {
      return Response.json({ runtime_id: 'perf-fixture', envelopes: [] });
    }
    if (method === 'GET') {
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          sse.controller = controller;
        },
      });
      return new Response(stream, { status: 200, headers: { 'content-type': 'text/event-stream' } });
    }

    const body = init?.body ? (JSON.parse(init.body) as Record<string, unknown>) : {};
    if (!('method' in body)) {
      // A bare JSON-RPC response envelope — `AcpClient.respond()`
      // (permission/question answers).
      return new Response(null, { status: 202 });
    }
    const respond = (result: unknown) => Response.json({ jsonrpc: '2.0', id: body.id, result });
    switch (body.method) {
      case 'initialize':
        return respond({ protocolVersion: 1, agentCapabilities: {}, authMethods: [], agentInfo: { name: 'perf-fixture-agent' } });
      case 'session/new':
        return respond({ sessionId: 'perf-session', configOptions: [] });
      case 'session/prompt':
        return respond({ stopReason: 'end_turn' });
      default:
        return respond({});
    }
  };
  return { fetchImpl, sse, pushSseFrame: (eventId: number, envelope: unknown) => {
    if (!sse.controller) throw new Error('SSE stream not connected yet');
    sse.controller.enqueue(encoder.encode(`id: ${eventId}\ndata: ${JSON.stringify(envelope)}\n\n`));
  } };
}

async function waitUntil(predicate: () => boolean, { timeout = 5000, interval = 5 } = {}): Promise<void> {
  const deadline = Date.now() + timeout;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('waitUntil: timed out');
    await new Promise((resolve) => setTimeout(resolve, interval));
  }
}

/**
 * Replays `fixture` through `session` in chunks of `flushEvery` rows,
 * mirroring one SSE-batch-per-frame in production:
 *
 * - An `agent_to_client` row is pushed as a wire-formatted SSE frame
 *   through the injected `fetch`'s live stream — the SAME path a real
 *   assistant chunk/tool-call/permission-request arrives through.
 * - A `client_to_agent` `session/prompt` row is replayed via
 *   `session.send()` (the real optimistic-echo path a typed user message
 *   takes) — the live stream cannot deliver it (see `makeFixtureFetch`'s
 *   doc comment).
 * - A `client_to_agent` response row (answers a permission request) is
 *   replayed via `session.respondPermission()` — again the real path a
 *   user's Allow/Reject click takes.
 *
 * After each chunk, the captured `scheduleFlush` callback is invoked
 * manually exactly once — batching every row in the chunk into a single
 * `AcpSession` flush/commit, exactly like a real burst of SSE events
 * collapsing into one snapshot emission (see `AcpSession`'s doc comment,
 * `packages/sdk/src/acp/session.ts`).
 */
async function replayFixtureThrough(
  session: AcpSession,
  push: ReturnType<typeof makeFixtureFetch>['pushSseFrame'],
  getCapturedFlush: () => (() => void) | null,
  onFlush: () => void,
  { flushEvery = 16 }: { flushEvery?: number } = {},
): Promise<void> {
  let nextEventId = 1;
  const openPermissionIds = new Set<string>();

  for (let start = 0; start < fixture.length; start += flushEvery) {
    const batch = fixture.slice(start, start + flushEvery);
    let pushedSse = false;

    for (const row of batch) {
      const envelope = row.envelope;
      if (row.direction === 'client_to_agent' && envelope.method === 'session/prompt') {
        const text = envelope.params?.prompt?.[0]?.text ?? '';
        await session.send([{ type: 'text', text }]);
        continue;
      }
      if (
        row.direction === 'client_to_agent' &&
        'id' in envelope &&
        !('method' in envelope) &&
        ('result' in envelope || 'error' in envelope) &&
        openPermissionIds.has(String(envelope.id))
      ) {
        const optionId = envelope.result?.outcome?.optionId as string | undefined;
        await session.respondPermission(envelope.id, optionId);
        continue;
      }
      // Every other row is `agent_to_client` (assistant/thought chunks,
      // tool_call/tool_call_update, permission requests) — delivered
      // through the live SSE mock, exactly like a real streamed event.
      if (envelope.method === 'session/request_permission' && 'id' in envelope) {
        openPermissionIds.add(String(envelope.id));
      }
      push(nextEventId, envelope);
      nextEventId += 1;
      pushedSse = true;
    }

    if (pushedSse) {
      // Lets `consumeSse`'s pending `reader.read()` resolve and fold this
      // chunk's frames into `pendingEnvelopes` before the manual flush
      // below drains it.
      await new Promise((resolve) => setTimeout(resolve, 0));
    }

    const flush = getCapturedFlush();
    if (flush) {
      flush();
      onFlush();
    }
  }
}

describe('AcpSessionChat — performance proof (Task 19)', () => {
  test('replaying ~2k envelopes stays within the commit budget', async () => {
    const { AcpSessionChat } = await import('./acp-session-chat');
    const { fetchImpl, pushSseFrame, sse } = makeFixtureFetch();

    let capturedFlush: (() => void) | null = null;
    const session = createAcpSession({
      endpoint: 'https://fixture.test/acp',
      fetch: fetchImpl as unknown as typeof fetch,
      scheduleFlush: (flush) => {
        capturedFlush = flush;
      },
    });

    session.connect();
    await waitUntil(() => session.getSnapshot().ready && sse.controller !== null);

    const commits: number[] = [];
    const onRender: ProfilerOnRenderCallback = (_id, _phase, actualDuration) => {
      commits.push(actualDuration);
    };

    let renderer!: ReactTestRenderer;
    act(() => {
      renderer = create(
        <Profiler id="acp" onRender={onRender}>
          <AcpSessionChat acp={sessionAsHookShape(session)} sessionId="s1" sessionTitle="Perf fixture" projectId="perf" />
        </Profiler>,
      );
    });

    try {
      await replayFixtureThrough(
        session,
        pushSseFrame,
        () => capturedFlush,
        () => {
          act(() => {
            renderer.update(
              <Profiler id="acp" onRender={onRender}>
                <AcpSessionChat acp={sessionAsHookShape(session)} sessionId="s1" sessionTitle="Perf fixture" projectId="perf" />
              </Profiler>,
            );
          });
        },
        { flushEvery: 16 },
      );

      // Sanity: the full fixture actually landed (guards against the perf
      // budget passing vacuously because nothing was replayed).
      expect(session.getSnapshot().envelopes.length).toBeGreaterThan(fixture.length - 10);

      expect(commits.length).toBeLessThanOrEqual(Math.ceil(fixture.length / 16) + 20);
      const slow = commits.filter((duration) => duration > 16);
      expect(slow.length).toBe(0);
    } finally {
      act(() => {
        renderer.unmount();
      });
      session.close();
    }
  }, 60_000);
});

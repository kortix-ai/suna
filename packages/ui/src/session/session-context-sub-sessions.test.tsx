import { describe, expect, test } from 'bun:test';
import type { ModelPricingLookup, SessionLogMessage, SessionLogThread } from '@kortix/sdk';
import { NO_METRICS, sumMetrics, threadMetrics } from './session-context-sub-sessions';

const lookup: ModelPricingLookup = () => null;
const producer = { harness: 'pi', harness_version: '1', adapter_version: '1' };
const reply = (id: string, usage: NonNullable<SessionLogMessage['usage']>): SessionLogMessage =>
  ({ message_id: id, role: 'assistant', kind: 'turn', status: 'complete', in_context: true, usage, model: { provider: 'synthetic', model: 'synthetic' }, producer, blocks: [] }) as unknown as SessionLogMessage;
const user = { message_id: 'user', role: 'user', kind: 'turn', status: 'complete', in_context: true, usage: null, producer, blocks: [] } as unknown as SessionLogMessage;
const thread = (messages: SessionLogMessage[]): SessionLogThread =>
  ({ schema: 'kortix.session/2', v: 1, thread_id: 't', parent_thread_id: null, spawned_by: null, agent: null, title: null, created_at: '', messages });

describe('thread metrics (the SDK\'s, for a thread the store may not hold)', () => {
  test('a thread reads through sessionLogThreadMetrics; no thread is zero', () => {
    const m = threadMetrics(thread([user, reply('one', { input: 2, output: 3, reasoning: 4, cache_read: 5, cache_write: 6 }), reply('two', { input: 7, output: 8, reasoning: 9, cache_read: 10, cache_write: 11 })]), lookup);
    expect(m).toEqual({ cost: 0, messages: { all: 3, user: 1, assistant: 2 }, tokens: { input: 9, output: 11, reasoning: 13, cacheRead: 15, cacheWrite: 17 }, context: m.context });
    expect(m.context?.message_id).toBe('two');
    expect(threadMetrics(null, lookup)).toBe(NO_METRICS);
  });

  test('sumMetrics adds every field', () => {
    const a = { ...NO_METRICS, cost: 1, messages: { all: 2, user: 1, assistant: 1 }, tokens: { ...NO_METRICS.tokens, input: 3 } };
    const b = { ...NO_METRICS, cost: 0.5, messages: { all: 1, user: 1, assistant: 0 }, tokens: { ...NO_METRICS.tokens, output: 4 } };
    expect(sumMetrics([a, b])).toEqual({ cost: 1.5, messages: { all: 3, user: 2, assistant: 1 }, tokens: { ...NO_METRICS.tokens, input: 3, output: 4 }, context: null });
    expect(sumMetrics([])).toEqual(NO_METRICS);
  });
});

// ─── the section renders whole-tree totals, whatever is expanded ─────────────

import { IntlTestProvider } from '../test-utils/intl';
import { useSessionStateStore } from '@kortix/sdk/react';
import type { Session } from '@kortix/sdk';
import { act, create } from 'react-test-renderer';
import { SubSessionSection } from './session-context-sub-sessions';

describe('SubSessionSection totals', () => {
  // Synthetic ids. Root → child (its row starts expanded) → grandchild (its
  // caret starts closed) → great-grandchild (behind that caret, not drawn).
  const ROOT = 'ses_sub_root', CHILD = 'ses_sub_child', GRAND = 'ses_sub_grand', GREAT = 'ses_sub_great';
  const reply = (sessionID: string, id: string, input: number) => ({
    info: {
      id, sessionID, role: 'assistant' as const, time: { created: 1_700_000_000_000 }, parentID: 'u',
      modelID: 'm', providerID: 'synthetic', mode: 'build', agent: 'build', path: { cwd: '/', root: '/' },
      cost: 0, tokens: { input, output: 1, reasoning: 0, cache: { read: 0, write: 0 } },
    },
    parts: [],
  });
  const sessions = [
    { id: ROOT, title: 'Root' },
    { id: CHILD, parentID: ROOT, title: 'Child agent' },
    { id: GRAND, parentID: CHILD, title: 'Grandchild agent' },
    { id: GREAT, parentID: GRAND, title: 'Great-grandchild agent' },
  ] as unknown as Session[];

  test('a descendant behind a closed caret is not drawn, and still counts in the combined totals', async () => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    const store = useSessionStateStore.getState();
    store.hydrate(ROOT, [reply(ROOT, 'm_root', 2)] as never);
    store.hydrate(CHILD, [reply(CHILD, 'm_child', 13)] as never);
    store.hydrate(GRAND, [reply(GRAND, 'm_grand', 100)] as never);
    store.hydrate(GREAT, [reply(GREAT, 'm_great', 1000)] as never);
    let renderer: ReturnType<typeof create>;
    await act(async () => {
      renderer = create(
        <IntlTestProvider>
          <SubSessionSection
            source={{ projectId: '', sessionId: '', runtimeSessionId: ROOT }}
            session={sessions[0]}
            allSessions={sessions}
            pricingLookup={() => null}
            fmt={{ number: (v) => (v == null ? '—' : String(v)) }}
          />
        </IntlTestProvider>,
      );
    });
    const text = JSON.stringify(renderer!.toJSON());
    // The great-grandchild row is not drawn (the grandchild's caret is closed) …
    expect(text).toContain('Grandchild agent');
    expect(text).not.toContain('Great-grandchild agent');
    // … but the totals read the whole tree: 4 messages, 2 + 13 + 100 + 1000 input tokens.
    expect(text).toContain('"4"');
    expect(text).toContain('"1115"');
    await act(async () => { renderer!.unmount(); });
  });
});

describe('SubSessionSection loads a sub-agent thread once its row scrolls into view', () => {
  const ROOT = 'ses_lazy_root', CHILD = 'ses_lazy_child', GRAND = 'ses_lazy_grand', GREAT = 'ses_lazy_great';
  const sessions = [
    { id: ROOT, title: 'Root' },
    { id: CHILD, parentID: ROOT, title: 'Child agent' },
    { id: GRAND, parentID: CHILD, title: 'Grandchild agent' },
    { id: GREAT, parentID: GRAND, title: 'Great-grandchild agent' },
  ] as unknown as Session[];

  test('a row reads its saved window only once it is in view, once; a row behind a closed caret reads nothing', async () => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    const { configureKortix } = await import('@kortix/sdk');
    configureKortix({ backendUrl: 'http://test.local/v1', getToken: async () => 'token' });
    const requests: string[] = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (url: unknown) => {
      requests.push(String(url));
      return Response.json({ available: false, reason: 'test', messages: [] });
    }) as unknown as typeof fetch;
    // A fake IntersectionObserver: `show(title)` reports the row with that title in view.
    type Row = { title: string };
    const observers = new Set<{ cb: IntersectionObserverCallback; rows: Set<Row> }>();
    const originalObserver = globalThis.IntersectionObserver;
    globalThis.IntersectionObserver = class {
      private o: { cb: IntersectionObserverCallback; rows: Set<Row> };
      constructor(cb: IntersectionObserverCallback) { observers.add((this.o = { cb, rows: new Set() })); }
      observe(row: Row) { this.o.rows.add(row); }
      disconnect() { observers.delete(this.o); }
    } as unknown as typeof IntersectionObserver;
    const settle = () => act(async () => { await new Promise((r) => setTimeout(r, 20)); });
    const show = async (title: string) => {
      await act(async () => {
        for (const o of [...observers]) for (const row of o.rows) if (row.title === title) o.cb([{ isIntersecting: true, target: row } as never], o as never);
      });
      await settle();
    };
    const loaded = () => [CHILD, GRAND, GREAT].filter((id) => requests.some((url) => url.includes(`child=${id}`)));
    // Each row's button gets a node naming its title (react-test-renderer has no DOM).
    type El = { type: unknown; props: { children?: unknown } };
    const createNodeMock = (el: El) => {
      const spans = Array.isArray(el.props.children) ? (el.props.children as Array<El | null>) : [];
      return { title: String(spans.find((c) => c?.type === 'span')?.props.children ?? '') };
    };
    const tree = (
      <IntlTestProvider>
        <SubSessionSection
          source={{ projectId: 'p_lazy', sessionId: 's_lazy', runtimeSessionId: ROOT }}
          session={sessions[0]}
          allSessions={sessions}
          pricingLookup={() => null}
          fmt={{ number: (v) => (v == null ? '—' : String(v)) }}
        />
      </IntlTestProvider>
    );
    let renderer: ReturnType<typeof create>;
    try {
      await act(async () => { renderer = create(tree, { createNodeMock: createNodeMock as never }); });
      await settle();
      // The child row and the grandchild row are drawn, not yet in view: nothing loads.
      expect(loaded()).toEqual([]);

      await show('Child agent');
      expect(loaded()).toEqual([CHILD]);
      await show('Grandchild agent');
      expect(loaded()).toEqual([CHILD, GRAND]);

      // A re-render of the open modal keeps both loaded and reads nothing again.
      const before = requests.length;
      await act(async () => { renderer!.update(tree); });
      await settle();
      expect(requests.length).toBe(before);

      // Opening the grandchild's caret draws the great-grandchild row; it loads once in view.
      type Node = { children: Array<Node | string> };
      const textOf = (n: Node | string): string => (typeof n === 'string' ? n : n.children.map(textOf).join(''));
      const caret = renderer!.root.findAll((n) => n.type === 'button' && textOf(n as unknown as Node).includes('Grandchild agent'))[0]!;
      await act(async () => { caret.props.onClick(); });
      await settle();
      expect(loaded()).toEqual([CHILD, GRAND]);
      await show('Great-grandchild agent');
      expect(loaded()).toEqual([CHILD, GRAND, GREAT]);
    } finally {
      await act(async () => { renderer!.unmount(); });
      globalThis.fetch = originalFetch;
      globalThis.IntersectionObserver = originalObserver;
    }
  });
});

describe('SubSessionSection with more sub-agents than the row memo holds', () => {
  // 40 loaded sub-agent threads plus a subscribed root reader: past 20 sessions the
  // store's row memo rebuilt the root's rows on every read, the subscribed root
  // re-rendered, and React threw "Maximum update depth exceeded" (the session page
  // showed "Something went wrong" when the context modal opened).
  test('renders and settles after a store change', async () => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    const { useSessionSync } = await import('@kortix/sdk/react');
    const ROOT = 'ses_many_root';
    const reply = (sessionID: string, id: string) => ({
      info: {
        id, sessionID, role: 'assistant' as const, time: { created: 1_700_000_000_000 }, parentID: 'u',
        modelID: 'm', providerID: 'synthetic', mode: 'build', agent: 'build', path: { cwd: '/', root: '/' },
        cost: 0, tokens: { input: 1, output: 1, reasoning: 0, cache: { read: 0, write: 0 } },
      },
      parts: [],
    });
    const ids = Array.from({ length: 40 }, (_, i) => `ses_many_${i}`);
    const sessions = [{ id: ROOT, title: 'Root' }, ...ids.map((id) => ({ id, parentID: ROOT, title: id }))] as unknown as Session[];
    const store = useSessionStateStore.getState();
    store.hydrate(ROOT, [reply(ROOT, 'm_many_root')] as never);
    for (const id of ids) store.hydrate(id, [reply(id, `m_${id}`)] as never);
    function RootReader() {
      useSessionSync(ROOT, { networkEnabled: false, mirror: null });
      return null;
    }
    let renderer: ReturnType<typeof create>;
    await act(async () => {
      renderer = create(
        <IntlTestProvider>
          <RootReader />
          <SubSessionSection
            source={{ projectId: '', sessionId: '', runtimeSessionId: ROOT }}
            session={sessions[0]}
            allSessions={sessions}
            pricingLookup={() => null}
            fmt={{ number: (v) => (v == null ? '—' : String(v)) }}
          />
        </IntlTestProvider>,
      );
    });
    await act(async () => { useSessionStateStore.getState().hydrate(ids[0]!, [reply(ids[0]!, 'm_a'), reply(ids[0]!, 'm_b')] as never); });
    // Combined messages: the root's 1, 39 × 1, and the changed thread's 3 (its first plus 2 more).
    expect(JSON.stringify(renderer!.toJSON())).toContain('"43"');
    await act(async () => { renderer!.unmount(); });
  });
});

describe('SubSessionSection totals while sub-agents load lazily', () => {
  const ROOT = 'ses_all_root', CHILD = 'ses_all_child', GRAND = 'ses_all_grand', GREAT = 'ses_all_great';
  const sessions = [
    { id: ROOT, title: 'Root' },
    { id: CHILD, parentID: ROOT, title: 'Child agent' },
    { id: GRAND, parentID: CHILD, title: 'Grandchild agent' },
    { id: GREAT, parentID: GRAND, title: 'Great-grandchild agent' },
  ] as unknown as Session[];
  const reply = (sessionID: string, id: string, input: number) => ({
    info: {
      id, sessionID, role: 'assistant' as const, time: { created: 1_700_000_000_000 }, parentID: 'u',
      modelID: 'm', providerID: 'synthetic', mode: 'build', agent: 'build', path: { cwd: '/', root: '/' },
      cost: 0, tokens: { input, output: 1, reasoning: 0, cache: { read: 0, write: 0 } },
    },
    parts: [],
  });
  const input: Record<string, number> = { [CHILD]: 13, [GRAND]: 100, [GREAT]: 1000 };

  async function setup(observer: typeof IntersectionObserver | undefined) {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    const { configureKortix } = await import('@kortix/sdk');
    configureKortix({ backendUrl: 'http://test.local/v1', getToken: async () => 'token' });
    useSessionStateStore.getState().hydrate(ROOT, [reply(ROOT, 'm_all_root', 2)] as never);
    const loadedIds: string[] = [];
    const originalFetch = globalThis.fetch;
    const originalObserver = globalThis.IntersectionObserver;
    // A sub-agent's saved-window read lands its thread in the store.
    globalThis.fetch = (async (url: unknown) => {
      const child = /child=([^&]+)/.exec(String(url))?.[1];
      if (child && input[child] !== undefined && !loadedIds.includes(child)) {
        loadedIds.push(child);
        useSessionStateStore.getState().hydrate(child, [reply(child, `m_${child}`, input[child]!)] as never);
      }
      return Response.json({ available: false, reason: 'test', messages: [] });
    }) as unknown as typeof fetch;
    (globalThis as { IntersectionObserver?: typeof IntersectionObserver }).IntersectionObserver = observer;
    let renderer: ReturnType<typeof create>;
    await act(async () => {
      renderer = create(
        <IntlTestProvider>
          <SubSessionSection
            source={{ projectId: 'p_all', sessionId: 's_all', runtimeSessionId: ROOT }}
            session={sessions[0]}
            allSessions={sessions}
            pricingLookup={() => null}
            fmt={{ number: (v) => (v == null ? '—' : String(v)) }}
          />
        </IntlTestProvider>,
        { createNodeMock: () => ({}) },
      );
    });
    await act(async () => { await new Promise((r) => setTimeout(r, 20)); });
    const text = () => JSON.stringify(renderer!.toJSON());
    const cleanup = async () => {
      await act(async () => { renderer!.unmount(); });
      globalThis.fetch = originalFetch;
      globalThis.IntersectionObserver = originalObserver;
      for (const id of [ROOT, CHILD, GRAND, GREAT]) useSessionStateStore.getState().clearSession(id);
    };
    return { renderer: renderer!, text, loadedIds, cleanup };
  }

  test('before any row is in view the totals say they are partial; "Load all" loads every sub-agent and the totals become whole', async () => {
    // An observer that never reports a row in view.
    const quiet = class { observe() {} disconnect() {} } as unknown as typeof IntersectionObserver;
    const { renderer, text, loadedIds, cleanup } = await setup(quiet);
    try {
      expect(text()).toContain('0 of 3 sub-agents loaded');
      expect(loadedIds).toEqual([]);
      // Combined: the root's 2 input tokens only, not the whole tree's 1115.
      expect(text()).not.toContain('"1115"');

      const button = renderer.root.findAll((n) => typeof n.props.onClick === 'function' && n.props.children === 'Load all')[0]!;
      await act(async () => { button.props.onClick(); });
      await act(async () => { await new Promise((r) => setTimeout(r, 20)); });

      // Every sub-agent loaded, the great-grandchild behind a closed caret too.
      expect([...loadedIds].sort()).toEqual([CHILD, GRAND, GREAT].sort());
      expect(text()).not.toContain('sub-agents loaded');
      expect(text()).not.toContain('Load all');
      // 4 messages; 2 + 13 + 100 + 1000 input tokens.
      expect(text()).toContain('"4"');
      expect(text()).toContain('"1115"');
    } finally {
      await cleanup();
    }
  });

  test('a host with no IntersectionObserver loads every drawn row at once', async () => {
    const { text, loadedIds, cleanup } = await setup(undefined);
    try {
      // The child and grandchild rows are drawn; the great-grandchild is behind a closed caret.
      expect([...loadedIds].sort()).toEqual([CHILD, GRAND].sort());
      expect(text()).toContain('2 of 3 sub-agents loaded');
    } finally {
      await cleanup();
    }
  });
});

describe('SubSessionSection with sub-agents the server never saved', () => {
  // A pi session's sub-agents (threads, not child sessions). The saved window answers
  // `available: false` for every one, as for a sub-agent the turn-end capture did not reach;
  // the runtime holds them all, except one it answers 404 for and one whose read fails once
  // (500) and then never answers.
  const ROOT = 'ses_unsaved_root', GONE = 'ses_unsaved_gone', FLAKY = 'ses_unsaved_flaky';
  const kids = Array.from({ length: 24 }, (_, i) => `ses_unsaved_${i}`);
  const sessions = [
    { id: ROOT, title: 'Root' },
    ...[...kids, GONE, FLAKY].map((id) => ({ id, parentID: ROOT, title: `Agent ${id}` })),
  ] as unknown as Session[];
  const message = (sessionID: string, id: string) => ({
    info: { id, sessionID, role: 'user', time: { created: 1_700_000_000_000 } },
    parts: [],
  });

  test('"Load all" reads every row from the runtime; a row that cannot load says so, never "0 messages"', async () => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    const { createKortix } = await import('@kortix/sdk');
    const originalFetch = globalThis.fetch;
    const originalObserver = globalThis.IntersectionObserver;
    const runtimeReads = new Set<string>();
    let flakyReads = 0;
    globalThis.fetch = (async (input: unknown) => {
      const url = input instanceof Request ? input.url : String(input);
      const runtime = /\/session\/(ses_[a-z0-9_]+)\/message/.exec(url)?.[1];
      if (runtime) {
        runtimeReads.add(runtime);
        if (runtime === GONE) return Response.json({ message: 'session not found' }, { status: 404 });
        if (runtime === FLAKY) {
          flakyReads += 1;
          return flakyReads === 1 ? Response.json({ message: 'upstream failed' }, { status: 500 }) : new Promise<Response>(() => {});
        }
        // Every sub-agent has 2 messages; the saved window has none of them.
        return Response.json([message(runtime, `m_${runtime}_a`), message(runtime, `m_${runtime}_b`)]);
      }
      return Response.json({ available: false, complete: false, message_count: 0, reason: 'no server-side transcript has been captured for this session yet' });
    }) as unknown as typeof fetch;
    // No row is ever in view: only "Load all" requests them.
    globalThis.IntersectionObserver = class { observe() {} disconnect() {} } as unknown as typeof IntersectionObserver;
    const kortix = createKortix({ backendUrl: 'http://test.local/v1', getToken: async () => 'token' });
    // The session's running row: the runtime of this session, without a `/start`.
    await kortix.session('p_unsaved', 's_unsaved').ensureReady({
      session: {
        session_id: 's_unsaved', project_id: 'p_unsaved', account_id: 'a', status: 'running',
        sandbox_id: 'sbx_unsaved', sandbox_provider: 'synthetic', sandbox_url: 'http://test.local/v1/p/sbx-unsaved/8000/',
        runtime_session_id: ROOT,
      } as never,
    });
    useSessionStateStore.getState().hydrate(ROOT, [message(ROOT, 'm_root')] as never);
    let renderer: ReturnType<typeof create>;
    const text = () => JSON.stringify(renderer!.toJSON());
    try {
      await act(async () => {
        renderer = create(
          <IntlTestProvider>
            <SubSessionSection
              source={{ projectId: 'p_unsaved', sessionId: 's_unsaved', runtimeSessionId: ROOT }}
              session={sessions[0]}
              allSessions={sessions}
              pricingLookup={() => null}
              fmt={{ number: (v) => (v == null ? '—' : String(v)) }}
            />
          </IntlTestProvider>,
          { createNodeMock: () => ({}) },
        );
      });
      // Nothing loaded yet: no row claims a count.
      expect(text()).toContain('0 of 26 sub-agents loaded');
      expect(text()).not.toContain('"0"," ","messages"');

      const button = renderer!.root.findAll((n) => typeof n.props.onClick === 'function' && n.props.children === 'Load all')[0]!;
      await act(async () => { button.props.onClick(); });
      await act(async () => { await new Promise((r) => setTimeout(r, 100)); });

      // Every requested row went to the runtime, past the registry's 20 controllers.
      expect([...runtimeReads].sort()).toEqual([...kids, GONE, FLAKY].sort());
      // 24 rows show their runtime count; the 404 row and the 500 row say they could not load.
      expect(text().match(/"2"," ","messages"/g)?.length).toBe(24);
      expect(text()).not.toContain('"0"," ","messages"');
      expect(text().match(/Could not load/g)?.length).toBe(2);
      // The label counts loaded threads, not requested ones: 24 of 26.
      expect(text()).toContain('24 of 26 sub-agents loaded');
      expect(text()).not.toContain('Load all');
      // Combined messages: the root's 1 plus 24 × 2.
      expect(text()).toContain('"49"');

      // The 500 row's retry (after 1 s) is in flight: the row still says it could not load.
      await act(async () => { await new Promise((r) => setTimeout(r, 1_300)); });
      expect(flakyReads).toBe(2);
      expect(text().match(/Could not load/g)?.length).toBe(2);
    } finally {
      await act(async () => { renderer!.unmount(); });
      globalThis.fetch = originalFetch;
      globalThis.IntersectionObserver = originalObserver;
      for (const id of [ROOT, GONE, FLAKY, ...kids]) useSessionStateStore.getState().clearSession(id);
    }
  });
});

import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
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

import { IntlTestProvider } from '../../test-utils/intl';
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

// The fake API of the sub-agent suites below. Since #11777 a sub-agent's thread comes only from
// the session's log (`runtime.log.v1`, every box past the runtime floor), never from the box's
// v1 transcript: the first page names every thread, `GET …/log?thread=<id>` answers one.
// `thread(id)` decides that answer: the input tokens of each assistant reply, or an HTTP status.
const GOLDEN = JSON.parse(
  readFileSync(join(import.meta.dir, '../../../../api-contract/src/__tests__/fixtures/session-log/golden21.v2.json'), 'utf8'),
) as { threads: Array<Record<string, unknown> & { messages: Array<Record<string, unknown>> }> } & Record<string, unknown>;
type ThreadAnswer = { inputs: number[] } | { status: number } | 'hang';
function sessionLogApi(sessionId: string, root: string, parents: Record<string, string>, thread: (id: string) => ThreadAnswer) {
  const { threads: [golden], ...session } = structuredClone(GOLDEN);
  const { messages: [, assistant], ...head } = golden!;
  const heads = [root, ...Object.keys(parents)].map((id) => ({ ...head, thread_id: id, parent_thread_id: parents[id] ?? null, title: id }));
  const reads: string[] = [];
  const logReads: string[] = [];
  const fetch = (async (input: unknown) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (!url.pathname.endsWith(`/sessions/${sessionId}/log`)) return Response.json([]);
    const id = url.searchParams.get('thread') ?? root;
    if (url.searchParams.has('thread')) reads.push(id);
    else logReads.push(url.pathname);
    const answer = thread(id);
    if (answer === 'hang') return new Promise<Response>(() => {});
    if ('status' in answer) return Response.json({ error: 'failed' }, { status: answer.status });
    const messages = answer.inputs.map((n, i) => ({ ...assistant, thread_id: id, message_id: `m_${id}_${i}`, seq: i + 1, usage: { input: n, output: 1, cache_read: 0, cache_write: 0 } }));
    return Response.json({ session: { ...session, session_id: sessionId }, generation: 1, threads: heads, thread_id: id, messages, has_more: false });
  }) as unknown as typeof globalThis.fetch;
  return { fetch, reads, logReads };
}

describe('SubSessionSection loads the sub-agent threads once a row scrolls into view', () => {
  const ROOT = 'ses_lazy_root', CHILD = 'ses_lazy_child', GRAND = 'ses_lazy_grand', GREAT = 'ses_lazy_great';
  const sessions = [
    { id: ROOT, title: 'Root' },
    { id: CHILD, parentID: ROOT, title: 'Child agent' },
    { id: GRAND, parentID: CHILD, title: 'Grandchild agent' },
    { id: GREAT, parentID: GRAND, title: 'Great-grandchild agent' },
  ] as unknown as Session[];

  test('nothing is read until a row is in view; then the session log and each sub-agent thread are read once', async () => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    const { createKortix } = await import('@kortix/sdk');
    const api = sessionLogApi('s_lazy', ROOT, { [CHILD]: ROOT, [GRAND]: CHILD, [GREAT]: GRAND }, () => ({ inputs: [1] }));
    const originalFetch = globalThis.fetch;
    globalThis.fetch = api.fetch;
    const kortix = createKortix({ backendUrl: 'http://test.local/v1', getToken: async () => 'token' });
    await kortix.session('p_lazy', 's_lazy').ensureReady({
      session: {
        session_id: 's_lazy', project_id: 'p_lazy', account_id: 'a', status: 'running',
        sandbox_id: 'sbx_lazy', sandbox_provider: 'synthetic', sandbox_url: 'http://test.local/v1/p/sbx-lazy/8000/',
        runtime_session_id: ROOT,
      } as never,
    });
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
      // The child row and the grandchild row are drawn, not yet in view: nothing is read.
      expect(api.logReads).toEqual([]);
      expect(api.reads).toEqual([]);

      // A row in view reads the session's log once; its page names every thread, and each
      // sub-agent thread is read once (the totals read the whole tree, behind a closed caret too).
      await show('Child agent');
      expect(api.logReads.length).toBe(1);
      expect([...api.reads].sort()).toEqual([CHILD, GRAND, GREAT].sort());
      await show('Grandchild agent');

      // A re-render of the open modal, a second row in view and opening a caret read nothing again.
      const before = api.reads.length + api.logReads.length;
      await act(async () => { renderer!.update(tree); });
      await settle();
      type Node = { children: Array<Node | string> };
      const textOf = (n: Node | string): string => (typeof n === 'string' ? n : n.children.map(textOf).join(''));
      const caret = renderer!.root.findAll((n) => n.type === 'button' && textOf(n as unknown as Node).includes('Grandchild agent'))[0]!;
      await act(async () => { caret.props.onClick(); });
      await settle();
      await show('Great-grandchild agent');
      expect(api.reads.length + api.logReads.length).toBe(before);
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
  const input: Record<string, number> = { [ROOT]: 2, [CHILD]: 13, [GRAND]: 100, [GREAT]: 1000 };

  // Each setup is its own session: the store keeps a session's log between tests.
  async function setup(observer: typeof IntersectionObserver | undefined, sessionId: string) {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    const { createKortix } = await import('@kortix/sdk');
    const api = sessionLogApi(sessionId, ROOT, { [CHILD]: ROOT, [GRAND]: CHILD, [GREAT]: GRAND }, (id) => ({ inputs: [input[id]!] }));
    const originalFetch = globalThis.fetch;
    const originalObserver = globalThis.IntersectionObserver;
    globalThis.fetch = api.fetch;
    const kortix = createKortix({ backendUrl: 'http://test.local/v1', getToken: async () => 'token' });
    await kortix.session('p_all', sessionId).ensureReady({
      session: {
        session_id: sessionId, project_id: 'p_all', account_id: 'a', status: 'running',
        sandbox_id: 'sbx_all', sandbox_provider: 'synthetic', sandbox_url: 'http://test.local/v1/p/sbx-all/8000/',
        runtime_session_id: ROOT,
      } as never,
    });
    (globalThis as { IntersectionObserver?: typeof IntersectionObserver }).IntersectionObserver = observer;
    let renderer: ReturnType<typeof create>;
    await act(async () => {
      renderer = create(
        <IntlTestProvider>
          <SubSessionSection
            source={{ projectId: 'p_all', sessionId, runtimeSessionId: ROOT }}
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
    };
    return { renderer: renderer!, text, reads: api.reads, cleanup };
  }

  test('before any row is in view the totals say they are partial; "Load all" loads every sub-agent and the totals become whole', async () => {
    // An observer that never reports a row in view.
    const quiet = class { observe() {} disconnect() {} } as unknown as typeof IntersectionObserver;
    const { renderer, text, reads, cleanup } = await setup(quiet, 's_all_quiet');
    try {
      expect(text()).toContain('0 of 3 sub-agents loaded');
      expect(reads).toEqual([]);
      // Not the whole tree's 1115 input tokens.
      expect(text()).not.toContain('"1115"');

      const button = renderer.root.findAll((n) => typeof n.props.onClick === 'function' && n.props.children === 'Load all')[0]!;
      await act(async () => { button.props.onClick(); });
      await act(async () => { await new Promise((r) => setTimeout(r, 20)); });

      // Every sub-agent loaded, the great-grandchild behind a closed caret too.
      expect([...reads].sort()).toEqual([CHILD, GRAND, GREAT].sort());
      expect(text()).not.toContain('sub-agents loaded');
      expect(text()).not.toContain('Load all');
      // 4 messages; 2 + 13 + 100 + 1000 input tokens.
      expect(text()).toContain('"4"');
      expect(text()).toContain('"1115"');
    } finally {
      await cleanup();
    }
  });

  test('a host with no IntersectionObserver loads at once', async () => {
    const { text, reads, cleanup } = await setup(undefined, 's_all_eager');
    try {
      // The drawn rows count as seen at mount: the log is read and every thread lands.
      expect([...reads].sort()).toEqual([CHILD, GRAND, GREAT].sort());
      expect(text()).not.toContain('sub-agents loaded');
      expect(text()).toContain('"1115"');
    } finally {
      await cleanup();
    }
  });
});

describe('SubSessionSection with many sub-agents, some of which cannot load', () => {
  // A pi session's sub-agents (threads). The log answers every thread, except one it
  // answers 404 for and one whose read fails (500) and then never answers.
  const ROOT = 'ses_unsaved_root', GONE = 'ses_unsaved_gone', FLAKY = 'ses_unsaved_flaky';
  const kids = Array.from({ length: 24 }, (_, i) => `ses_unsaved_${i}`);
  const sessions = [
    { id: ROOT, title: 'Root' },
    ...[...kids, GONE, FLAKY].map((id) => ({ id, parentID: ROOT, title: `Agent ${id}` })),
  ] as unknown as Session[];

  test('"Load all" reads every row\'s thread; a row that cannot load never says "0 messages"', async () => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    const { createKortix } = await import('@kortix/sdk');
    const originalFetch = globalThis.fetch;
    const originalObserver = globalThis.IntersectionObserver;
    let flakyReads = 0;
    const api = sessionLogApi('s_unsaved', ROOT, Object.fromEntries([...kids, GONE, FLAKY].map((id) => [id, ROOT])), (id) => {
      if (id === GONE) return { status: 404 };
      if (id === FLAKY) return ++flakyReads === 1 ? { status: 500 } : 'hang';
      // The root has 1 message, every sub-agent 2.
      return { inputs: id === ROOT ? [1] : [1, 1] };
    });
    globalThis.fetch = api.fetch;
    // No row is ever in view: only "Load all" requests them.
    globalThis.IntersectionObserver = class { observe() {} disconnect() {} } as unknown as typeof IntersectionObserver;
    const kortix = createKortix({ backendUrl: 'http://test.local/v1', getToken: async () => 'token' });
    await kortix.session('p_unsaved', 's_unsaved').ensureReady({
      session: {
        session_id: 's_unsaved', project_id: 'p_unsaved', account_id: 'a', status: 'running',
        sandbox_id: 'sbx_unsaved', sandbox_provider: 'synthetic', sandbox_url: 'http://test.local/v1/p/sbx-unsaved/8000/',
        runtime_session_id: ROOT,
      } as never,
    });
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

      // Every row's thread was read, past the 20 the old per-row controllers held.
      expect([...new Set(api.reads)].sort()).toEqual([...kids, GONE, FLAKY].sort());
      // 24 rows show their count; the 404 row and the 500 row claim none.
      expect(text().match(/"2"," ","messages"/g)?.length).toBe(24);
      expect(text()).not.toContain('"0"," ","messages"');
      // The label counts loaded threads, not requested ones: 24 of 26.
      expect(text()).toContain('24 of 26 sub-agents loaded');
      expect(text()).not.toContain('Load all');
      // Combined messages: the root's 1 plus 24 × 2.
      expect(text()).toContain('"49"');
    } finally {
      await act(async () => { renderer!.unmount(); });
      globalThis.fetch = originalFetch;
      globalThis.IntersectionObserver = originalObserver;
    }
  });
});

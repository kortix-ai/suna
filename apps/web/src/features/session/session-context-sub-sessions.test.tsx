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

import { NextIntlClientProvider } from '@/i18n/use-translations';
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
        <NextIntlClientProvider locale="en" messages={{}} onError={() => {}}>
          <SubSessionSection
            source={{ projectId: '', sessionId: '', runtimeSessionId: ROOT }}
            session={sessions[0]}
            allSessions={sessions}
            pricingLookup={() => null}
            fmt={{ number: (v) => (v == null ? '—' : String(v)) }}
          />
        </NextIntlClientProvider>,
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

describe('SubSessionSection loads a sub-agent thread when its row is shown', () => {
  const ROOT = 'ses_lazy_root', CHILD = 'ses_lazy_child', GRAND = 'ses_lazy_grand', GREAT = 'ses_lazy_great';
  const sessions = [
    { id: ROOT, title: 'Root' },
    { id: CHILD, parentID: ROOT, title: 'Child agent' },
    { id: GRAND, parentID: CHILD, title: 'Grandchild agent' },
    { id: GREAT, parentID: GRAND, title: 'Great-grandchild agent' },
  ] as unknown as Session[];

  test('a shown row reads its saved window; a row behind a closed caret reads nothing until it opens', async () => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    const { configureKortix } = await import('@kortix/sdk');
    configureKortix({ backendUrl: 'http://test.local/v1', getToken: async () => 'token' });
    const requests: string[] = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (url: unknown) => {
      requests.push(String(url));
      return Response.json({ available: false, reason: 'test', messages: [] });
    }) as unknown as typeof fetch;
    const children = () => [CHILD, GRAND, GREAT].filter((id) => requests.some((url) => url.includes(`child=${id}`)));
    let renderer: ReturnType<typeof create>;
    try {
      await act(async () => {
        renderer = create(
          <NextIntlClientProvider locale="en" messages={{}} onError={() => {}}>
            <SubSessionSection
              source={{ projectId: 'p_lazy', sessionId: 's_lazy', runtimeSessionId: ROOT }}
              session={sessions[0]}
              allSessions={sessions}
              pricingLookup={() => null}
              fmt={{ number: (v) => (v == null ? '—' : String(v)) }}
            />
          </NextIntlClientProvider>,
        );
      });
      await act(async () => { await new Promise((r) => setTimeout(r, 20)); });
      // The child row and the grandchild row are drawn; the great-grandchild is behind a closed caret.
      expect(children()).toEqual([CHILD, GRAND]);

      type Node = { children: Array<Node | string> };
      const textOf = (n: Node | string): string => (typeof n === 'string' ? n : n.children.map(textOf).join(''));
      const caret = renderer!.root.findAll((n) => n.type === 'button' && textOf(n as unknown as Node).includes('Grandchild agent'))[0]!;
      await act(async () => { caret.props.onClick(); });
      await act(async () => { await new Promise((r) => setTimeout(r, 20)); });
      expect(children()).toEqual([CHILD, GRAND, GREAT]);
    } finally {
      await act(async () => { renderer!.unmount(); });
      globalThis.fetch = originalFetch;
    }
  });
});

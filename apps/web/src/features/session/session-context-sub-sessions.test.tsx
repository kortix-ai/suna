import { describe, expect, test } from 'bun:test';
import type { ModelPricingLookup, SessionLogMessage } from '@kortix/sdk';
import { NO_METRICS, sumMetrics, threadMetrics } from './session-context-sub-sessions';

const lookup: ModelPricingLookup = () => null;
const reply = (id: string, usage: NonNullable<SessionLogMessage['usage']>): SessionLogMessage =>
  ({ message_id: id, role: 'assistant', kind: 'turn', status: 'complete', in_context: true, usage, model: { provider: 'synthetic', model: 'synthetic' }, blocks: [] }) as unknown as SessionLogMessage;
const user = { message_id: 'user', role: 'user', kind: 'turn', status: 'complete', in_context: true, usage: null, blocks: [] } as unknown as SessionLogMessage;

describe('thread metrics', () => {
  test('counts every reply\'s tokens (cumulative, not just the last) and every message', () => {
    const metrics = threadMetrics(
      [
        reply('one', { input: 2, output: 3, reasoning: 4, cache_read: 5, cache_write: 6 }),
        reply('two', { input: 7, output: 8, reasoning: 9, cache_read: 10, cache_write: 11 }),
        user,
      ],
      lookup,
    );
    expect(metrics).toEqual({
      cost: 0, messages: 3,
      inputTokens: 9, outputTokens: 11, reasoningTokens: 13, cacheReadTokens: 15, cacheWriteTokens: 17,
    });
  });

  test('a reported cost is billed at the markup; an empty thread is zero', () => {
    const metrics = threadMetrics([reply('one', { input: 1, output: 1, cache_read: 0, cache_write: 0, cost: 0.5 })], lookup);
    expect(metrics.cost).toBeCloseTo(0.6, 9);
    expect(threadMetrics([], lookup)).toEqual(NO_METRICS);
  });

  test('sumMetrics adds every field', () => {
    const a = { ...NO_METRICS, cost: 1, messages: 2, inputTokens: 3 };
    const b = { ...NO_METRICS, cost: 0.5, messages: 1, outputTokens: 4 };
    expect(sumMetrics([a, b])).toEqual({ ...NO_METRICS, cost: 1.5, messages: 3, inputTokens: 3, outputTokens: 4 });
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

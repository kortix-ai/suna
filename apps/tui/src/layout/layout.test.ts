import { describe, expect, test } from 'bun:test';

import { contextReading } from '../lib/context-usage.ts';
import { tabLabel, visibleTabs } from './tabs-bar.tsx';

describe('session tabs', () => {
  test('all tabs show when they fit', () => {
    expect(visibleTabs(3, 1, 20, 120)).toEqual({ start: 0, end: 3 });
  });

  test('the window keeps the active tab on screen', () => {
    const window = visibleTabs(20, 15, 20, 84);
    expect(window.end - window.start).toBe(4);
    expect(window.start <= 15 && 15 < window.end).toBe(true);
  });

  test('a label is numbered, clipped and padded to the tab width', () => {
    // One trailing column stays blank: it separates the tabs.
    expect(tabLabel(0, 'Fix the login bug in the auth flow', 14)).toBe(' 1 Fix the l… ');
    expect(tabLabel(2, 'Hi', 8)).toBe(' 3 Hi   ');
  });
});

describe('info panel context', () => {
  let seq = 0;
  const reply = (input: number, output: number, cacheRead = 0) => {
    seq += 1;
    return {
      message_id: `m${seq}`,
      thread_id: 'main',
      seq,
      role: 'assistant',
      kind: 'turn',
      status: 'complete',
      in_context: true,
      producer: { harness: 'pi' },
      created_at: '2026-10-30T00:00:00.000Z',
      usage: { input, output, reasoning: 5, cache_read: cacheRead, cache_write: 0 },
      blocks: [],
    };
  };

  test('counts the last reply with usage, reasoning not added twice', () => {
    const thread = { messages: [reply(100, 50), reply(1000, 200, 300)] } as never;
    expect(contextReading(thread, 10_000)).toEqual({ tokens: 1500, limit: 10_000, percent: 15 });
  });

  test('no window known: tokens without a percentage', () => {
    expect(contextReading({ messages: [reply(10, 10)] } as never, null).percent).toBeNull();
    expect(contextReading(null, 1000).tokens).toBe(0);
  });
});

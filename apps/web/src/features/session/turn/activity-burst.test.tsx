import type { Part, ToolPart } from '@/ui';
import { describe, expect, test } from 'bun:test';
import { burstFailureCount, burstIsRunning, showsClosingStep } from './activity-burst';

function tool(id: string, name: string, state: Record<string, unknown>): ToolPart {
  return {
    id,
    type: 'tool',
    tool: name,
    callID: `call_${id}`,
    state,
  } as unknown as ToolPart;
}

describe('burstIsRunning', () => {
  test('a completed non-trailing burst is not running even while the turn works', () => {
    // Burst already closed by later text/standalone — collapse it.
    const parts: Part[] = [tool('1', 'read', { status: 'completed', time: { start: 1, end: 2 } })];
    expect(burstIsRunning(parts, true, false)).toBe(false);
  });

  test('a completed trailing burst stays running while the turn works', () => {
    // Gap between SSE tool parts: every part settled, next call not arrived yet.
    // Without this the disclosure blinks shut between every pair of calls.
    const parts: Part[] = [
      tool('1', 'read', { status: 'completed', time: { start: 1, end: 2 } }),
      tool('2', 'bash', { status: 'completed', time: { start: 3, end: 4 } }),
    ];
    expect(burstIsRunning(parts, true, true)).toBe(true);
  });

  test('a trailing burst collapses once the turn stops working', () => {
    const parts: Part[] = [tool('1', 'read', { status: 'completed', time: { start: 1, end: 2 } })];
    expect(burstIsRunning(parts, false, true)).toBe(false);
  });

  test('a pending part while the turn works is running', () => {
    const parts: Part[] = [tool('1', 'bash', { status: 'pending' })];
    expect(burstIsRunning(parts, true)).toBe(true);
  });

  test('a running part while the turn works is running', () => {
    const parts: Part[] = [tool('1', 'bash', { status: 'running' })];
    expect(burstIsRunning(parts, true)).toBe(true);
  });

  test('nothing is running once the turn has stopped working', () => {
    const parts: Part[] = [tool('1', 'bash', { status: 'running' })];
    expect(burstIsRunning(parts, false)).toBe(false);
  });

  test('a reasoning part with no end time counts as running', () => {
    const parts: Part[] = [
      { id: 'r', type: 'reasoning', text: 'thinking', time: { start: 1 } } as unknown as Part,
    ];
    expect(burstIsRunning(parts, true)).toBe(true);
  });

  test('a reasoning part with an end time does not when the burst is not trailing', () => {
    const parts: Part[] = [
      { id: 'r', type: 'reasoning', text: 'done', time: { start: 1, end: 2 } } as unknown as Part,
    ];
    expect(burstIsRunning(parts, true, false)).toBe(false);
  });
});

describe('showsClosingStep', () => {
  test('a settled chain with steps gets a cap', () => {
    expect(showsClosingStep(1, false)).toBe(true);
    expect(showsClosingStep(9, false)).toBe(true);
  });

  test('a running chain is never capped — the open end means work continues', () => {
    expect(showsClosingStep(3, true)).toBe(false);
  });

  test('an empty chain is never capped — a cap alone terminates nothing', () => {
    // Every part was plumbing, so mergeBurstSteps returned no rows.
    expect(showsClosingStep(0, false)).toBe(false);
    expect(showsClosingStep(0, true)).toBe(false);
  });
});

describe('burstFailureCount', () => {
  const SCRAPE_PARTIAL = JSON.stringify({
    total: 3,
    successful: 2,
    failed: 1,
    results: [
      { url: 'https://a.test', success: true, content: 'ok' },
      { url: 'https://b.test', success: true, content: 'ok' },
      { url: 'https://example.invalid', success: false, error: 'ENOTFOUND' },
    ],
  });

  test('a clean burst has no failures', () => {
    const parts: Part[] = [
      tool('1', 'read', {
        status: 'completed',
        output: 'file contents',
        time: { start: 1, end: 2 },
      }),
    ];
    expect(burstFailureCount(parts)).toBe(0);
  });

  test('counts a thrown call', () => {
    const parts: Part[] = [tool('1', 'bash', { status: 'error', error: 'Error: boom' })];
    expect(burstFailureCount(parts)).toBe(1);
  });

  test('counts a call that RETURNED its error — the case the cap used to call Done', () => {
    const parts: Part[] = [
      tool('1', 'scrape_webpage', {
        status: 'completed',
        output: 'Error: DNS lookup failed for example.invalid (ENOTFOUND).',
        time: { start: 1, end: 2 },
      }),
    ];
    expect(burstFailureCount(parts)).toBe(1);
  });

  test('counts a batch where one of three URLs died', () => {
    const parts: Part[] = [
      tool('1', 'scrape_webpage', {
        status: 'completed',
        output: SCRAPE_PARTIAL,
        time: { start: 1, end: 2 },
      }),
    ];
    expect(burstFailureCount(parts)).toBe(1);
  });

  test('a reasoning part has no verdict and is never counted', () => {
    const parts: Part[] = [
      {
        id: 'r',
        type: 'reasoning',
        text: 'thinking',
        time: { start: 1, end: 2 },
      } as unknown as Part,
    ];
    expect(burstFailureCount(parts)).toBe(0);
  });

  test('an in-flight call is not a failure yet', () => {
    const parts: Part[] = [tool('1', 'bash', { status: 'running' })];
    expect(burstFailureCount(parts)).toBe(0);
  });
});

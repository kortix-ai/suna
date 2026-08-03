import type { Part, ToolPart } from '@/ui';
import { describe, expect, test } from 'bun:test';
import { burstIsRunning, showsDoneStep } from './activity-burst';

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

describe('showsDoneStep', () => {
  test('a settled chain with steps closes on Done', () => {
    expect(showsDoneStep(1, false)).toBe(true);
    expect(showsDoneStep(9, false)).toBe(true);
  });

  test('a running chain is never capped — the open end means work continues', () => {
    expect(showsDoneStep(3, true)).toBe(false);
  });

  test('an empty chain is never capped — Done alone terminates nothing', () => {
    // Every part was plumbing, so mergeBurstSteps returned no rows.
    expect(showsDoneStep(0, false)).toBe(false);
    expect(showsDoneStep(0, true)).toBe(false);
  });
});
